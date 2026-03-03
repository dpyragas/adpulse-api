import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth.js';
import { validateQuery } from '../middleware/validate.js';
import { AppError } from '../lib/app-error.js';
import { listAnalyses } from '../services/history.service.js';

const historyRouter = Router();

export const listAnalysesQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().refine((v) => [10, 25, 50].includes(v), {
    message: 'pageSize must be 10, 25, or 50',
  }).default(10),
  platform: z.enum(['meta', 'tiktok', 'linkedin', 'general']).optional(),
  scoreMin: z.coerce.number().min(1).max(10).optional(),
  scoreMax: z.coerce.number().min(1).max(10).optional(),
  search: z.string().max(200).optional(),
  sortBy: z.enum(['createdAt', 'updatedAt', 'score']).default('createdAt'),
  order: z.enum(['asc', 'desc']).default('desc'),
  workspace: z.enum(['true', 'false']).transform((v) => v === 'true').optional(),
  status: z.enum(['COMPLETED', 'FAILED']).optional(),
}).refine(
  (data) => {
    if (data.scoreMin !== undefined && data.scoreMax !== undefined) {
      return data.scoreMin <= data.scoreMax;
    }
    return true;
  },
  { message: 'scoreMin must be <= scoreMax', path: ['scoreMin'] }
);

historyRouter.get(
  '/analyses',
  requireAuth,
  validateQuery(listAnalysesQuerySchema),
  async (req, res) => {
    const filters = req.query as unknown as z.infer<typeof listAnalysesQuerySchema>;

    // Workspace mode
    const workspaceId: string | null = null;
    if (filters.workspace) {
      // No workspace implementation yet — stub
      throw new AppError('WORKSPACE_NOT_CONFIGURED', 400, 'Workspace not configured');
    }

    const result = await listAnalyses(req.user!.id, workspaceId, filters);
    res.json(result);
  }
);

export { historyRouter };
