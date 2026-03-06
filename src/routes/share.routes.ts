import { Router } from 'express';
import { z } from 'zod';
import { shareLimiter } from '../middleware/rate-limit.js';
import { AppError } from '../lib/app-error.js';
import { getSharedAnalysis } from '../services/share.service.js';

const shareRouter = Router();

const shareTokenSchema = z.string().length(12).regex(/^[A-Za-z0-9_-]+$/);

shareRouter.get('/share/:shareToken', shareLimiter, async (req, res) => {
  const parsed = shareTokenSchema.safeParse(req.params.shareToken);
  if (!parsed.success) {
    throw new AppError('SHARE_NOT_FOUND', 404, 'Shared analysis not found');
  }

  const result = await getSharedAnalysis(parsed.data);
  res.json({ data: result });
});

export { shareRouter };
