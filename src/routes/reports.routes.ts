import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth.js';
import { prisma } from '../lib/prisma.js';
import { AppError } from '../lib/app-error.js';
import { downloadImage, resolveS3Url } from '../services/s3.service.js';
import { generateAnalysisReport } from '../services/pdf.service.js';
import type { AnalysisForReport } from '../services/pdf.service.js';
import { logger } from '../lib/logger.js';

const reportRouter = Router();

const analysisIdSchema = z.string().cuid().or(z.string().uuid());

reportRouter.get('/analyses/:analysisId/report', requireAuth, async (req, res) => {
  const parsed = analysisIdSchema.safeParse(req.params.analysisId);
  if (!parsed.success) {
    throw new AppError('ANALYSIS_NOT_FOUND', 404, 'Analysis not found');
  }
  const analysisId = parsed.data;

  const analysis = await prisma.analysis.findFirst({
    where: { id: analysisId, userId: req.user!.id },
  });

  if (!analysis || analysis.status === 'DELETED') {
    throw new AppError('ANALYSIS_NOT_FOUND', 404, 'Analysis not found');
  }

  if (analysis.status !== 'COMPLETED') {
    throw new AppError('ANALYSIS_NOT_COMPLETE', 400, 'Analysis must be completed before generating a report');
  }

  if (!analysis.results || typeof analysis.results !== 'object' || Array.isArray(analysis.results)) {
    throw new AppError('ANALYSIS_DATA_MISSING', 500, 'Analysis results are unavailable');
  }
  const results = analysis.results as Record<string, unknown>;
  const heatmaps = results.heatmaps as Record<string, string> | undefined;

  // Download overlay image from S3 (fall back to original if overlay missing)
  let overlayBuffer: Buffer;
  const overlayKey = heatmaps?.overlay;
  const imageSource = overlayKey || analysis.imageUrl;

  try {
    // resolveS3Url handles both s3:// URLs and bare keys
    const { bucket, key } = resolveS3Url(imageSource);
    overlayBuffer = await downloadImage(`s3://${bucket}/${key}`);
  } catch (error) {
    logger.error('Failed to download image for PDF report', { analysisId, error: String(error) });
    throw new AppError('S3_DOWNLOAD_FAILED', 500, 'Failed to download image for report');
  }

  const reportData: AnalysisForReport = {
    id: analysis.id,
    platform: analysis.platform,
    createdAt: analysis.createdAt,
    scoring: results.scoring as AnalysisForReport['scoring'],
    insights: (results.insights as AnalysisForReport['insights']) ?? null,
    classification: (results.classification as AnalysisForReport['classification']) ?? null,
    overlayBuffer,
  };

  const pdfBuffer = await generateAnalysisReport(reportData);

  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="adpulse-report-${analysisId}.pdf"`);
  res.setHeader('Content-Length', pdfBuffer.length);
  res.end(pdfBuffer);
});

export { reportRouter };
