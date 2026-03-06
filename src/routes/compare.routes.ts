import { Router } from 'express';
import { z } from 'zod';
import crypto from 'crypto';
import { requireAuth } from '../middleware/auth.js';
import { uploadMultiple } from '../middleware/upload.js';
import { prisma } from '../lib/prisma.js';
import { AppError } from '../lib/app-error.js';
import { uploadImage, getSignedImageUrl } from '../services/s3.service.js';
import { sendAnalysisMessage } from '../services/sqs.service.js';
import { addClient } from '../services/sse.service.js';
import { checkAndChargeQuota, refundQuota } from '../services/quota.service.js';
import { logger } from '../lib/logger.js';

const compareRouter = Router();

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

const compareIdSchema = z.string().cuid().or(z.string().uuid());

const listQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().refine((v) => [10, 25, 50].includes(v), {
    message: 'pageSize must be 10, 25, or 50',
  }).default(10),
});

// POST /api/compare — create compare job
compareRouter.post('/compare', requireAuth, uploadMultiple, async (req, res) => {
  const files = req.files as Express.Multer.File[] | undefined;

  if (!files || files.length < 2 || files.length > 5) {
    throw new AppError('INVALID_COMPARE_COUNT', 400, 'Upload 2-5 images for comparison');
  }

  const { platform } = platformSchema.parse({ platform: req.body.platform });
  const dbPlatform = PLATFORM_DB_MAP[platform];
  const userId = req.user!.id;

  // Create CompareJob
  const compareJob = await prisma.compareJob.create({
    data: {
      userId,
      platform: dbPlatform,
      status: 'PROCESSING',
    },
  });

  // Create Analysis records + upload to S3
  const variants: { id: string; imageUrl: string }[] = [];
  const chargedIds: string[] = [];

  try {
    for (const file of files) {
      const analysisId = crypto.randomUUID();
      const ext = MIME_EXT_MAP[file.mimetype] || 'bin';
      const s3Key = `analyses/${userId}/${analysisId}/${crypto.randomUUID()}.${ext}`;

      const fileUrl = await uploadImage(file.buffer, s3Key, file.mimetype);

      await prisma.analysis.create({
        data: {
          id: analysisId,
          userId,
          platform: dbPlatform,
          mediaType: 'IMAGE',
          imageUrl: fileUrl,
          status: 'PENDING',
          compareJobId: compareJob.id,
        },
      });

      await checkAndChargeQuota(userId, analysisId, 1);
      chargedIds.push(analysisId);
      variants.push({ id: analysisId, imageUrl: fileUrl });
    }

    // Queue all to SQS
    for (const v of variants) {
      await sendAnalysisMessage(v.id, v.imageUrl, dbPlatform, 'IMAGE');
    }
  } catch (error) {
    logger.error('Compare job creation failed', { compareJobId: compareJob.id, error: String(error) });

    // Refund all charged analyses
    for (const id of chargedIds) {
      try { await refundQuota(id); } catch (refundErr) {
        logger.warn('Compare refund failed', { analysisId: id, error: String(refundErr) });
      }
    }

    // Mark all created analyses as FAILED
    const createdIds = variants.map((v) => v.id);
    if (createdIds.length > 0) {
      await prisma.analysis.updateMany({
        where: { id: { in: createdIds } },
        data: { status: 'FAILED' },
      });
    }

    await prisma.compareJob.update({
      where: { id: compareJob.id },
      data: { status: 'FAILED' },
    });

    if (error instanceof AppError) throw error;
    throw new AppError('COMPARE_CREATION_FAILED', 500, 'Failed to create compare job');
  }

  res.status(201).json({
    data: {
      compareId: compareJob.id,
      analysisIds: variants.map((v) => v.id),
      status: 'PROCESSING',
    },
  });
});

// GET /api/compare/:compareId — get compare details
compareRouter.get('/compare/:compareId', requireAuth, async (req, res) => {
  const parsed = compareIdSchema.safeParse(req.params.compareId);
  if (!parsed.success) {
    throw new AppError('COMPARE_NOT_FOUND', 404, 'Compare job not found');
  }

  const compareJob = await prisma.compareJob.findFirst({
    where: { id: parsed.data, userId: req.user!.id },
    include: {
      analyses: {
        select: {
          id: true,
          status: true,
          platform: true,
          imageUrl: true,
          results: true,
          createdAt: true,
        },
      },
    },
  });

  if (!compareJob) {
    throw new AppError('COMPARE_NOT_FOUND', 404, 'Compare job not found');
  }

  // Sign S3 URLs for each variant
  const variants = await Promise.all(
    compareJob.analyses.map(async (a) => {
      const imageUrl = await getSignedImageUrl(a.imageUrl);

      let results: Record<string, unknown> | null = null;
      if (a.status === 'COMPLETED' && a.results && typeof a.results === 'object') {
        results = structuredClone(a.results) as Record<string, unknown>;
        const heatmaps = typeof results.heatmaps === 'object' && results.heatmaps
          ? (results.heatmaps as Record<string, string>)
          : null;
        if (heatmaps) {
          const [signedHeatmap, signedOverlay] = await Promise.all([
            heatmaps.heatmap ? getSignedImageUrl(heatmaps.heatmap) : null,
            heatmaps.overlay ? getSignedImageUrl(heatmaps.overlay) : null,
          ]);
          if (signedHeatmap) heatmaps.heatmap = signedHeatmap;
          if (signedOverlay) heatmaps.overlay = signedOverlay;
          delete heatmaps.grayscale;
        }
      }

      return {
        id: a.id,
        status: a.status,
        platform: a.platform,
        imageUrl,
        results,
        createdAt: a.createdAt,
      };
    })
  );

  res.json({
    data: {
      compareId: compareJob.id,
      status: compareJob.status,
      platform: compareJob.platform,
      winnerId: compareJob.winnerId,
      analysisIds: compareJob.analyses.map((a) => a.id),
      variants,
      createdAt: compareJob.createdAt,
    },
  });
});

// GET /api/compare/:compareId/stream — SSE for compare progress
compareRouter.get('/compare/:compareId/stream', requireAuth, async (req, res) => {
  const parsed = compareIdSchema.safeParse(req.params.compareId);
  if (!parsed.success) {
    throw new AppError('COMPARE_NOT_FOUND', 404, 'Compare job not found');
  }

  const compareJob = await prisma.compareJob.findFirst({
    where: { id: parsed.data, userId: req.user!.id },
    include: { analyses: { select: { id: true, status: true } } },
  });

  if (!compareJob) {
    throw new AppError('COMPARE_NOT_FOUND', 404, 'Compare job not found');
  }

  // SSE headers
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  // Already terminal
  if (compareJob.status === 'COMPLETED') {
    res.write(`event: complete\ndata: ${JSON.stringify({ compareId: compareJob.id, winnerId: compareJob.winnerId })}\n\n`);
    res.end();
    return;
  }
  if (compareJob.status === 'FAILED') {
    res.write(`event: error\ndata: ${JSON.stringify({ code: 'COMPARE_FAILED', message: 'One or more analyses failed' })}\n\n`);
    res.end();
    return;
  }

  // Register for live updates using compareId as jobId
  addClient(compareJob.id, res);

  // Initial progress
  const completed = compareJob.analyses.filter((a) => a.status === 'COMPLETED').length;
  const total = compareJob.analyses.length;
  res.write(`event: progress\ndata: ${JSON.stringify({ completed, total })}\n\n`);

  // Keepalive
  const keepalive = setInterval(() => {
    try { res.write(': keepalive\n\n'); } catch { clearInterval(keepalive); }
  }, 15_000);

  res.on('close', () => clearInterval(keepalive));
});

// GET /api/compare — paginated list
compareRouter.get('/compare', requireAuth, async (req, res) => {
  const { page, pageSize } = listQuerySchema.parse(req.query);
  const skip = (page - 1) * pageSize;

  const [compareJobs, total] = await Promise.all([
    prisma.compareJob.findMany({
      where: { userId: req.user!.id },
      orderBy: { createdAt: 'desc' },
      skip,
      take: pageSize,
      include: {
        analyses: {
          select: { id: true, status: true },
        },
      },
    }),
    prisma.compareJob.count({ where: { userId: req.user!.id } }),
  ]);

  const data = compareJobs.map((job) => ({
    compareId: job.id,
    status: job.status,
    platform: job.platform,
    winnerId: job.winnerId,
    variantCount: job.analyses.length,
    createdAt: job.createdAt,
  }));

  res.json({
    data,
    pagination: { page, pageSize, total },
  });
});

export { compareRouter };
