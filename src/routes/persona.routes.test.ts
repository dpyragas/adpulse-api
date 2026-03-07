import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import express from 'express';
import { errorHandler } from '../middleware/error-handler.js';

const mockAnalysisFindFirst = vi.fn();
const mockAnalysisUpdate = vi.fn();
const mockGeneratePersonas = vi.fn();
const mockGenerateReactions = vi.fn();
const mockGenerateReactionSummary = vi.fn();
const mockExtractAnalysisData = vi.fn();

vi.mock('../services/share.service.js', () => ({
  generateShareToken: vi.fn(),
  revokeShareToken: vi.fn(),
  signResultUrls: vi.fn(),
}));

vi.mock('../services/s3.service.js', () => ({
  uploadImage: vi.fn(),
  getSignedImageUrl: vi.fn().mockResolvedValue('https://signed.example.com/img'),
  resolveS3Url: vi.fn().mockReturnValue({ key: 'test-key' }),
  deleteImage: vi.fn(),
}));

vi.mock('../services/sqs.service.js', () => ({
  sendAnalysisMessage: vi.fn(),
}));

vi.mock('../services/video.service.js', () => ({
  validateVideoDuration: vi.fn(),
}));

vi.mock('../services/sse.service.js', () => ({
  addClient: vi.fn(),
}));

vi.mock('../services/quota.service.js', () => ({
  checkAndChargeQuota: vi.fn(),
  refundQuota: vi.fn(),
}));

vi.mock('../services/brief.service.js', () => ({
  generateCreativeBrief: vi.fn(),
}));

vi.mock('../services/persona.service.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/persona.service.js')>();
  return {
    ...actual,
    generatePersonas: (...args: unknown[]) => mockGeneratePersonas(...args),
    generateReactions: (...args: unknown[]) => mockGenerateReactions(...args),
    generateReactionSummary: (...args: unknown[]) => mockGenerateReactionSummary(...args),
    extractAnalysisData: (...args: unknown[]) => mockExtractAnalysisData(...args),
  };
});

vi.mock('../lib/prisma.js', () => ({
  prisma: {
    analysis: {
      findFirst: (...args: unknown[]) => mockAnalysisFindFirst(...args),
      findUnique: vi.fn(),
      create: vi.fn(),
      update: (...args: unknown[]) => mockAnalysisUpdate(...args),
    },
    feedback: {
      upsert: vi.fn(),
      findUnique: vi.fn(),
    },
  },
}));

vi.mock('../lib/logger.js', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));

vi.mock('../middleware/upload.js', () => ({
  uploadSingle: (_req: unknown, _res: unknown, next: () => void) => next(),
  uploadSingleVideo: (_req: unknown, _res: unknown, next: () => void) => next(),
}));

const mockRequireAuth = vi.fn();
vi.mock('../middleware/auth.js', () => ({
  requireAuth: (req: unknown, res: unknown, next: () => void) => mockRequireAuth(req, res, next),
  requireRole: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));

const { analysisRouter } = await import('./analysis.routes.js');

const VALID_CUID = 'clxxxxxxxxxxxxxxxxxxxxxxxxx';

function createTestApp() {
  const app = express();
  app.use(express.json());
  app.use('/api', analysisRouter);
  app.use(errorHandler);
  return app;
}

function authenticateAs(userId: string) {
  mockRequireAuth.mockImplementation((req: { user: { id: string; role: string } }, _res: unknown, next: () => void) => {
    req.user = { id: userId, role: 'member' };
    next();
  });
}

const validBody = {
  audience: {
    ageRange: [18, 35],
    gender: 'mixed',
    interests: ['fitness', 'nutrition'],
    platform: 'instagram',
    buyingIntent: 'medium',
    context: 'Health supplement ad',
  },
  personaCount: 3,
};

const mockPersonas = [
  { id: 'p1', name: 'Alex', age: 22, gender: 'male', occupation: 'Dev', personality: 'Analytical', browsingBehaviour: 'Quick scroll', purchaseDrivers: 'Reviews', attentionStyle: 'Scanner' },
  { id: 'p2', name: 'Maria', age: 30, gender: 'female', occupation: 'Yoga Instructor', personality: 'Creative', browsingBehaviour: 'Reads captions', purchaseDrivers: 'Values', attentionStyle: 'Reader' },
];

let app: express.Express;

beforeEach(() => {
  vi.clearAllMocks();
  app = createTestApp();
});

describe('POST /api/analyses/:analysisId/personas', () => {
  it('generates personas and returns 201', async () => {
    authenticateAs('u1');
    mockAnalysisFindFirst.mockResolvedValue({ id: VALID_CUID, status: 'COMPLETED', results: {} });
    mockGeneratePersonas.mockResolvedValue(mockPersonas);
    mockAnalysisUpdate.mockResolvedValue({});

    const res = await request(app)
      .post(`/api/analyses/${VALID_CUID}/personas`)
      .send(validBody);

    expect(res.status).toBe(201);
    expect(res.body.data.audience).toEqual(validBody.audience);
    expect(res.body.data.personas).toEqual(mockPersonas);
    expect(mockGeneratePersonas).toHaveBeenCalledWith(validBody.audience, 3);
  });

  it('rejects if analysis not COMPLETED (400)', async () => {
    authenticateAs('u1');
    mockAnalysisFindFirst.mockResolvedValue({ id: VALID_CUID, status: 'PROCESSING', results: null });

    const res = await request(app)
      .post(`/api/analyses/${VALID_CUID}/personas`)
      .send(validBody);

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('ANALYSIS_NOT_COMPLETE');
  });

  it('rejects if analysis not owned by user (404)', async () => {
    authenticateAs('u1');
    mockAnalysisFindFirst.mockResolvedValue(null);

    const res = await request(app)
      .post(`/api/analyses/${VALID_CUID}/personas`)
      .send(validBody);

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('ANALYSIS_NOT_FOUND');
  });

  it('validates request body (rejects invalid audience)', async () => {
    authenticateAs('u1');

    const res = await request(app)
      .post(`/api/analyses/${VALID_CUID}/personas`)
      .send({ audience: { gender: 'mixed' } });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('validates analysisId param', async () => {
    authenticateAs('u1');

    const res = await request(app)
      .post('/api/analyses/not-valid-id/personas')
      .send(validBody);

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('stores personaData in analysis results', async () => {
    authenticateAs('u1');
    mockAnalysisFindFirst.mockResolvedValue({ id: VALID_CUID, status: 'COMPLETED', results: { scoring: {} } });
    mockGeneratePersonas.mockResolvedValue(mockPersonas);
    mockAnalysisUpdate.mockResolvedValue({});

    await request(app)
      .post(`/api/analyses/${VALID_CUID}/personas`)
      .send(validBody);

    expect(mockAnalysisUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          results: expect.objectContaining({
            scoring: {},
            personaData: expect.objectContaining({
              audience: validBody.audience,
              personas: mockPersonas,
            }),
          }),
        }),
      })
    );
  });
});

describe('GET /api/analyses/:analysisId/personas', () => {
  it('returns cached personas', async () => {
    authenticateAs('u1');
    mockAnalysisFindFirst.mockResolvedValue({
      results: { personaData: { audience: validBody.audience, personas: mockPersonas } },
    });

    const res = await request(app).get(`/api/analyses/${VALID_CUID}/personas`);

    expect(res.status).toBe(200);
    expect(res.body.data.audience).toEqual(validBody.audience);
    expect(res.body.data.personas).toEqual(mockPersonas);
  });

  it('returns 404 when no personas exist', async () => {
    authenticateAs('u1');
    mockAnalysisFindFirst.mockResolvedValue({ results: {} });

    const res = await request(app).get(`/api/analyses/${VALID_CUID}/personas`);

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NO_PERSONAS');
  });

  it('rejects if analysis not owned by user (404)', async () => {
    authenticateAs('u1');
    mockAnalysisFindFirst.mockResolvedValue(null);

    const res = await request(app).get(`/api/analyses/${VALID_CUID}/personas`);

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('ANALYSIS_NOT_FOUND');
  });

  it('returns reactions and summary when present', async () => {
    authenticateAs('u1');
    const mockReactions = [{ personaId: 'p1', initialReaction: 'Nice' }];
    const mockSummary = { actionabilityScore: 7 };
    mockAnalysisFindFirst.mockResolvedValue({
      results: {
        personaData: {
          audience: validBody.audience,
          personas: mockPersonas,
          reactions: mockReactions,
          summary: mockSummary,
        },
      },
    });

    const res = await request(app).get(`/api/analyses/${VALID_CUID}/personas`);

    expect(res.status).toBe(200);
    expect(res.body.data.reactions).toEqual(mockReactions);
    expect(res.body.data.summary).toEqual(mockSummary);
  });
});

describe('POST /api/analyses/:analysisId/personas/reactions', () => {
  const mockReactions = [
    { personaId: 'p1', initialReaction: 'Eye-catching', actionLikelihood: 'would_click' },
    { personaId: 'p2', initialReaction: 'Interesting', actionLikelihood: 'might_click' },
  ];
  const mockSummary = { actionabilityScore: 7, overallVerdict: 'Good ad' };

  it('generates reactions and returns 201', async () => {
    authenticateAs('u1');
    mockAnalysisFindFirst.mockResolvedValue({
      id: VALID_CUID,
      status: 'COMPLETED',
      platform: 'META',
      results: { personaData: { audience: validBody.audience, personas: mockPersonas }, scoring: {} },
    });
    mockExtractAnalysisData.mockReturnValue({ overallScore: 7 });
    mockGenerateReactions.mockResolvedValue(mockReactions);
    mockGenerateReactionSummary.mockResolvedValue(mockSummary);
    mockAnalysisUpdate.mockResolvedValue({});

    const res = await request(app)
      .post(`/api/analyses/${VALID_CUID}/personas/reactions`);

    expect(res.status).toBe(201);
    expect(res.body.data.reactions).toEqual(mockReactions);
    expect(res.body.data.summary).toEqual(mockSummary);
  });

  it('rejects if analysis not owned by user (404)', async () => {
    authenticateAs('u1');
    mockAnalysisFindFirst.mockResolvedValue(null);

    const res = await request(app)
      .post(`/api/analyses/${VALID_CUID}/personas/reactions`);

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('ANALYSIS_NOT_FOUND');
  });

  it('rejects if analysis not COMPLETED (400)', async () => {
    authenticateAs('u1');
    mockAnalysisFindFirst.mockResolvedValue({
      id: VALID_CUID,
      status: 'PROCESSING',
      results: null,
      platform: 'META',
    });

    const res = await request(app)
      .post(`/api/analyses/${VALID_CUID}/personas/reactions`);

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('ANALYSIS_NOT_COMPLETE');
  });

  it('rejects if no personas exist (404)', async () => {
    authenticateAs('u1');
    mockAnalysisFindFirst.mockResolvedValue({
      id: VALID_CUID,
      status: 'COMPLETED',
      platform: 'META',
      results: { scoring: {} },
    });

    const res = await request(app)
      .post(`/api/analyses/${VALID_CUID}/personas/reactions`);

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NO_PERSONAS');
  });

  it('stores reactions in personaData', async () => {
    authenticateAs('u1');
    const existingPersonaData = { audience: validBody.audience, personas: mockPersonas };
    mockAnalysisFindFirst.mockResolvedValue({
      id: VALID_CUID,
      status: 'COMPLETED',
      platform: 'META',
      results: { personaData: existingPersonaData, scoring: {} },
    });
    mockExtractAnalysisData.mockReturnValue({ overallScore: 7 });
    mockGenerateReactions.mockResolvedValue(mockReactions);
    mockGenerateReactionSummary.mockResolvedValue(mockSummary);
    mockAnalysisUpdate.mockResolvedValue({});

    await request(app)
      .post(`/api/analyses/${VALID_CUID}/personas/reactions`);

    expect(mockAnalysisUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          results: expect.objectContaining({
            personaData: expect.objectContaining({
              reactions: mockReactions,
              summary: mockSummary,
              reactionsGeneratedAt: expect.any(String),
            }),
          }),
        }),
      })
    );
  });

  it('validates analysisId param', async () => {
    authenticateAs('u1');

    const res = await request(app)
      .post('/api/analyses/not-valid-id/personas/reactions');

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('returns cached reactions when already generated', async () => {
    authenticateAs('u1');
    const existingReactions = [{ personaId: 'p1', initialReaction: 'Cached' }];
    const existingSummary = { actionabilityScore: 8 };
    mockAnalysisFindFirst.mockResolvedValue({
      id: VALID_CUID,
      status: 'COMPLETED',
      platform: 'META',
      results: {
        personaData: {
          audience: validBody.audience,
          personas: mockPersonas,
          reactions: existingReactions,
          summary: existingSummary,
        },
      },
    });

    const res = await request(app)
      .post(`/api/analyses/${VALID_CUID}/personas/reactions`);

    expect(res.status).toBe(200);
    expect(res.body.data.reactions).toEqual(existingReactions);
    expect(res.body.data.summary).toEqual(existingSummary);
    expect(mockGenerateReactions).not.toHaveBeenCalled();
  });
});
