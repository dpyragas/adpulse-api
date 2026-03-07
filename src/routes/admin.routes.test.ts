import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import express from 'express';
import { errorHandler } from '../middleware/error-handler.js';

const mockFeedbackFindMany = vi.fn();
const mockFeedbackCount = vi.fn();

vi.mock('../lib/prisma.js', () => ({
  prisma: {
    feedback: {
      findMany: (...args: unknown[]) => mockFeedbackFindMany(...args),
      count: (...args: unknown[]) => mockFeedbackCount(...args),
    },
  },
}));

vi.mock('../lib/logger.js', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));

const mockRequireAuth = vi.fn();
const mockRequireRole = vi.fn();

vi.mock('../middleware/auth.js', () => ({
  requireAuth: (req: unknown, res: unknown, next: () => void) => mockRequireAuth(req, res, next),
  requireRole: (role: string) => (req: unknown, res: unknown, next: () => void) => mockRequireRole(req, res, next, role),
}));

const { adminRouter } = await import('./admin.routes.js');
const { AppError } = await import('../lib/app-error.js');

function createTestApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/admin', adminRouter);
  app.use(errorHandler);
  return app;
}

function authenticateAsAdmin() {
  mockRequireAuth.mockImplementation((req: { user: { id: string; role: string } }, _res: unknown, next: () => void) => {
    req.user = { id: 'admin1', role: 'admin' };
    next();
  });
  mockRequireRole.mockImplementation((_req: unknown, _res: unknown, next: () => void) => {
    next();
  });
}

function authenticateAsMember() {
  mockRequireAuth.mockImplementation((req: { user: { id: string; role: string } }, _res: unknown, next: () => void) => {
    req.user = { id: 'u1', role: 'member' };
    next();
  });
  mockRequireRole.mockImplementation(() => {
    throw new AppError('FORBIDDEN', 403, 'Insufficient permissions');
  });
}

let app: express.Express;

beforeEach(() => {
  vi.clearAllMocks();
  app = createTestApp();
});

describe('GET /api/admin/feedback', () => {
  it('returns paginated feedback with analysis context', async () => {
    authenticateAsAdmin();
    mockFeedbackFindMany.mockResolvedValue([
      {
        id: 'fb1',
        rating: 'DOWN',
        comment: 'Bad prediction',
        createdAt: '2026-01-01T00:00:00.000Z',
        analysis: {
          id: 'a1',
          platform: 'META',
          createdAt: '2025-12-01T00:00:00.000Z',
          results: { overallScore: 4.2 },
        },
        user: { id: 'u1', name: 'Test User', email: 'test@example.com' },
      },
    ]);
    mockFeedbackCount.mockResolvedValue(1);

    const res = await request(app).get('/api/admin/feedback?rating=down&page=1');

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].analysis.overallScore).toBe(4.2);
    expect(res.body.data[0].analysis.id).toBe('a1');
    expect(res.body.data[0].user.email).toBe('test@example.com');
    expect(res.body.pagination).toEqual({ page: 1, pageSize: 20, total: 1 });
  });

  it('rejects non-admin users (403)', async () => {
    authenticateAsMember();

    const res = await request(app).get('/api/admin/feedback');

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
  });

  it('filters by rating query param', async () => {
    authenticateAsAdmin();
    mockFeedbackFindMany.mockResolvedValue([]);
    mockFeedbackCount.mockResolvedValue(0);

    await request(app).get('/api/admin/feedback?rating=up');

    expect(mockFeedbackFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { rating: 'UP' },
      })
    );
  });

  it('returns all feedback when no rating filter', async () => {
    authenticateAsAdmin();
    mockFeedbackFindMany.mockResolvedValue([]);
    mockFeedbackCount.mockResolvedValue(0);

    await request(app).get('/api/admin/feedback');

    expect(mockFeedbackFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {},
      })
    );
  });

  it('handles analysis with null results gracefully', async () => {
    authenticateAsAdmin();
    mockFeedbackFindMany.mockResolvedValue([
      {
        id: 'fb2',
        rating: 'UP',
        comment: null,
        createdAt: '2026-01-01T00:00:00.000Z',
        analysis: {
          id: 'a2',
          platform: 'TIKTOK',
          createdAt: '2025-12-01T00:00:00.000Z',
          results: null,
        },
        user: { id: 'u2', name: 'User 2', email: 'u2@example.com' },
      },
    ]);
    mockFeedbackCount.mockResolvedValue(1);

    const res = await request(app).get('/api/admin/feedback');

    expect(res.status).toBe(200);
    expect(res.body.data[0].analysis.overallScore).toBeNull();
  });
});
