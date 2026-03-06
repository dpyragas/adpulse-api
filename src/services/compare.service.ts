import { prisma } from '../lib/prisma.js';
import { logger } from '../lib/logger.js';
import { sendCompareProgress, sendCompareComplete, sendError } from './sse.service.js';
import { refundQuota } from './quota.service.js';

export async function checkCompareCompletion(compareJobId: string): Promise<void> {
  let outcome: 'completed' | 'failed' | 'in-progress' | 'skipped' = 'skipped';
  let winnerId: string | null = null;
  let failedIds: string[] = [];

  // Use a transaction to prevent race conditions when multiple analyses complete simultaneously
  await prisma.$transaction(async (tx) => {
    // Re-check compare job status inside transaction to avoid double-processing
    const compareJob = await tx.compareJob.findUnique({
      where: { id: compareJobId },
      select: { status: true },
    });

    if (!compareJob || compareJob.status !== 'PROCESSING') {
      return; // Already resolved by a concurrent call
    }

    const analyses = await tx.analysis.findMany({
      where: { compareJobId },
      select: { id: true, status: true, results: true },
    });

    const total = analyses.length;
    const completed = analyses.filter((a) => a.status === 'COMPLETED');
    const failed = analyses.filter((a) => a.status === 'FAILED');

    if (failed.length > 0) {
      await tx.compareJob.update({
        where: { id: compareJobId },
        data: { status: 'FAILED' },
      });
      failedIds = failed.map((a) => a.id);
      outcome = 'failed';
      return;
    }

    if (completed.length === total) {
      // Determine winner — highest overall score
      let maxScore = -1;

      for (const a of completed) {
        const results = a.results as Record<string, unknown> | null;
        const scoring = results?.scoring as Record<string, unknown> | undefined;
        const overall = typeof scoring?.overall === 'number' ? scoring.overall : -1;
        if (overall > maxScore) {
          maxScore = overall;
          winnerId = a.id;
        }
      }

      await tx.compareJob.update({
        where: { id: compareJobId },
        data: { status: 'COMPLETED', winnerId },
      });

      logger.info('CompareJob completed', { compareJobId, winnerId });
      outcome = 'completed';
      return;
    }

    // Still in progress
    try {
      sendCompareProgress(compareJobId, completed.length, total);
    } catch { /* non-fatal */ }
    outcome = 'in-progress';
  });

  // After transaction commits, send SSE and process refunds
  if (outcome === 'completed') {
    try { sendCompareComplete(compareJobId, winnerId); } catch { /* non-fatal */ }
  } else if (outcome === 'failed') {
    try { sendError(compareJobId, 'COMPARE_FAILED', 'One or more analyses failed'); } catch { /* non-fatal */ }
    // Process refunds outside the main transaction
    for (const id of failedIds) {
      try {
        await refundQuota(id);
      } catch (err) {
        logger.warn('Compare refund failed for analysis', { compareJobId, analysisId: id, error: String(err) });
      }
    }
  }
}
