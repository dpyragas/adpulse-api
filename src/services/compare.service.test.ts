import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { prisma } from '../lib/prisma.js';
import { sendCompareProgress, sendCompareComplete, sendError } from './sse.service.js';
import {
  checkCompareCompletion,
  computeWinnerResult,
  computeDeltas,
  generateWinnerExplanation,
} from './compare.service.js';

vi.mock('./sse.service.js', () => ({
  sendProgress: vi.fn(),
  sendComplete: vi.fn(),
  sendCompareProgress: vi.fn(),
  sendCompareComplete: vi.fn(),
  sendError: vi.fn(),
}));

vi.mock('ai', () => ({
  generateObject: vi.fn(),
}));

vi.mock('../lib/ai.js', () => ({
  getModel: vi.fn().mockReturnValue('mock-model'),
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

// ── computeWinnerResult tests (Task 1, AC #1) ──

describe('computeWinnerResult', () => {
  it('selects highest-scoring variant as winner (2 variants)', () => {
    const result = computeWinnerResult([
      { id: 'a1', results: { scoring: { overall: 7.5 } } },
      { id: 'a2', results: { scoring: { overall: 9.0 } } },
    ]);

    expect(result.winnerId).toBe('a2');
    expect(result.rankings).toHaveLength(2);
    expect(result.rankings[0]).toEqual({ analysisId: 'a2', rank: 1, overallScore: 9.0 });
    expect(result.rankings[1]).toEqual({ analysisId: 'a1', rank: 2, overallScore: 7.5 });
  });

  it('selects highest-scoring variant as winner (3 variants)', () => {
    const result = computeWinnerResult([
      { id: 'a1', results: { scoring: { overall: 6.0 } } },
      { id: 'a2', results: { scoring: { overall: 8.5 } } },
      { id: 'a3', results: { scoring: { overall: 7.2 } } },
    ]);

    expect(result.winnerId).toBe('a2');
    expect(result.rankings).toHaveLength(3);
    expect(result.rankings.map((r) => r.analysisId)).toEqual(['a2', 'a3', 'a1']);
  });

  it('selects highest-scoring variant as winner (5 variants)', () => {
    const result = computeWinnerResult([
      { id: 'a1', results: { scoring: { overall: 5.0 } } },
      { id: 'a2', results: { scoring: { overall: 8.0 } } },
      { id: 'a3', results: { scoring: { overall: 9.5 } } },
      { id: 'a4', results: { scoring: { overall: 3.0 } } },
      { id: 'a5', results: { scoring: { overall: 7.0 } } },
    ]);

    expect(result.winnerId).toBe('a3');
    expect(result.rankings[0].overallScore).toBe(9.5);
    expect(result.rankings[4].overallScore).toBe(3.0);
  });

  it('handles tied scores (low confidence)', () => {
    const result = computeWinnerResult([
      { id: 'a1', results: { scoring: { overall: 7.5 } } },
      { id: 'a2', results: { scoring: { overall: 7.5 } } },
    ]);

    // First in sort order wins when tied
    expect(result.confidence).toBe('low');
    expect(result.rankings[0].overallScore).toBe(7.5);
    expect(result.rankings[1].overallScore).toBe(7.5);
  });

  it('computes high confidence when gap > 1.5', () => {
    const result = computeWinnerResult([
      { id: 'a1', results: { scoring: { overall: 9.0 } } },
      { id: 'a2', results: { scoring: { overall: 7.0 } } },
    ]);

    expect(result.confidence).toBe('high');
  });

  it('computes medium confidence when gap 0.5-1.5', () => {
    const result = computeWinnerResult([
      { id: 'a1', results: { scoring: { overall: 8.0 } } },
      { id: 'a2', results: { scoring: { overall: 7.0 } } },
    ]);

    expect(result.confidence).toBe('medium');
  });

  it('computes low confidence when gap < 0.5', () => {
    const result = computeWinnerResult([
      { id: 'a1', results: { scoring: { overall: 7.3 } } },
      { id: 'a2', results: { scoring: { overall: 7.0 } } },
    ]);

    expect(result.confidence).toBe('low');
  });

  it('computes medium confidence when gap is exactly 0.5 (boundary)', () => {
    const result = computeWinnerResult([
      { id: 'a1', results: { scoring: { overall: 7.5 } } },
      { id: 'a2', results: { scoring: { overall: 7.0 } } },
    ]);

    expect(result.confidence).toBe('medium');
  });
});

// ── computeDeltas tests (Task 2, AC #2) ──

describe('computeDeltas', () => {
  it('computes sub-score deltas (winner minus variant)', () => {
    const analyses = [
      {
        id: 'winner',
        results: {
          scoring: {
            overall: 9.0,
            subScores: { attention: 8.5, branding: 9.0, message: 8.0, aesthetic: 9.5 },
            elements: [],
          },
        },
      },
      {
        id: 'loser',
        results: {
          scoring: {
            overall: 7.0,
            subScores: { attention: 7.0, branding: 6.5, message: 8.5, aesthetic: 6.0 },
            elements: [],
          },
        },
      },
    ];

    const deltas = computeDeltas('winner', analyses);
    expect(deltas).toHaveLength(1);
    expect(deltas[0].analysisId).toBe('loser');
    expect(deltas[0].overallDelta).toBe(2.0);
    expect(deltas[0].subScoreDeltas).toEqual({
      attention: 1.5,
      branding: 2.5,
      message: -0.5,
      aesthetic: 3.5,
    });
  });

  it('computes element attention deltas', () => {
    const analyses = [
      {
        id: 'winner',
        results: {
          scoring: {
            overall: 9.0,
            subScores: { attention: 8.0, branding: 8.0, message: 8.0, aesthetic: 8.0 },
            elements: [
              { type: 'cta', found: true, attentionPercent: 15.0 },
              { type: 'headline', found: true, attentionPercent: 25.0 },
              { type: 'branding', found: true, attentionPercent: 10.0 },
            ],
          },
        },
      },
      {
        id: 'loser',
        results: {
          scoring: {
            overall: 7.0,
            subScores: { attention: 6.0, branding: 6.0, message: 6.0, aesthetic: 6.0 },
            elements: [
              { type: 'cta', found: true, attentionPercent: 8.0 },
              { type: 'headline', found: true, attentionPercent: 20.0 },
              { type: 'branding', found: false, attentionPercent: 0 },
            ],
          },
        },
      },
    ];

    const deltas = computeDeltas('winner', analyses);
    expect(deltas[0].elementDeltas).toEqual(
      expect.arrayContaining([
        { type: 'cta', attentionDelta: 7.0 },
        { type: 'headline', attentionDelta: 5.0 },
        { type: 'branding', attentionDelta: 10.0 },
      ])
    );
  });

  it('handles missing elements in some variants', () => {
    const analyses = [
      {
        id: 'winner',
        results: {
          scoring: {
            overall: 9.0,
            subScores: { attention: 8.0, branding: 8.0, message: 8.0, aesthetic: 8.0 },
            elements: [
              { type: 'cta', found: true, attentionPercent: 12.0 },
              { type: 'product', found: true, attentionPercent: 20.0 },
            ],
          },
        },
      },
      {
        id: 'loser',
        results: {
          scoring: {
            overall: 6.0,
            subScores: { attention: 5.0, branding: 5.0, message: 5.0, aesthetic: 5.0 },
            elements: [], // No elements detected
          },
        },
      },
    ];

    const deltas = computeDeltas('winner', analyses);
    expect(deltas[0].elementDeltas).toEqual(
      expect.arrayContaining([
        { type: 'cta', attentionDelta: 12.0 },
        { type: 'product', attentionDelta: 20.0 },
      ])
    );
  });

  it('returns empty array when winnerId not found in analyses', () => {
    const analyses = [
      { id: 'a1', results: { scoring: { overall: 8.0, subScores: { attention: 8, branding: 8, message: 8, aesthetic: 8 }, elements: [] } } },
    ];

    const deltas = computeDeltas('nonexistent', analyses);
    expect(deltas).toEqual([]);
  });

  it('filters out zero-delta elements', () => {
    const analyses = [
      {
        id: 'winner',
        results: {
          scoring: {
            overall: 8.0,
            subScores: { attention: 8.0, branding: 8.0, message: 8.0, aesthetic: 8.0 },
            elements: [{ type: 'cta', found: true, attentionPercent: 10.0 }],
          },
        },
      },
      {
        id: 'loser',
        results: {
          scoring: {
            overall: 7.0,
            subScores: { attention: 7.0, branding: 7.0, message: 7.0, aesthetic: 7.0 },
            elements: [{ type: 'cta', found: true, attentionPercent: 10.0 }],
          },
        },
      },
    ];

    const deltas = computeDeltas('winner', analyses);
    // CTA has same attention% → delta is 0 → filtered out
    expect(deltas[0].elementDeltas).toEqual([]);
  });
});

// ── generateWinnerExplanation tests (Task 3, AC #3) ──

describe('generateWinnerExplanation', () => {
  it('returns AI-generated explanation on success', async () => {
    const { generateObject } = await import('ai');
    const mockedGenerateObject = vi.mocked(generateObject);
    mockedGenerateObject.mockResolvedValueOnce({
      object: {
        explanation: 'Variant A wins because of stronger branding and CTA attention.',
        keyAdvantages: ['Better branding visibility', 'Higher CTA attention'],
      },
      finishReason: 'stop',
      usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
      request: {} as never,
      response: {} as never,
      rawResponse: undefined as never,
      toJsonResponse: (() => {}) as never,
      providerMetadata: undefined as never,
      experimental_providerMetadata: undefined as never,
      warnings: undefined as never,
      steps: [] as never,
    } as never);

    // Set env for test
    const origKey = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = 'test-key';

    const result = await generateWinnerExplanation(
      { winnerId: 'a1', confidence: 'high', rankings: [{ analysisId: 'a1', rank: 1, overallScore: 9.0 }] },
      [{ analysisId: 'a2', overallDelta: 2.0, subScoreDeltas: { attention: 1.5, branding: 2.0, message: 0.5, aesthetic: 0.0 }, elementDeltas: [] }],
      { overall: 9.0, subScores: { attention: 8.5, branding: 9.0, message: 8.0, aesthetic: 9.0 } },
      'META',
    );

    expect(result).toEqual({
      explanation: 'Variant A wins because of stronger branding and CTA attention.',
      keyAdvantages: ['Better branding visibility', 'Higher CTA attention'],
    });

    process.env.OPENAI_API_KEY = origKey;
  });

  it('returns null when AI is unavailable (graceful degradation)', async () => {
    const { generateObject } = await import('ai');
    const mockedGenerateObject = vi.mocked(generateObject);
    mockedGenerateObject.mockRejectedValueOnce(new Error('API unavailable'));

    const origKey = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = 'test-key';

    const result = await generateWinnerExplanation(
      { winnerId: 'a1', confidence: 'high', rankings: [{ analysisId: 'a1', rank: 1, overallScore: 9.0 }] },
      [],
      { overall: 9.0, subScores: { attention: 8.5, branding: 9.0, message: 8.0, aesthetic: 9.0 } },
      'META',
    );

    expect(result).toBeNull();

    process.env.OPENAI_API_KEY = origKey;
  });

  it('returns null when OPENAI_API_KEY is not set', async () => {
    const origKey = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;

    const result = await generateWinnerExplanation(
      { winnerId: 'a1', confidence: 'high', rankings: [{ analysisId: 'a1', rank: 1, overallScore: 9.0 }] },
      [],
      { overall: 9.0, subScores: { attention: 8.5, branding: 9.0, message: 8.0, aesthetic: 9.0 } },
      'META',
    );

    expect(result).toBeNull();

    process.env.OPENAI_API_KEY = origKey;
  });
});

// ── checkCompareCompletion integration tests ──

describe('checkCompareCompletion', () => {
  it('determines winner with confidence and stores results when all analyses COMPLETED (AC #4)', async () => {
    // Setup AI mock so explanation gets stored
    const { generateObject } = await import('ai');
    const mockedGenerateObject = vi.mocked(generateObject);
    mockedGenerateObject.mockResolvedValueOnce({
      object: { explanation: 'Winner excels in branding.', keyAdvantages: ['Strong CTA'] },
      finishReason: 'stop',
      usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
      request: {} as never, response: {} as never, rawResponse: undefined as never,
      toJsonResponse: (() => {}) as never, providerMetadata: undefined as never,
      experimental_providerMetadata: undefined as never, warnings: undefined as never, steps: [] as never,
    } as never);
    const origKey = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = 'test-key';

    const compareJob = await prisma.compareJob.create({
      data: { userId: testUserId, platform: 'META', status: 'PROCESSING' },
    });

    await prisma.analysis.createMany({
      data: [
        {
          userId: testUserId, platform: 'META', imageUrl: 's3://b/k1', status: 'COMPLETED',
          compareJobId: compareJob.id, results: {
            scoring: {
              overall: 7.5,
              subScores: { attention: 7.0, branding: 8.0, message: 7.5, aesthetic: 7.5 },
              elements: [{ type: 'cta', found: true, attentionPercent: 10.0 }],
            },
          },
        },
        {
          userId: testUserId, platform: 'META', imageUrl: 's3://b/k2', status: 'COMPLETED',
          compareJobId: compareJob.id, results: {
            scoring: {
              overall: 9.0,
              subScores: { attention: 9.0, branding: 9.0, message: 8.5, aesthetic: 9.5 },
              elements: [{ type: 'cta', found: true, attentionPercent: 15.0 }],
            },
          },
        },
        {
          userId: testUserId, platform: 'META', imageUrl: 's3://b/k3', status: 'COMPLETED',
          compareJobId: compareJob.id, results: {
            scoring: {
              overall: 6.0,
              subScores: { attention: 5.5, branding: 6.0, message: 6.5, aesthetic: 6.0 },
              elements: [{ type: 'cta', found: true, attentionPercent: 5.0 }],
            },
          },
        },
      ],
    });

    const analyses = await prisma.analysis.findMany({ where: { compareJobId: compareJob.id } });
    const winnerId = analyses.find((a) => {
      const r = a.results as Record<string, unknown> | null;
      return (r?.scoring as Record<string, unknown>)?.overall === 9.0;
    })!.id;

    await checkCompareCompletion(compareJob.id);

    const updated = await prisma.compareJob.findUnique({ where: { id: compareJob.id } });
    expect(updated!.status).toBe('COMPLETED');
    expect(updated!.winnerId).toBe(winnerId);

    // Verify results JSON contains winner algorithm output
    const results = updated!.results as Record<string, unknown>;
    expect(results.winnerId).toBe(winnerId);
    expect(results.confidence).toBe('medium'); // 9.0 - 7.5 = 1.5, exactly at boundary (>1.5 = high, 0.5-1.5 = medium)
    expect(results.rankings).toBeDefined();
    expect(results.deltas).toBeDefined();
    expect(results.explanation).toBe('Winner excels in branding.');
    expect(results.keyAdvantages).toEqual(['Strong CTA']);
    expect(sendCompareComplete).toHaveBeenCalledWith(compareJob.id, winnerId);

    process.env.OPENAI_API_KEY = origKey;
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
