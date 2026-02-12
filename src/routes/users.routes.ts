import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth.js';
import { validateBody } from '../middleware/validate.js';
import { prisma } from '../lib/prisma.js';

const usersRouter = Router();

const updateUserSchema = z.object({
  name: z.string().min(1).max(100),
});

usersRouter.get('/users/me', requireAuth, async (req, res) => {
  const user = await prisma.user.findUniqueOrThrow({
    where: { id: req.user!.id },
    select: { id: true, email: true, name: true, image: true, role: true, createdAt: true },
  });
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

export { usersRouter };
