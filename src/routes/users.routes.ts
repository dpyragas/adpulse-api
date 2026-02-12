import { Router } from 'express';
import { z } from 'zod';
import { fromNodeHeaders } from 'better-auth/node';
import { requireAuth } from '../middleware/auth.js';
import { validateBody } from '../middleware/validate.js';
import { prisma } from '../lib/prisma.js';
import { auth } from '../lib/auth.js';
import { AppError } from '../lib/app-error.js';

const usersRouter = Router();

const updateUserSchema = z.object({
  name: z.string().min(1).max(100),
});

const deleteAccountSchema = z.object({
  password: z.string().min(1),
});

usersRouter.get('/users/me', requireAuth, async (req, res) => {
  const user = await prisma.user.findUnique({
    where: { id: req.user!.id },
    select: { id: true, email: true, name: true, image: true, role: true, createdAt: true },
  });
  if (!user) {
    throw new AppError('UNAUTHORIZED', 401, 'User no longer exists');
  }
  res.json({ data: user });
});

usersRouter.patch('/users/me', requireAuth, validateBody(updateUserSchema), async (req, res) => {
  const updated = await prisma.user.update({
    where: { id: req.user!.id },
    data: { name: req.body.name },
    select: { id: true, email: true, name: true, image: true, role: true, createdAt: true },
  });
  res.json({ data: updated });
});

// Better Auth requires password confirmation in body for deleteUser
usersRouter.delete('/users/me', requireAuth, validateBody(deleteAccountSchema), async (req, res) => {
  try {
    await auth.api.deleteUser({
      headers: fromNodeHeaders(req.headers),
      body: req.body,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : '';
    if (message.toLowerCase().includes('session') || message.toLowerCase().includes('unauthorized')) {
      throw new AppError('UNAUTHORIZED', 401, 'Session invalid');
    }
    throw new AppError('ACCOUNT_DELETION_FAILED', 500, 'Failed to delete account');
  }
  res.json({ data: { message: 'Account deleted' } });
});

export { usersRouter };
