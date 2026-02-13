import { Router } from 'express';
import { z } from 'zod';
import crypto from 'crypto';
import { requireAuth } from '../middleware/auth.js';
import { uploadSingle } from '../middleware/upload.js';
import { prisma } from '../lib/prisma.js';
import { AppError } from '../lib/app-error.js';
import { uploadImage } from '../services/s3.service.js';
import { sendAnalysisMessage } from '../services/sqs.service.js';
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

export { analysisRouter };
