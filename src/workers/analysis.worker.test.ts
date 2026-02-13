import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { prisma } from '../lib/prisma.js';
import { handleMessage } from './analysis.worker.js';

const TEST_EMAIL = 'worker-story32@example.com';
let testUserId: string;
let testAnalysisId: string;

async function cleanup() {
  const existing = await prisma.user.findUnique({ where: { email: TEST_EMAIL } });
  if (existing) {
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
};

const mockPipeline = vi.fn().mockResolvedValue(mockResult);
const failingPipeline = vi.fn().mockRejectedValue(new Error('ML service down'));

describe('handleMessage', () => {
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
});
