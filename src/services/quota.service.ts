import { prisma } from '../lib/prisma.js';
import { AppError } from '../lib/app-error.js';
import { logger } from '../lib/logger.js';
import { TIER_CREDITS } from '../lib/constants.js';

function getStartOfMonth(): Date {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), 1);
}

function resolveTierLimit(tier: string, userId?: string): number {
  const limit = TIER_CREDITS[tier as keyof typeof TIER_CREDITS];
  if (limit === undefined) {
    logger.warn('Unknown tier, defaulting to trial', { userId, tier });
    return TIER_CREDITS.trial;
  }
  return limit;
}

export async function checkQuota(userId: string): Promise<{
  allowed: boolean;
  used: number;
  limit: number;
  estimatedCredits: number;
}> {
  const [user, used] = await Promise.all([
    prisma.user.findUnique({
      where: { id: userId },
      select: { tier: true },
    }),
    prisma.usageRecord.count({
      where: {
        userId,
        refunded: false,
        chargedAt: { gte: getStartOfMonth() },
      },
    }),
  ]);

  if (!user) {
    throw new AppError('USER_NOT_FOUND', 404, 'User not found');
  }

  const limit = resolveTierLimit(user.tier, userId);

  return {
    allowed: used < limit,
    used,
    limit,
    estimatedCredits: 1,
  };
}

export async function checkAndChargeQuota(
  userId: string,
  analysisId: string,
  credits: number = 1,
  workspaceId?: string | null,
): Promise<{ used: number; limit: number; estimatedCredits: number }> {
  return prisma.$transaction(async (tx) => {
    const user = await tx.user.findUnique({
      where: { id: userId },
      select: { tier: true },
    });

    if (!user) {
      throw new AppError('USER_NOT_FOUND', 404, 'User not found');
    }

    const limit = resolveTierLimit(user.tier, userId);

    const used = await tx.usageRecord.count({
      where: {
        userId,
        refunded: false,
        chargedAt: { gte: getStartOfMonth() },
      },
    });

    if (used >= limit) {
      throw new AppError('QUOTA_EXCEEDED', 402, 'Analysis quota exceeded', {
        used,
        limit,
        estimatedCredits: credits,
      });
    }

    await tx.usageRecord.create({
      data: {
        userId,
        analysisId,
        credits,
        ...(workspaceId && { workspaceId }),
      },
    });
    await tx.analysis.update({
      where: { id: analysisId },
      data: { quotaCharged: true },
    });

    logger.info('Quota charged', { userId, analysisId, credits });
    return { used, limit, estimatedCredits: credits };
  }, { isolationLevel: 'Serializable' });
}

export async function refundQuota(analysisId: string): Promise<void> {
  const analysis = await prisma.analysis.findUnique({
    where: { id: analysisId },
    select: { quotaCharged: true },
  });

  if (!analysis?.quotaCharged) return;

  await prisma.$transaction([
    prisma.usageRecord.updateMany({
      where: { analysisId, refunded: false },
      data: { refunded: true },
    }),
    prisma.analysis.update({
      where: { id: analysisId },
      data: { quotaCharged: false },
    }),
  ]);

  logger.info('Quota refunded', { analysisId });
}

export async function getUsage(userId: string): Promise<{
  used: number;
  limit: number;
  tier: string;
}> {
  const [user, used] = await Promise.all([
    prisma.user.findUnique({
      where: { id: userId },
      select: { tier: true },
    }),
    prisma.usageRecord.count({
      where: {
        userId,
        refunded: false,
        chargedAt: { gte: getStartOfMonth() },
      },
    }),
  ]);

  if (!user) {
    throw new AppError('USER_NOT_FOUND', 404, 'User not found');
  }

  const limit = resolveTierLimit(user.tier, userId);

  return { used, limit, tier: user.tier };
}
