import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import express from 'express';
import { errorHandler } from '../middleware/error-handler.js';

const mockGetSharedAnalysis = vi.fn();

vi.mock('../services/share.service.js', () => ({
  getSharedAnalysis: (...args: unknown[]) => mockGetSharedAnalysis(...args),
}));

// Mock rate limiter to be a passthrough
vi.mock('../middleware/rate-limit.js', () => ({
  shareLimiter: (_req: unknown, _res: unknown, next: () => void) => next(),
}));

const { shareRouter } = await import('./share.routes.js');

function createTestApp() {
  const app = express();
  app.use(express.json());
  app.use('/api', shareRouter);
  app.use(errorHandler);
  return app;
}

let app: express.Express;

beforeEach(() => {
  vi.clearAllMocks();
  app = createTestApp();
});

describe('GET /api/share/:shareToken', () => {
  it('returns analysis without auth for valid token', async () => {
    mockGetSharedAnalysis.mockResolvedValue({
      analysis: {
        id: 'a1',
        platform: 'META',
        imageUrl: 'https://signed.example.com/img',
        results: { scoring: { overallScore: 8 } },
        createdAt: '2026-01-01T00:00:00.000Z',
      },
      branding: { ctaText: 'Try AdPulse Free', ctaUrl: '/signup' },
    });

    const res = await request(app).get('/api/share/abc123def456');

    expect(res.status).toBe(200);
    expect(res.body.data.analysis.id).toBe('a1');
    expect(res.body.data.branding.ctaText).toBe('Try AdPulse Free');
    expect(mockGetSharedAnalysis).toHaveBeenCalledWith('abc123def456');
  });

  it('returns 404 for invalid token format (too short)', async () => {
    const res = await request(app).get('/api/share/short');

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('SHARE_NOT_FOUND');
    expect(mockGetSharedAnalysis).not.toHaveBeenCalled();
  });

  it('returns 404 for invalid token format (special chars)', async () => {
    const res = await request(app).get('/api/share/abc!@#def456');

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('SHARE_NOT_FOUND');
  });

  it('returns 404 when service throws SHARE_NOT_FOUND', async () => {
    const { AppError } = await import('../lib/app-error.js');
    mockGetSharedAnalysis.mockRejectedValue(new AppError('SHARE_NOT_FOUND', 404, 'Shared analysis not found'));

    const res = await request(app).get('/api/share/abc123def456');

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('SHARE_NOT_FOUND');
  });
});
