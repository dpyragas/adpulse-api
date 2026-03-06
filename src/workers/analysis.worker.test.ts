import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { prisma } from '../lib/prisma.js';
import { sendProgress, sendComplete, sendError } from '../services/sse.service.js';
import { handleMessage } from './analysis.worker.js';

vi.mock('../services/sse.service.js', () => ({
  sendProgress: vi.fn(),
  sendComplete: vi.fn(),
  sendError: vi.fn(),
}));

const TEST_EMAIL = 'worker-story32@example.com';
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
      id: 'worker-test-user',
      name: 'Worker Test',
      email: TEST_EMAIL,
      emailVerified: true,
    },
  });
  testUserId = user.id;

  const analysis = await prisma.analysis.create({
    data: {
      userId: testUserId,
      platform: 'META',
      imageUrl: 's3://test-bucket/test-key',
      status: 'PENDING',
    },
  });
  testAnalysisId = analysis.id;
});

afterEach(async () => {
  await cleanup();
});

const mockResult = {
  imageSize: { width: 1080, height: 1080 },
  aois: { branding: { found: true, bbox: [10, 20, 100, 80], confidence: 0.85 } },
  masks: null,
  aestheticScore: 7.2,
  heatmaps: { heatmap: 'analyses/x/heatmaps/heatmap.png', overlay: 'analyses/x/heatmaps/overlay.png', grayscale: 'analyses/x/heatmaps/grayscale.png' },
  allTextRegions: [],
  processingTimeMs: 3400,
  pipelineStatus: { pipeline: 'success', sum: 'success' },
  classification: {
    sentiment: { primary: 'cheerful', secondary: 'excitement', scores: { cheerful: 0.18, excitement: 0.14 } },
    category: { levels: [{ level: 1, label: 'Food', confidence: 0.87 }] },
  },
  scoring: {
    overallScore: 7.5,
    verdict: 'Good',
    subScores: { attention: 7.0, branding: 6.5, message: 8.0, aesthetic: 7.2 },
    elements: [{ type: 'branding', found: true, attentionPercent: 12.3 }],
    issues: [],
    platformModifiers: { attention: 0.30, branding: 0.20, message: 0.30, aesthetic: 0.20 },
  },
  insights: {
    unavailable: false,
    summary: 'Good ad with strong CTA but low branding visibility.',
    working: ['Good CTA placement'],
    issues: ['Low branding visibility'],
    recommendations: [{ text: 'Increase logo size', impact: 'high', element: 'branding' }],
    platformTips: ['Meta favors bold CTAs'],
  },
};

const mockPipeline = vi.fn().mockResolvedValue(mockResult);
const failingPipeline = vi.fn().mockRejectedValue(new Error('ML service down'));
const sseMockSendProgress = vi.mocked(sendProgress);
const sseMockSendComplete = vi.mocked(sendComplete);
const sseMockSendError = vi.mocked(sendError);

describe('handleMessage', () => {
  beforeEach(() => {
    sseMockSendProgress.mockClear();
    sseMockSendComplete.mockClear();
    sseMockSendError.mockClear();
  });

  it('transitions PENDING → PROCESSING → COMPLETED with results (AC #2, #3)', async () => {
    await handleMessage(
      {
        Body: JSON.stringify({
          analysisId: testAnalysisId,
          imageUrl: 's3://test-bucket/test-key',
          platform: 'META',
        }),
      },
      mockPipeline,
    );

    const analysis = await prisma.analysis.findUnique({ where: { id: testAnalysisId } });
    expect(analysis!.status).toBe('COMPLETED');
    expect(analysis!.results).toEqual(mockResult);
    expect(mockPipeline).toHaveBeenCalledOnce();
  });

  it('rejects invalid message body (missing fields)', async () => {
    await expect(
      handleMessage({ Body: JSON.stringify({ analysisId: testAnalysisId }) }, mockPipeline)
    ).rejects.toThrow();
  });

  it('rejects malformed JSON', async () => {
    await expect(
      handleMessage({ Body: 'not-json' }, mockPipeline)
    ).rejects.toThrow();
  });

  it('marks analysis FAILED when pipeline throws (AC #4)', async () => {
    await expect(
      handleMessage(
        {
          Body: JSON.stringify({
            analysisId: testAnalysisId,
            imageUrl: 's3://test-bucket/test-key',
            platform: 'META',
          }),
        },
        failingPipeline,
      )
    ).rejects.toMatchObject({ code: 'ANALYSIS_PIPELINE_FAILED' });

    const analysis = await prisma.analysis.findUnique({ where: { id: testAnalysisId } });
    expect(analysis!.status).toBe('FAILED');
  });

  it('successful pipeline → sendProgress called 3 times + sendComplete once (Story 3.6 AC #2, #3)', async () => {
    // Pipeline mock that verifies onProgress is called internally
    const trackingPipeline = vi.fn().mockImplementation(async (_body, onProgress) => {
      onProgress?.(1, 'Predicting attention...', 0.33);
      onProgress?.(2, 'Detecting elements...', 0.66);
      onProgress?.(3, 'Scoring...', 1.0);
      return mockResult;
    });

    await handleMessage(
      {
        Body: JSON.stringify({
          analysisId: testAnalysisId,
          imageUrl: 's3://test-bucket/test-key',
          platform: 'META',
        }),
      },
      trackingPipeline,
    );

    // handleMessage creates its own onProgress that calls sendProgress
    expect(sseMockSendProgress).toHaveBeenCalledTimes(3);
    expect(sseMockSendProgress).toHaveBeenCalledWith(testAnalysisId, 1, 'Predicting attention...', 0.33);
    expect(sseMockSendProgress).toHaveBeenCalledWith(testAnalysisId, 2, 'Detecting elements...', 0.66);
    expect(sseMockSendProgress).toHaveBeenCalledWith(testAnalysisId, 3, 'Scoring...', 1.0);
    expect(sseMockSendComplete).toHaveBeenCalledWith(testAnalysisId);
    expect(sseMockSendComplete).toHaveBeenCalledOnce();
  });

  it('failed pipeline → sendError called once (Story 3.6 AC #4)', async () => {
    await expect(
      handleMessage(
        {
          Body: JSON.stringify({
            analysisId: testAnalysisId,
            imageUrl: 's3://test-bucket/test-key',
            platform: 'META',
          }),
        },
        failingPipeline,
      )
    ).rejects.toMatchObject({ code: 'ANALYSIS_PIPELINE_FAILED' });

    expect(sseMockSendError).toHaveBeenCalledOnce();
    expect(sseMockSendError).toHaveBeenCalledWith(
      testAnalysisId,
      'PROCESSING_FAILED',
      expect.stringContaining('ML service down'),
    );
  });

  it('SSE service throws → worker still completes normally (Story 3.6 AC resilience)', async () => {
    sseMockSendProgress.mockImplementation(() => { throw new Error('SSE broken'); });
    sseMockSendComplete.mockImplementation(() => { throw new Error('SSE broken'); });

    // Pipeline that calls onProgress (which will throw via mock)
    const progressPipeline = vi.fn().mockImplementation(async (_body, onProgress) => {
      onProgress?.(1, 'Predicting attention...', 0.33);
      return mockResult;
    });

    await handleMessage(
      {
        Body: JSON.stringify({
          analysisId: testAnalysisId,
          imageUrl: 's3://test-bucket/test-key',
          platform: 'META',
        }),
      },
      progressPipeline,
    );

    // Worker should still complete despite SSE failures
    const analysis = await prisma.analysis.findUnique({ where: { id: testAnalysisId } });
    expect(analysis!.status).toBe('COMPLETED');
  });

  it('SSE service throws on error path → worker still throws AppError (Story 3.6 AC resilience)', async () => {
    sseMockSendError.mockImplementation(() => { throw new Error('SSE broken'); });

    await expect(
      handleMessage(
        {
          Body: JSON.stringify({
            analysisId: testAnalysisId,
            imageUrl: 's3://test-bucket/test-key',
            platform: 'META',
          }),
        },
        failingPipeline,
      )
    ).rejects.toMatchObject({ code: 'ANALYSIS_PIPELINE_FAILED' });

    const analysis = await prisma.analysis.findUnique({ where: { id: testAnalysisId } });
    expect(analysis!.status).toBe('FAILED');
  });

  it('refunds quota when analysis fails (Story 3.8 AC #1)', async () => {
    // Charge quota first (simulating what the route does)
    await prisma.usageRecord.create({
      data: { userId: testUserId, analysisId: testAnalysisId, credits: 1 },
    });
    await prisma.analysis.update({
      where: { id: testAnalysisId },
      data: { quotaCharged: true },
    });

    await expect(
      handleMessage(
        {
          Body: JSON.stringify({
            analysisId: testAnalysisId,
            imageUrl: 's3://test-bucket/test-key',
            platform: 'META',
          }),
        },
        failingPipeline,
      )
    ).rejects.toMatchObject({ code: 'ANALYSIS_PIPELINE_FAILED' });

    const record = await prisma.usageRecord.findFirst({ where: { analysisId: testAnalysisId } });
    expect(record!.refunded).toBe(true);

    const analysis = await prisma.analysis.findUnique({ where: { id: testAnalysisId } });
    expect(analysis!.quotaCharged).toBe(false);
  });

  it('timeout triggers FAILED status + SSE ML_TIMEOUT error + quota refund (Story 3.8 AC #4)', async () => {
    // Charge quota first
    await prisma.usageRecord.create({
      data: { userId: testUserId, analysisId: testAnalysisId, credits: 1 },
    });
    await prisma.analysis.update({
      where: { id: testAnalysisId },
      data: { quotaCharged: true },
    });

    // Simulate timeout by rejecting with the same AppError the timeout produces
    const { AppError } = await import('../lib/app-error.js');
    const timeoutPipeline = vi.fn().mockRejectedValue(
      new AppError('ML_TIMEOUT', 408, 'Analysis timed out after 60 seconds'),
    );

    await expect(
      handleMessage(
        {
          Body: JSON.stringify({
            analysisId: testAnalysisId,
            imageUrl: 's3://test-bucket/test-key',
            platform: 'META',
          }),
        },
        timeoutPipeline,
      )
    ).rejects.toMatchObject({ code: 'ANALYSIS_PIPELINE_FAILED' });

    const analysis = await prisma.analysis.findUnique({ where: { id: testAnalysisId } });
    expect(analysis!.status).toBe('FAILED');

    expect(sseMockSendError).toHaveBeenCalledWith(
      testAnalysisId,
      'ML_TIMEOUT',
      'Analysis timed out after 60 seconds',
    );

    const record = await prisma.usageRecord.findFirst({ where: { analysisId: testAnalysisId } });
    expect(record!.refunded).toBe(true);
  });
});
