import { Router } from 'express';
import type { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { Prisma } from '@prisma/client';
import crypto from 'crypto';
import { requireAuth } from '../middleware/auth.js';
import { uploadSingle, uploadSingleVideo } from '../middleware/upload.js';
import { prisma } from '../lib/prisma.js';
import { AppError } from '../lib/app-error.js';
import { uploadImage, getSignedImageUrl, resolveS3Url, deleteImage } from '../services/s3.service.js';
import { sendAnalysisMessage } from '../services/sqs.service.js';
import { validateVideoDuration } from '../services/video.service.js';
import { addClient } from '../services/sse.service.js';
import { checkAndChargeQuota, refundQuota } from '../services/quota.service.js';
import { generateCreativeBrief } from '../services/brief.service.js';
import { generateShareToken, revokeShareToken, signResultUrls } from '../services/share.service.js';
import { logger } from '../lib/logger.js';

const analysisRouter = Router();

const platformSchema = z.object({
  platform: z.enum(['meta', 'tiktok', 'linkedin', 'general']),
});

const typeQuerySchema = z.object({
  type: z.enum(['image', 'video']).optional().default('image'),
});

const PLATFORM_DB_MAP = {
  meta: 'META',
  tiktok: 'TIKTOK',
  linkedin: 'LINKEDIN',
  general: 'GENERAL',
} as const;

const MIME_EXT_MAP: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'video/mp4': 'mp4',
  'video/quicktime': 'mov',
};

function selectUploadMiddleware(req: Request, res: Response, next: NextFunction) {
  if (req.query.type === 'video') return uploadSingleVideo(req, res, next);
  return uploadSingle(req, res, next);
}

const analysisIdSchema = z.string().cuid().or(z.string().uuid());

analysisRouter.post('/analyses', requireAuth, selectUploadMiddleware, async (req, res) => {
  if (!req.file) {
    throw new AppError('FILE_REQUIRED', 400, 'Image file is required');
  }

  const { type } = typeQuerySchema.parse(req.query);
  const { platform } = platformSchema.parse({ platform: req.body.platform });
  const isVideo = type === 'video';

  if (isVideo) {
    await validateVideoDuration(req.file.buffer);
  }

  const analysisId = crypto.randomUUID();
  const ext = MIME_EXT_MAP[req.file.mimetype] || 'bin';
  const s3Key = `analyses/${req.user!.id}/${analysisId}/${crypto.randomUUID()}.${ext}`;

  const fileUrl = await uploadImage(req.file.buffer, s3Key, req.file.mimetype);
  const mediaType = isVideo ? 'VIDEO' : 'IMAGE';

  const analysis = await prisma.analysis.create({
    data: {
      id: analysisId,
      userId: req.user!.id,
      platform: PLATFORM_DB_MAP[platform],
      mediaType,
      imageUrl: fileUrl,
      status: 'PENDING',
    },
  });

  logger.info('Analysis created', { analysisId: analysis.id, userId: req.user!.id, platform, mediaType });

  await checkAndChargeQuota(req.user!.id, analysis.id, 1, analysis.workspaceId);

  try {
    await sendAnalysisMessage(analysis.id, fileUrl, PLATFORM_DB_MAP[platform], mediaType);
  } catch (error) {
    logger.error('SQS enqueue failed, marking analysis FAILED', {
      analysisId: analysis.id,
      error: String(error),
    });
    try { await refundQuota(analysis.id); } catch (refundErr) {
      logger.warn('Quota refund failed on SQS failure', { analysisId: analysis.id, error: String(refundErr) });
    }
    await prisma.analysis.update({
      where: { id: analysis.id },
      data: { status: 'FAILED' },
    });
    throw new AppError('JOB_QUEUE_FAILED', 500, 'Failed to queue analysis job');
  }

  res.status(201).json({
    data: { analysisId: analysis.id, status: analysis.status },
  });
});

analysisRouter.post('/analyses/:analysisId/retry', requireAuth, async (req, res) => {
  const parsed = analysisIdSchema.safeParse(req.params.analysisId);
  if (!parsed.success) {
    throw new AppError('ANALYSIS_NOT_FOUND', 404, 'Analysis not found');
  }
  const analysisId = parsed.data;

  const analysis = await prisma.analysis.findFirst({
    where: { id: analysisId, userId: req.user!.id },
  });

  if (!analysis) {
    throw new AppError('ANALYSIS_NOT_FOUND', 404, 'Analysis not found');
  }

  if (analysis.status !== 'FAILED') {
    throw new AppError('ANALYSIS_NOT_FAILED', 400, 'Only failed analyses can be retried');
  }

  // Clean up any un-refunded charge from the original failed run
  try { await refundQuota(analysisId); } catch (refundErr) {
    logger.warn('Quota refund cleanup failed on retry', { analysisId, error: String(refundErr) });
  }

  await prisma.analysis.update({
    where: { id: analysisId },
    data: { status: 'PENDING', results: Prisma.DbNull, quotaCharged: false },
  });

  await checkAndChargeQuota(req.user!.id, analysisId, 1, analysis.workspaceId);

  try {
    await sendAnalysisMessage(analysisId, analysis.imageUrl, analysis.platform, analysis.mediaType);
  } catch (error) {
    logger.error('SQS enqueue failed on retry', { analysisId, error: String(error) });
    try { await refundQuota(analysisId); } catch (refundErr) {
      logger.warn('Quota refund failed on SQS failure', { analysisId, error: String(refundErr) });
    }
    await prisma.analysis.update({
      where: { id: analysisId },
      data: { status: 'FAILED' },
    });
    throw new AppError('JOB_QUEUE_FAILED', 500, 'Failed to queue analysis retry');
  }

  res.json({
    data: { analysisId, status: 'PENDING' },
  });
});

analysisRouter.get('/analyses/:analysisId', requireAuth, async (req, res) => {
  const parsed = analysisIdSchema.safeParse(req.params.analysisId);
  if (!parsed.success) {
    throw new AppError('ANALYSIS_NOT_FOUND', 404, 'Analysis not found');
  }
  const analysisId = parsed.data;

  const analysis = await prisma.analysis.findFirst({
    where: { id: analysisId, userId: req.user!.id },
    select: { id: true, status: true, platform: true, imageUrl: true, results: true, createdAt: true, updatedAt: true },
  });

  if (!analysis || analysis.status === 'DELETED') {
    throw new AppError('ANALYSIS_NOT_FOUND', 404, 'Analysis not found');
  }

  const imageUrl = await getSignedImageUrl(analysis.imageUrl);

  let results: Record<string, unknown> | null = null;
  if (analysis.status === 'COMPLETED' && analysis.results && typeof analysis.results === 'object') {
    results = await signResultUrls(analysis.results as Record<string, unknown>);
  }

  res.json({
    data: { id: analysis.id, status: analysis.status, platform: analysis.platform, imageUrl, results, createdAt: analysis.createdAt, updatedAt: analysis.updatedAt },
  });
});

analysisRouter.get('/analyses/:analysisId/stream', requireAuth, async (req, res) => {
  const analysisId = req.params.analysisId as string;
  const analysis = await prisma.analysis.findUnique({
    where: { id: analysisId },
    select: { id: true, userId: true, status: true },
  });

  if (!analysis || analysis.userId !== req.user!.id) {
    throw new AppError('ANALYSIS_NOT_FOUND', 404, 'Analysis not found');
  }

  // SSE headers
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  // Already terminal — send final event immediately
  if (analysis.status === 'COMPLETED') {
    res.write(`event: complete\ndata: ${JSON.stringify({ analysisId: analysis.id })}\n\n`);
    res.end();
    return;
  }
  if (analysis.status === 'FAILED') {
    res.write(`event: error\ndata: ${JSON.stringify({ code: 'PROCESSING_FAILED', message: 'Analysis failed' })}\n\n`);
    res.end();
    return;
  }

  // Register for live updates
  addClient(analysis.id, res);

  // Initial heartbeat for PENDING/PROCESSING
  res.write(`event: progress\ndata: ${JSON.stringify({ stage: 0, label: 'Queued...', progress: 0.0 })}\n\n`);

  // Keepalive to prevent proxy timeout (ECS ALB default: 60s idle)
  const keepalive = setInterval(() => {
    try { res.write(': keepalive\n\n'); } catch { clearInterval(keepalive); }
  }, 15_000);

  res.on('close', () => clearInterval(keepalive));
});

analysisRouter.delete('/analyses/:analysisId', requireAuth, async (req, res) => {
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

  if (analysis.status === 'PENDING' || analysis.status === 'PROCESSING') {
    throw new AppError('ANALYSIS_IN_PROGRESS', 409, 'Cannot delete analysis while processing');
  }

  await prisma.analysis.update({
    where: { id: analysisId },
    data: { status: 'DELETED' },
  });

  // Fire-and-forget S3 cleanup
  const keysToDelete: string[] = [];
  keysToDelete.push(resolveS3Url(analysis.imageUrl).key);

  if (analysis.results && typeof analysis.results === 'object') {
    const results = analysis.results as Record<string, unknown>;
    const heatmaps = results.heatmaps as Record<string, string> | undefined;
    if (heatmaps) {
      if (heatmaps.heatmap) keysToDelete.push(resolveS3Url(heatmaps.heatmap).key);
      if (heatmaps.overlay) keysToDelete.push(resolveS3Url(heatmaps.overlay).key);
      if (heatmaps.grayscale) keysToDelete.push(resolveS3Url(heatmaps.grayscale).key);
    }
  }

  Promise.all(keysToDelete.map((key) => deleteImage(key))).catch((error) => {
    logger.error('S3 cleanup failed for deleted analysis', { analysisId, error: String(error) });
  });

  res.json({ data: { message: 'Analysis deleted' } });
});

// ── Share Routes ──

analysisRouter.post('/analyses/:analysisId/share', requireAuth, async (req, res) => {
  const parsed = analysisIdSchema.safeParse(req.params.analysisId);
  if (!parsed.success) {
    throw new AppError('ANALYSIS_NOT_FOUND', 404, 'Analysis not found');
  }

  const { shareUrl } = await generateShareToken(parsed.data, req.user!.id);
  res.json({ data: { shareUrl } });
});

analysisRouter.delete('/analyses/:analysisId/share', requireAuth, async (req, res) => {
  const parsed = analysisIdSchema.safeParse(req.params.analysisId);
  if (!parsed.success) {
    throw new AppError('ANALYSIS_NOT_FOUND', 404, 'Analysis not found');
  }

  await revokeShareToken(parsed.data, req.user!.id);
  res.json({ data: { message: 'Share link revoked' } });
});

// ── Creative Brief Routes ──

analysisRouter.post('/analyses/:analysisId/brief', requireAuth, async (req, res) => {
  const parsed = analysisIdSchema.safeParse(req.params.analysisId);
  if (!parsed.success) {
    throw new AppError('ANALYSIS_NOT_FOUND', 404, 'Analysis not found');
  }
  const analysisId = parsed.data;

  const analysis = await prisma.analysis.findFirst({
    where: { id: analysisId, userId: req.user!.id },
    select: { id: true, status: true, results: true, platform: true },
  });

  if (!analysis) {
    throw new AppError('ANALYSIS_NOT_FOUND', 404, 'Analysis not found');
  }

  if (analysis.status !== 'COMPLETED') {
    throw new AppError('ANALYSIS_NOT_COMPLETE', 400, 'Analysis must be completed before generating a brief');
  }

  const results = analysis.results as Record<string, unknown> | null;

  if (!results || typeof results !== 'object') {
    throw new AppError('ANALYSIS_NOT_COMPLETE', 400, 'Analysis results are not available');
  }

  if (results.brief) {
    res.json({ data: { brief: results.brief } });
    return;
  }

  const brief = await generateCreativeBrief(
    results as Parameters<typeof generateCreativeBrief>[0],
    analysis.platform,
    analysisId,
  );

  await prisma.analysis.update({
    where: { id: analysisId },
    data: {
      results: {
        ...results,
        brief,
      },
    },
  });

  res.status(201).json({ data: { brief } });
});

analysisRouter.get('/analyses/:analysisId/brief', requireAuth, async (req, res) => {
  const parsed = analysisIdSchema.safeParse(req.params.analysisId);
  if (!parsed.success) {
    throw new AppError('ANALYSIS_NOT_FOUND', 404, 'Analysis not found');
  }
  const analysisId = parsed.data;

  const analysis = await prisma.analysis.findFirst({
    where: { id: analysisId, userId: req.user!.id },
    select: { results: true },
  });

  if (!analysis) {
    throw new AppError('ANALYSIS_NOT_FOUND', 404, 'Analysis not found');
  }

  const results = analysis.results as Record<string, unknown> | null;
  const brief = results?.brief;

  if (!brief) {
    throw new AppError('BRIEF_NOT_FOUND', 404, 'No creative brief found for this analysis');
  }

  res.json({ data: { brief } });
});

export { analysisRouter };
