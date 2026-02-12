import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import { requireAuth } from './auth.js';
import { errorHandler } from './error-handler.js';

// Mock auth and prisma
vi.mock('../lib/auth.js', () => ({
  auth: {
    api: {
      getSession: vi.fn(),
    },
  },
}));

vi.mock('../lib/prisma.js', () => ({
  prisma: {
    session: {
      findFirst: vi.fn(),
    },
  },
}));

import { auth } from '../lib/auth.js';
import { prisma } from '../lib/prisma.js';

const mockedGetSession = vi.mocked(auth.api.getSession);
const mockedFindFirst = vi.mocked(prisma.session.findFirst);

function createProtectedApp() {
  const app = express();
  app.get('/protected', requireAuth, (_req, res) => {
    res.json({ data: { user: _req.user } });
  });
  app.use(errorHandler);
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('requireAuth middleware', () => {
  it('returns 401 UNAUTHORIZED without session cookie', async () => {
    mockedGetSession.mockResolvedValue(null);

    const app = createProtectedApp();
    const res = await request(app).get('/protected');

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
    expect(res.body.error.message).toBe('Authentication required');
  });

  it('returns 401 SESSION_EXPIRED for expired session cookie', async () => {
    mockedGetSession.mockResolvedValue(null);
    mockedFindFirst.mockResolvedValue({
      id: 'sess-1',
      token: 'test-token',
      expiresAt: new Date(Date.now() - 60000), // expired 1 min ago
      userId: 'user-1',
      ipAddress: null,
      userAgent: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const app = createProtectedApp();
    const res = await request(app)
      .get('/protected')
      .set('Cookie', 'better-auth.session_token=test-token');

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('SESSION_EXPIRED');
    expect(res.body.error.message).toBe('Session has expired');
    expect(mockedFindFirst).toHaveBeenCalledWith({ where: { token: 'test-token' } });
  });

  it('returns 401 UNAUTHORIZED for revoked session (not in DB)', async () => {
    mockedGetSession.mockResolvedValue(null);
    mockedFindFirst.mockResolvedValue(null);

    const app = createProtectedApp();
    const res = await request(app)
      .get('/protected')
      .set('Cookie', 'better-auth.session_token=deleted-token');

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
  });

  it('attaches user and session to req when valid', async () => {
    const mockUser = { id: 'user-1', email: 'test@example.com', name: 'Test' };
    const mockSession = { id: 'sess-1', expiresAt: new Date(), userId: 'user-1' };
    mockedGetSession.mockResolvedValue({ user: mockUser, session: mockSession } as never);

    const app = createProtectedApp();
    const res = await request(app).get('/protected');

    expect(res.status).toBe(200);
    expect(res.body.data.user.id).toBe('user-1');
  });
});
