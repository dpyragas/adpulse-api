import { generateObject } from 'ai';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { getModel } from '../lib/ai.js';
import { logger } from '../lib/logger.js';
import { sendCompareProgress, sendCompareComplete, sendError } from './sse.service.js';
import { refundQuota } from './quota.service.js';

// ── Types ──

export type Confidence = 'high' | 'medium' | 'low';

export interface RankingEntry {
  analysisId: string;
  rank: number;
  overallScore: number;
}

export interface WinnerResult {
  winnerId: string;
  confidence: Confidence;
  rankings: RankingEntry[];
}

export interface SubScoreDeltas {
  attention: number;
  branding: number;
  message: number;
  aesthetic: number;
}

export interface ElementDelta {
  type: string;
  attentionDelta: number;
}

export interface VariantDelta {
  analysisId: string;
  overallDelta: number;
  subScoreDeltas: SubScoreDeltas;
  elementDeltas: ElementDelta[];
}

interface AnalysisForWinner {
  id: string;
  results: Record<string, unknown> | null;
}

// ── Helper: extract scoring safely ──

function extractScoring(results: Record<string, unknown> | null) {
  const scoring = results?.scoring as Record<string, unknown> | undefined;
  return {
    overall: typeof scoring?.overall === 'number' ? scoring.overall : 0,
    subScores: scoring?.subScores as Record<string, number> | undefined,
    elements: scoring?.elements as Array<{ type: string; found: boolean; attentionPercent: number }> | undefined,
  };
}

// ── Winner Algorithm ──

export function computeWinnerResult(analyses: AnalysisForWinner[]): WinnerResult {
  const scored = analyses.map((a) => ({
    analysisId: a.id,
    overallScore: extractScoring(a.results).overall,
  }));

  scored.sort((a, b) => b.overallScore - a.overallScore);

  const rankings: RankingEntry[] = scored.map((s, i) => ({
    analysisId: s.analysisId,
    rank: i + 1,
    overallScore: s.overallScore,
  }));

  const gap = scored.length >= 2 ? scored[0].overallScore - scored[1].overallScore : 0;
  let confidence: Confidence;
  if (gap > 1.5) confidence = 'high';
  else if (gap >= 0.5) confidence = 'medium';
  else confidence = 'low';

  return {
    winnerId: scored[0].analysisId,
    confidence,
    rankings,
  };
}

// ── Delta Computation ──

export function computeDeltas(
  winnerId: string,
  analyses: AnalysisForWinner[],
): VariantDelta[] {
  const winner = analyses.find((a) => a.id === winnerId);
  if (!winner) {
    logger.warn('computeDeltas called with winnerId not in analyses', { winnerId });
    return [];
  }

  const winnerScoring = extractScoring(winner.results);
  const winnerElements = winnerScoring.elements ?? [];
  const winnerSubScores = winnerScoring.subScores ?? { attention: 0, branding: 0, message: 0, aesthetic: 0 };

  return analyses
    .filter((a) => a.id !== winnerId)
    .map((a) => {
      const scoring = extractScoring(a.results);
      const variantSubScores = scoring.subScores ?? { attention: 0, branding: 0, message: 0, aesthetic: 0 };
      const variantElements = scoring.elements ?? [];

      const subScoreDeltas: SubScoreDeltas = {
        attention: +(winnerSubScores.attention - (variantSubScores.attention ?? 0)).toFixed(1),
        branding: +(winnerSubScores.branding - (variantSubScores.branding ?? 0)).toFixed(1),
        message: +(winnerSubScores.message - (variantSubScores.message ?? 0)).toFixed(1),
        aesthetic: +(winnerSubScores.aesthetic - (variantSubScores.aesthetic ?? 0)).toFixed(1),
      };

      // Build element deltas for all element types present in winner
      const elementTypes = ['cta', 'headline', 'branding', 'product', 'body_text'];
      const elementDeltas: ElementDelta[] = elementTypes
        .map((type) => {
          const winnerEl = winnerElements.find((e) => e.type === type);
          const variantEl = variantElements.find((e) => e.type === type);
          const winnerAttn = winnerEl?.found ? winnerEl.attentionPercent : 0;
          const variantAttn = variantEl?.found ? variantEl.attentionPercent : 0;
          return { type, attentionDelta: +(winnerAttn - variantAttn).toFixed(1) };
        })
        .filter((d) => d.attentionDelta !== 0);

      return {
        analysisId: a.id,
        overallDelta: +(winnerScoring.overall - scoring.overall).toFixed(1),
        subScoreDeltas,
        elementDeltas,
      };
    });
}

// ── AI Winner Explanation ──

const WinnerExplanationSchema = z.object({
  explanation: z.string().describe('2-3 sentence explanation of why the winner performs best, written for a non-technical advertiser'),
  keyAdvantages: z.array(z.string()).min(1).max(3).describe('1-3 specific advantages the winning variant has'),
});

export async function generateWinnerExplanation(
  winnerResult: WinnerResult,
  deltas: VariantDelta[],
  winnerScoring: { overall: number; subScores: Record<string, number> },
  platform: string,
): Promise<{ explanation: string; keyAdvantages: string[] } | null> {
  try {
    if (!process.env.OPENAI_API_KEY) {
      logger.warn('OPENAI_API_KEY not configured, skipping winner explanation');
      return null;
    }

    const runnerUps = winnerResult.rankings
      .filter((r) => r.rank > 1)
      .map((r) => `Variant ${r.rank}: ${r.overallScore}/10`)
      .join(', ');

    const deltaSummary = deltas.map((d) => {
      const subScoreParts = Object.entries(d.subScoreDeltas)
        .filter(([, v]) => v !== 0)
        .map(([k, v]) => `${k}: ${v > 0 ? '+' : ''}${v}`)
        .join(', ');
      const elementParts = d.elementDeltas
        .map((e) => `${e.type}: ${e.attentionDelta > 0 ? '+' : ''}${e.attentionDelta}%`)
        .join(', ');
      const elementLine = elementParts ? `\n  Element attention: ${elementParts}` : '';
      return `vs Variant (${d.overallDelta} gap): ${subScoreParts}${elementLine}`;
    }).join('\n');

    const prompt = `Compare Analysis Results (Platform: ${platform}):

Winner: ${winnerScoring.overall}/10 overall
Sub-scores: Attention ${winnerScoring.subScores.attention}, Branding ${winnerScoring.subScores.branding}, Message ${winnerScoring.subScores.message}, Aesthetic ${winnerScoring.subScores.aesthetic}
Confidence: ${winnerResult.confidence} (${winnerResult.confidence === 'high' ? '>1.5 gap' : winnerResult.confidence === 'medium' ? '0.5-1.5 gap' : '<0.5 gap'})

Runner-ups: ${runnerUps}

Score Deltas (winner minus each variant):
${deltaSummary}

Write a concise explanation of why the winner performs best. Reference specific sub-score advantages and element attention differences. Write for a non-technical advertiser, not a data scientist. Ground everything in the data — never speculate.`;

    const { object } = await generateObject({
      model: getModel(),
      schema: WinnerExplanationSchema,
      prompt,
    });

    return object;
  } catch (error) {
    logger.warn('Winner explanation generation failed, degrading gracefully', { error: String(error) });
    return null;
  }
}

// ── Compare Completion Check ──

export async function checkCompareCompletion(compareJobId: string): Promise<void> {
  let outcome = 'skipped' as string;
  let winnerId: string | null = null;
  let failedIds: string[] = [];
  let completedAnalyses: AnalysisForWinner[] = [];
  let platform = '';
  let cachedWinnerResult: ReturnType<typeof computeWinnerResult> | null = null;
  let cachedDeltas: VariantDelta[] = [];

  // Use a transaction to prevent race conditions when multiple analyses complete simultaneously
  await prisma.$transaction(async (tx) => {
    // Re-check compare job status inside transaction to avoid double-processing
    const compareJob = await tx.compareJob.findUnique({
      where: { id: compareJobId },
      select: { status: true, platform: true },
    });

    if (!compareJob || compareJob.status !== 'PROCESSING') {
      return; // Already resolved by a concurrent call
    }

    platform = compareJob.platform;

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
      const castAnalyses = completed.map((a) => ({
        id: a.id,
        results: a.results as Record<string, unknown> | null,
      }));

      cachedWinnerResult = computeWinnerResult(castAnalyses);
      winnerId = cachedWinnerResult.winnerId;

      cachedDeltas = computeDeltas(winnerId, castAnalyses);

      // Store winner + deltas immediately (AI explanation added after transaction)
      const resultsJson = JSON.parse(JSON.stringify({
        winnerId: cachedWinnerResult.winnerId,
        confidence: cachedWinnerResult.confidence,
        rankings: cachedWinnerResult.rankings,
        deltas: cachedDeltas,
        explanation: null,
        keyAdvantages: null,
      }));

      await tx.compareJob.update({
        where: { id: compareJobId },
        data: { status: 'COMPLETED', winnerId, results: resultsJson },
      });

      completedAnalyses = castAnalyses;
      logger.info('CompareJob completed', { compareJobId, winnerId, confidence: cachedWinnerResult.confidence });
      outcome = 'completed';
      return;
    }

    // Still in progress
    try {
      sendCompareProgress(compareJobId, completed.length, total);
    } catch { /* non-fatal */ }
    outcome = 'in-progress';
  });

  // After transaction commits, send SSE, generate AI explanation, and process refunds
  if (outcome === 'completed') {
    // Generate AI explanation outside transaction (non-blocking for the DB)
    try {
      const winnerAnalysis = completedAnalyses.find((a) => a.id === winnerId);
      if (winnerAnalysis && cachedWinnerResult) {
        const winnerScoring = extractScoring(winnerAnalysis.results);

        const aiResult = await generateWinnerExplanation(
          cachedWinnerResult,
          cachedDeltas,
          {
            overall: winnerScoring.overall,
            subScores: (winnerScoring.subScores as Record<string, number>) ?? { attention: 0, branding: 0, message: 0, aesthetic: 0 },
          },
          platform,
        );

        if (aiResult) {
          // Update results with AI explanation
          const existing = await prisma.compareJob.findUnique({
            where: { id: compareJobId },
            select: { results: true },
          });
          const currentResults = (existing?.results as Record<string, unknown>) ?? {};
          await prisma.compareJob.update({
            where: { id: compareJobId },
            data: {
              results: {
                ...currentResults,
                explanation: aiResult.explanation,
                keyAdvantages: aiResult.keyAdvantages,
              },
            },
          });
        }
      }
    } catch (err) {
      logger.warn('AI explanation for compare failed', { compareJobId, error: String(err) });
    }

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
