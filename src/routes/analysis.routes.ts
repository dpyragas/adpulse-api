import { Router } from 'express';
import { z } from 'zod';
import crypto from 'crypto';
import { requireAuth } from '../middleware/auth.js';
import { uploadSingle } from '../middleware/upload.js';
import { prisma } from '../lib/prisma.js';
import { AppError } from '../lib/app-error.js';
import { uploadImage } from '../services/s3.service.js';
import { sendAnalysisMessage } from '../services/sqs.service.js';
import { addClient } from '../services/sse.service.js';
import { logger } from '../lib/logger.js';

const analysisRouter = Router();

const platformSchema = z.object({
  platform: z.enum(['meta', 'tiktok', 'linkedin', 'general']),
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
};

analysisRouter.post('/analyses', requireAuth, uploadSingle, async (req, res) => {
  if (!req.file) {
    throw new AppError('FILE_REQUIRED', 400, 'Image file is required');
  }

  // Platform comes as form field (multipart), not JSON body
  const { platform } = platformSchema.parse({ platform: req.body.platform });

  const analysisId = crypto.randomUUID();
  const ext = MIME_EXT_MAP[req.file.mimetype] || 'bin';
  const s3Key = `analyses/${req.user!.id}/${analysisId}/${crypto.randomUUID()}.${ext}`;

  const imageUrl = await uploadImage(req.file.buffer, s3Key, req.file.mimetype);

  const analysis = await prisma.analysis.create({
    data: {
      id: analysisId,
      userId: req.user!.id,
      platform: PLATFORM_DB_MAP[platform],
      imageUrl,
      status: 'PENDING',
    },
  });

  logger.info('Analysis created', { analysisId: analysis.id, userId: req.user!.id, platform });

  try {
    await sendAnalysisMessage(analysis.id, imageUrl, PLATFORM_DB_MAP[platform]);
  } catch (error) {
    logger.error('SQS enqueue failed, marking analysis FAILED', {
      analysisId: analysis.id,
      error: String(error),
    });
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

export { analysisRouter };
