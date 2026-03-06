import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { prisma } from '../lib/prisma.js';
import { checkQuota, checkAndChargeQuota, refundQuota, getUsage } from './quota.service.js';

const TEST_EMAIL = 'quota-test@example.com';
let testUserId: string;
let testAnalysisId: string;

async function cleanup() {
  const existing = await prisma.user.findUnique({ where: { email: TEST_EMAIL } });
  if (existing) {
    await prisma.usageRecord.deleteMany({ where: { userId: existing.id } });
    await prisma.analysis.deleteMany({ where: { userId: existing.id } });
    await prisma.account.deleteMany({ where: { userId: existing.id } });
    await prisma.session.deleteMany({ where: { userId: existing.id } });
    await prisma.user.delete({ where: { id: existing.id } });
  }
}

beforeEach(async () => {
  await cleanup();

  const user = await prisma.user.create({
    data: {
      id: 'quota-test-user',
      name: 'Quota Test',
      email: TEST_EMAIL,
      emailVerified: true,
      tier: 'trial',
    },
  });
  testUserId = user.id;

  const analysis = await prisma.analysis.create({
    data: {
      userId: testUserId,
      platform: 'META',
      imageUrl: 's3://test-bucket/quota-test',
      status: 'PENDING',
    },
  });
  testAnalysisId = analysis.id;
});

afterEach(async () => {
  await cleanup();
});

describe('checkQuota', () => {
  it('allows analysis when under limit', async () => {
    const result = await checkQuota(testUserId);
    expect(result.allowed).toBe(true);
    expect(result.used).toBe(0);
    expect(result.limit).toBe(3);
    expect(result.estimatedCredits).toBe(1);
  });

  it('denies analysis when at limit', async () => {
    // Create 3 usage records (trial limit)
    for (let i = 0; i < 3; i++) {
      const a = await prisma.analysis.create({
        data: {
          userId: testUserId,
          platform: 'META',
          imageUrl: `s3://test-bucket/quota-${i}`,
          status: 'COMPLETED',
        },
      });
      await prisma.usageRecord.create({
        data: { userId: testUserId, analysisId: a.id, credits: 1 },
      });
    }

    const result = await checkQuota(testUserId);
    expect(result.allowed).toBe(false);
    expect(result.used).toBe(3);
    expect(result.limit).toBe(3);
  });

  it('does not count refunded records', async () => {
    // Create 3 usage records but refund one
    for (let i = 0; i < 3; i++) {
      const a = await prisma.analysis.create({
        data: {
          userId: testUserId,
          platform: 'META',
          imageUrl: `s3://test-bucket/quota-refund-${i}`,
          status: 'COMPLETED',
        },
      });
      await prisma.usageRecord.create({
        data: { userId: testUserId, analysisId: a.id, credits: 1, refunded: i === 0 },
      });
    }

    const result = await checkQuota(testUserId);
    expect(result.allowed).toBe(true);
    expect(result.used).toBe(2);
  });

  it('throws for nonexistent user', async () => {
    await expect(checkQuota('nonexistent')).rejects.toMatchObject({ code: 'USER_NOT_FOUND' });
  });
});

describe('checkAndChargeQuota', () => {
  it('atomically checks and charges quota', async () => {
    const result = await checkAndChargeQuota(testUserId, testAnalysisId, 1);
    expect(result.used).toBe(0);
    expect(result.limit).toBe(3);

    const record = await prisma.usageRecord.findFirst({
      where: { analysisId: testAnalysisId },
    });
    expect(record).toBeTruthy();
    expect(record!.credits).toBe(1);
    expect(record!.refunded).toBe(false);

    const analysis = await prisma.analysis.findUnique({ where: { id: testAnalysisId } });
    expect(analysis!.quotaCharged).toBe(true);
  });

  it('throws QUOTA_EXCEEDED when at limit', async () => {
    for (let i = 0; i < 3; i++) {
      const a = await prisma.analysis.create({
        data: {
          userId: testUserId,
          platform: 'META',
          imageUrl: `s3://test-bucket/charge-${i}`,
          status: 'COMPLETED',
        },
      });
      await prisma.usageRecord.create({
        data: { userId: testUserId, analysisId: a.id, credits: 1 },
      });
    }

    await expect(checkAndChargeQuota(testUserId, testAnalysisId, 1)).rejects.toMatchObject({
      code: 'QUOTA_EXCEEDED',
      status: 402,
    });

    // No new usage record created
    const record = await prisma.usageRecord.findFirst({
      where: { analysisId: testAnalysisId },
    });
    expect(record).toBeNull();
  });

  it('propagates workspaceId to usage record', async () => {
    await checkAndChargeQuota(testUserId, testAnalysisId, 1, 'workspace-123');

    const record = await prisma.usageRecord.findFirst({
      where: { analysisId: testAnalysisId },
    });
    expect(record!.workspaceId).toBe('workspace-123');
  });
});

describe('refundQuota', () => {
  it('refunds charged quota', async () => {
    await checkAndChargeQuota(testUserId, testAnalysisId, 1);
    await refundQuota(testAnalysisId);

    const record = await prisma.usageRecord.findFirst({
      where: { analysisId: testAnalysisId },
    });
    expect(record!.refunded).toBe(true);

    const analysis = await prisma.analysis.findUnique({ where: { id: testAnalysisId } });
    expect(analysis!.quotaCharged).toBe(false);
  });

  it('no-ops when quota was not charged', async () => {
    await refundQuota(testAnalysisId);

    const records = await prisma.usageRecord.count({
      where: { analysisId: testAnalysisId },
    });
    expect(records).toBe(0);
  });
});

describe('getUsage', () => {
  it('returns usage summary', async () => {
    await checkAndChargeQuota(testUserId, testAnalysisId, 1);

    const usage = await getUsage(testUserId);
    expect(usage.used).toBe(1);
    expect(usage.limit).toBe(3);
    expect(usage.tier).toBe('trial');
  });
});
