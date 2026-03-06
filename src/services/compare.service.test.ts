import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { prisma } from '../lib/prisma.js';
import { sendCompareProgress, sendCompareComplete, sendError } from './sse.service.js';
import { checkCompareCompletion } from './compare.service.js';

vi.mock('./sse.service.js', () => ({
  sendProgress: vi.fn(),
  sendComplete: vi.fn(),
  sendCompareProgress: vi.fn(),
  sendCompareComplete: vi.fn(),
  sendError: vi.fn(),
}));

const TEST_EMAIL = 'compare-service-test@example.com';
let testUserId: string;

async function cleanup() {
  const existing = await prisma.user.findUnique({ where: { email: TEST_EMAIL } });
  if (existing) {
    await prisma.usageRecord.deleteMany({ where: { userId: existing.id } });
    await prisma.analysis.deleteMany({ where: { userId: existing.id } });
    await prisma.compareJob.deleteMany({ where: { userId: existing.id } });
    await prisma.account.deleteMany({ where: { userId: existing.id } });
    await prisma.session.deleteMany({ where: { userId: existing.id } });
    await prisma.user.delete({ where: { id: existing.id } });
  }
}

beforeEach(async () => {
  await cleanup();
  vi.clearAllMocks();

  const user = await prisma.user.create({
    data: {
      id: 'compare-svc-test-user',
      name: 'Compare Svc Test',
      email: TEST_EMAIL,
      emailVerified: true,
    },
  });
  testUserId = user.id;
});

afterEach(async () => {
  await cleanup();
});

describe('checkCompareCompletion', () => {
  it('determines winner when all analyses COMPLETED (AC #4)', async () => {
    const compareJob = await prisma.compareJob.create({
      data: { userId: testUserId, platform: 'META', status: 'PROCESSING' },
    });

    await prisma.analysis.createMany({
      data: [
        {
          userId: testUserId, platform: 'META', imageUrl: 's3://b/k1', status: 'COMPLETED',
          compareJobId: compareJob.id, results: { scoring: { overall: 7.5 } },
        },
        {
          userId: testUserId, platform: 'META', imageUrl: 's3://b/k2', status: 'COMPLETED',
          compareJobId: compareJob.id, results: { scoring: { overall: 9.0 } },
        },
        {
          userId: testUserId, platform: 'META', imageUrl: 's3://b/k3', status: 'COMPLETED',
          compareJobId: compareJob.id, results: { scoring: { overall: 6.0 } },
        },
      ],
    });

    // Get the winner analysis (score 9.0)
    const analyses = await prisma.analysis.findMany({ where: { compareJobId: compareJob.id } });
    const winnerId = analyses.find((a) => {
      const r = a.results as Record<string, unknown> | null;
      return (r?.scoring as Record<string, unknown>)?.overall === 9.0;
    })!.id;

    await checkCompareCompletion(compareJob.id);

    const updated = await prisma.compareJob.findUnique({ where: { id: compareJob.id } });
    expect(updated!.status).toBe('COMPLETED');
    expect(updated!.winnerId).toBe(winnerId);
    expect(sendCompareComplete).toHaveBeenCalledWith(compareJob.id, winnerId);
  });

  it('marks FAILED and refunds when any analysis fails (AC #5)', async () => {
    const compareJob = await prisma.compareJob.create({
      data: { userId: testUserId, platform: 'META', status: 'PROCESSING' },
    });

    const failedAnalysis = await prisma.analysis.create({
      data: {
        userId: testUserId, platform: 'META', imageUrl: 's3://b/k1', status: 'FAILED',
        compareJobId: compareJob.id, quotaCharged: true,
      },
    });

    await prisma.usageRecord.create({
      data: { userId: testUserId, analysisId: failedAnalysis.id, credits: 1 },
    });

    await prisma.analysis.create({
      data: {
        userId: testUserId, platform: 'META', imageUrl: 's3://b/k2', status: 'COMPLETED',
        compareJobId: compareJob.id, results: { scoring: { overall: 7.0 } },
      },
    });

    await checkCompareCompletion(compareJob.id);

    const updated = await prisma.compareJob.findUnique({ where: { id: compareJob.id } });
    expect(updated!.status).toBe('FAILED');
    expect(sendError).toHaveBeenCalledWith(compareJob.id, 'COMPARE_FAILED', 'One or more analyses failed');

    // Refund is queued via setImmediate — wait for it
    await new Promise((r) => setTimeout(r, 50));
    const record = await prisma.usageRecord.findFirst({ where: { analysisId: failedAnalysis.id } });
    expect(record!.refunded).toBe(true);
  });

  it('broadcasts progress with { completed, total } when some analyses still processing (AC #3)', async () => {
    const compareJob = await prisma.compareJob.create({
      data: { userId: testUserId, platform: 'META', status: 'PROCESSING' },
    });

    await prisma.analysis.createMany({
      data: [
        {
          userId: testUserId, platform: 'META', imageUrl: 's3://b/k1', status: 'COMPLETED',
          compareJobId: compareJob.id, results: { scoring: { overall: 7.0 } },
        },
        {
          userId: testUserId, platform: 'META', imageUrl: 's3://b/k2', status: 'PROCESSING',
          compareJobId: compareJob.id,
        },
        {
          userId: testUserId, platform: 'META', imageUrl: 's3://b/k3', status: 'PENDING',
          compareJobId: compareJob.id,
        },
      ],
    });

    await checkCompareCompletion(compareJob.id);

    const updated = await prisma.compareJob.findUnique({ where: { id: compareJob.id } });
    expect(updated!.status).toBe('PROCESSING');
    expect(sendCompareProgress).toHaveBeenCalledWith(compareJob.id, 1, 3);
  });

  it('skips already-resolved compare job (race condition guard)', async () => {
    const compareJob = await prisma.compareJob.create({
      data: { userId: testUserId, platform: 'META', status: 'COMPLETED', winnerId: 'some-id' },
    });

    await checkCompareCompletion(compareJob.id);

    // Should not send any SSE events for already-resolved job
    expect(sendCompareComplete).not.toHaveBeenCalled();
    expect(sendError).not.toHaveBeenCalled();
  });
});
