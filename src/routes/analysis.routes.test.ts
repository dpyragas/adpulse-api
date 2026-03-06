import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import express from 'express';
import { errorHandler } from '../middleware/error-handler.js';

const mockGenerateShareToken = vi.fn();
const mockRevokeShareToken = vi.fn();

vi.mock('../services/share.service.js', () => ({
  generateShareToken: (...args: unknown[]) => mockGenerateShareToken(...args),
  revokeShareToken: (...args: unknown[]) => mockRevokeShareToken(...args),
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
      findFirst: vi.fn(),
      findUnique: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
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

// Mock requireAuth to attach a test user or reject
const mockRequireAuth = vi.fn();
vi.mock('../middleware/auth.js', () => ({
  requireAuth: (req: unknown, res: unknown, next: () => void) => mockRequireAuth(req, res, next),
}));

const { analysisRouter } = await import('./analysis.routes.js');
const { AppError } = await import('../lib/app-error.js');

function createTestApp() {
  const app = express();
  app.use(express.json());
  app.use('/api', analysisRouter);
  app.use(errorHandler);
  return app;
}

function authenticateAs(userId: string) {
  mockRequireAuth.mockImplementation((req: { user: { id: string } }, _res: unknown, next: () => void) => {
    req.user = { id: userId } as { id: string };
    next();
  });
}

function rejectAuth() {
  mockRequireAuth.mockImplementation(() => {
    throw new AppError('UNAUTHORIZED', 401, 'Authentication required');
  });
}

let app: express.Express;

beforeEach(() => {
  vi.clearAllMocks();
  app = createTestApp();
});

describe('POST /api/analyses/:analysisId/share', () => {
  it('creates share token for authenticated user', async () => {
    authenticateAs('u1');
    mockGenerateShareToken.mockResolvedValue({ shareUrl: 'http://localhost:3000/share/abc123def456' });

    const res = await request(app).post('/api/analyses/clxxxxxxxxxxxxxxxxxxxxxxxxx/share');

    expect(res.status).toBe(200);
    expect(res.body.data.shareUrl).toBe('http://localhost:3000/share/abc123def456');
    expect(mockGenerateShareToken).toHaveBeenCalledWith('clxxxxxxxxxxxxxxxxxxxxxxxxx', 'u1');
  });

  it('returns existing token on repeat call (idempotent)', async () => {
    authenticateAs('u1');
    mockGenerateShareToken.mockResolvedValue({ shareUrl: 'http://localhost:3000/share/existing12tk' });

    const res = await request(app).post('/api/analyses/clxxxxxxxxxxxxxxxxxxxxxxxxx/share');

    expect(res.status).toBe(200);
    expect(res.body.data.shareUrl).toContain('existing12tk');
  });

  it('returns 401 when not authenticated', async () => {
    rejectAuth();

    const res = await request(app).post('/api/analyses/clxxxxxxxxxxxxxxxxxxxxxxxxx/share');

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
    expect(mockGenerateShareToken).not.toHaveBeenCalled();
  });

  it('returns 404 for non-owner (service throws)', async () => {
    authenticateAs('u2');
    mockGenerateShareToken.mockRejectedValue(new AppError('ANALYSIS_NOT_FOUND', 404, 'Analysis not found'));

    const res = await request(app).post('/api/analyses/clxxxxxxxxxxxxxxxxxxxxxxxxx/share');

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('ANALYSIS_NOT_FOUND');
  });

  it('returns 404 for invalid analysisId format', async () => {
    authenticateAs('u1');

    const res = await request(app).post('/api/analyses/not-a-valid-id/share');

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('ANALYSIS_NOT_FOUND');
    expect(mockGenerateShareToken).not.toHaveBeenCalled();
  });
});

describe('DELETE /api/analyses/:analysisId/share', () => {
  it('revokes share token for authenticated owner', async () => {
    authenticateAs('u1');
    mockRevokeShareToken.mockResolvedValue(undefined);

    const res = await request(app).delete('/api/analyses/clxxxxxxxxxxxxxxxxxxxxxxxxx/share');

    expect(res.status).toBe(200);
    expect(res.body.data.message).toBe('Share link revoked');
    expect(mockRevokeShareToken).toHaveBeenCalledWith('clxxxxxxxxxxxxxxxxxxxxxxxxx', 'u1');
  });

  it('returns 401 when not authenticated', async () => {
    rejectAuth();

    const res = await request(app).delete('/api/analyses/clxxxxxxxxxxxxxxxxxxxxxxxxx/share');

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
    expect(mockRevokeShareToken).not.toHaveBeenCalled();
  });

  it('returns 404 for non-owner (service throws)', async () => {
    authenticateAs('u2');
    mockRevokeShareToken.mockRejectedValue(new AppError('ANALYSIS_NOT_FOUND', 404, 'Analysis not found'));

    const res = await request(app).delete('/api/analyses/clxxxxxxxxxxxxxxxxxxxxxxxxx/share');

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('ANALYSIS_NOT_FOUND');
  });
});
