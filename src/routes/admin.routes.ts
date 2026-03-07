import { Router } from 'express';
import { z } from 'zod';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { validateQuery } from '../middleware/validate.js';
import { prisma } from '../lib/prisma.js';
import { logger } from '../lib/logger.js';
import { RATING_DB_MAP } from '../lib/constants.js';

const adminRouter = Router();

const adminFeedbackQuerySchema = z.object({
  rating: z.enum(['up', 'down']).optional(),
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().min(10).max(50).default(20),
});

adminRouter.get(
  '/feedback',
  requireAuth,
  requireRole('admin'),
  validateQuery(adminFeedbackQuerySchema),
  async (req, res) => {
    const { rating, page, pageSize } = req.query as unknown as z.infer<typeof adminFeedbackQuerySchema>;

    const where = rating ? { rating: RATING_DB_MAP[rating] } : {};

    // Note: Prisma doesn't support JSON field selection. We fetch full results
    // and extract overallScore in application code. Acceptable at pageSize <= 50.
    const [feedbacks, total] = await Promise.all([
      prisma.feedback.findMany({
        where,
        include: {
          analysis: {
            select: { id: true, platform: true, createdAt: true, results: true },
          },
          user: {
            select: { id: true, name: true, email: true },
          },
        },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      prisma.feedback.count({ where }),
    ]);

    const data = feedbacks.map((f) => {
      const results = f.analysis.results as Record<string, unknown> | null;
      return {
        id: f.id,
        rating: f.rating,
        comment: f.comment,
        createdAt: f.createdAt,
        analysis: {
          id: f.analysis.id,
          platform: f.analysis.platform,
          createdAt: f.analysis.createdAt,
          overallScore: results?.overallScore ?? null,
        },
        user: f.user,
      };
    });

    logger.info('Admin feedback list accessed', { userId: (req as any).user.id, rating, page, total });

    res.json({
      data,
      pagination: { page, pageSize, total },
    });
  }
);

export { adminRouter };
