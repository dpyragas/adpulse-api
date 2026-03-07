import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import express from 'express';
import { errorHandler } from '../middleware/error-handler.js';

const mockAnalysisFindFirst = vi.fn();
const mockFeedbackUpsert = vi.fn();
const mockFeedbackFindUnique = vi.fn();

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

vi.mock('../lib/prisma.js', () => ({
  prisma: {
    analysis: {
      findFirst: (...args: unknown[]) => mockAnalysisFindFirst(...args),
      findUnique: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    },
    feedback: {
      upsert: (...args: unknown[]) => mockFeedbackUpsert(...args),
      findUnique: (...args: unknown[]) => mockFeedbackFindUnique(...args),
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

let app: express.Express;

beforeEach(() => {
  vi.clearAllMocks();
  app = createTestApp();
});

describe('POST /api/analyses/:analysisId/feedback', () => {
  it('creates feedback record and returns feedbackId', async () => {
    authenticateAs('u1');
    mockAnalysisFindFirst.mockResolvedValue({ id: VALID_CUID, status: 'COMPLETED' });
    mockFeedbackUpsert.mockResolvedValue({ id: 'fb1' });

    const res = await request(app)
      .post(`/api/analyses/${VALID_CUID}/feedback`)
      .send({ rating: 'up' });

    expect(res.status).toBe(200);
    expect(res.body.data.feedbackId).toBe('fb1');
    expect(mockFeedbackUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { analysisId_userId: { analysisId: VALID_CUID, userId: 'u1' } },
        create: expect.objectContaining({ rating: 'UP' }),
        update: expect.objectContaining({ rating: 'UP' }),
      })
    );
  });

  it('upserts (updates existing feedback, no duplicate)', async () => {
    authenticateAs('u1');
    mockAnalysisFindFirst.mockResolvedValue({ id: VALID_CUID, status: 'COMPLETED' });
    mockFeedbackUpsert.mockResolvedValue({ id: 'fb1' });

    const res = await request(app)
      .post(`/api/analyses/${VALID_CUID}/feedback`)
      .send({ rating: 'down', comment: 'Not helpful' });

    expect(res.status).toBe(200);
    expect(mockFeedbackUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({ rating: 'DOWN', comment: 'Not helpful' }),
      })
    );
  });

  it('rejects if analysis not COMPLETED (400)', async () => {
    authenticateAs('u1');
    mockAnalysisFindFirst.mockResolvedValue({ id: VALID_CUID, status: 'PROCESSING' });

    const res = await request(app)
      .post(`/api/analyses/${VALID_CUID}/feedback`)
      .send({ rating: 'up' });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('ANALYSIS_NOT_COMPLETE');
  });

  it('rejects if analysis not owned by user (404)', async () => {
    authenticateAs('u1');
    mockAnalysisFindFirst.mockResolvedValue(null);

    const res = await request(app)
      .post(`/api/analyses/${VALID_CUID}/feedback`)
      .send({ rating: 'up' });

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('ANALYSIS_NOT_FOUND');
  });

  it('validates rating enum (rejects invalid values)', async () => {
    authenticateAs('u1');

    const res = await request(app)
      .post(`/api/analyses/${VALID_CUID}/feedback`)
      .send({ rating: 'maybe' });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('validates comment max length 500', async () => {
    authenticateAs('u1');

    const res = await request(app)
      .post(`/api/analyses/${VALID_CUID}/feedback`)
      .send({ rating: 'up', comment: 'x'.repeat(501) });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('accepts comment at exactly 500 chars', async () => {
    authenticateAs('u1');
    mockAnalysisFindFirst.mockResolvedValue({ id: VALID_CUID, status: 'COMPLETED' });
    mockFeedbackUpsert.mockResolvedValue({ id: 'fb1' });

    const res = await request(app)
      .post(`/api/analyses/${VALID_CUID}/feedback`)
      .send({ rating: 'up', comment: 'x'.repeat(500) });

    expect(res.status).toBe(200);
  });
});

describe('GET /api/analyses/:analysisId/feedback', () => {
  it('returns user feedback when it exists', async () => {
    authenticateAs('u1');
    mockAnalysisFindFirst.mockResolvedValue({ id: VALID_CUID });
    mockFeedbackFindUnique.mockResolvedValue({
      id: 'fb1',
      rating: 'UP',
      comment: 'Great',
      createdAt: '2026-01-01T00:00:00.000Z',
    });

    const res = await request(app).get(`/api/analyses/${VALID_CUID}/feedback`);

    expect(res.status).toBe(200);
    expect(res.body.data.feedback).toEqual({
      id: 'fb1',
      rating: 'UP',
      comment: 'Great',
      createdAt: '2026-01-01T00:00:00.000Z',
    });
  });

  it('returns null when no feedback exists', async () => {
    authenticateAs('u1');
    mockAnalysisFindFirst.mockResolvedValue({ id: VALID_CUID });
    mockFeedbackFindUnique.mockResolvedValue(null);

    const res = await request(app).get(`/api/analyses/${VALID_CUID}/feedback`);

    expect(res.status).toBe(200);
    expect(res.body.data.feedback).toBeNull();
  });

  it('rejects if analysis not owned by user (404)', async () => {
    authenticateAs('u1');
    mockAnalysisFindFirst.mockResolvedValue(null);

    const res = await request(app).get(`/api/analyses/${VALID_CUID}/feedback`);

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('ANALYSIS_NOT_FOUND');
  });
});
