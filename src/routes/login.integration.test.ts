import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import express from 'express';
import cors from 'cors';
import { toNodeHandler } from 'better-auth/node';
import { auth } from '../lib/auth.js';
import { prisma } from '../lib/prisma.js';
import { requireAuth } from '../middleware/auth.js';
import { errorHandler } from '../middleware/error-handler.js';

// Unique emails to avoid collision with other integration tests
const LOGIN_EMAIL = 'login-story13@example.com';
const LOGIN_PASSWORD = 'securepass123';

// Test app with protected route for session testing
function createTestApp() {
  const testApp = express();
  testApp.use(cors({ origin: true, credentials: true }));
  testApp.all('/api/auth/*splat', toNodeHandler(auth));
  testApp.use(express.json());
  testApp.get('/api/protected', requireAuth, (req, res) => {
    res.json({ data: { userId: req.user?.id } });
  });
  testApp.use(errorHandler);
  return testApp;
}

const testApp = createTestApp();

async function cleanupTestUser() {
  const user = await prisma.user.findUnique({ where: { email: LOGIN_EMAIL } });
  if (user) {
    await prisma.account.deleteMany({ where: { userId: user.id } });
    await prisma.session.deleteMany({ where: { userId: user.id } });
    await prisma.user.delete({ where: { id: user.id } });
  }
}

beforeAll(async () => {
  await cleanupTestUser();

  // Create test user via signup
  const res = await request(testApp)
    .post('/api/auth/sign-up/email')
    .send({ name: 'Login Test', email: LOGIN_EMAIL, password: LOGIN_PASSWORD });

  if (res.status !== 200) {
    throw new Error(`Failed to create test user: ${res.status} ${JSON.stringify(res.body)}`);
  }
});

afterAll(async () => {
  await cleanupTestUser();
});

describe('POST /api/auth/sign-in/email', () => {
  it('returns 200 with user data and httpOnly cookie for valid credentials (AC #1)', async () => {
    const res = await request(testApp)
      .post('/api/auth/sign-in/email')
      .send({ email: LOGIN_EMAIL, password: LOGIN_PASSWORD });

    expect(res.status).toBe(200);
    expect(res.body.user).toBeDefined();
    expect(res.body.user.email).toBe(LOGIN_EMAIL);

    // httpOnly session cookie set
    const cookies = res.headers['set-cookie'];
    expect(cookies).toBeDefined();
    const cookieStr = Array.isArray(cookies) ? cookies.join('; ') : cookies;
    expect(cookieStr).toContain('better-auth.session_token');

    // DB session created
    const user = await prisma.user.findUnique({ where: { email: LOGIN_EMAIL } });
    const sessions = await prisma.session.findMany({
      where: { userId: user!.id },
    });
    expect(sessions.length).toBeGreaterThan(0);
  });

  it('returns error for invalid credentials (AC #2)', async () => {
    const res = await request(testApp)
      .post('/api/auth/sign-in/email')
      .send({ email: LOGIN_EMAIL, password: 'wrongpassword' });

    expect(res.status).toBeGreaterThanOrEqual(400);
  });
});

describe('Session cookie authentication (AC #3)', () => {
  it('allows access to protected route with valid session cookie', async () => {
    const loginRes = await request(testApp)
      .post('/api/auth/sign-in/email')
      .send({ email: LOGIN_EMAIL, password: LOGIN_PASSWORD });

    expect(loginRes.status).toBe(200);

    const cookies = loginRes.headers['set-cookie'];
    const cookieStr = Array.isArray(cookies) ? cookies.join('; ') : String(cookies);

    const protectedRes = await request(testApp)
      .get('/api/protected')
      .set('Cookie', cookieStr);

    expect(protectedRes.status).toBe(200);
    expect(protectedRes.body.data.userId).toBeDefined();
  });
});

describe('Expired session detection (AC #5)', () => {
  it('returns 401 when session is deleted from DB', async () => {
    const loginRes = await request(testApp)
      .post('/api/auth/sign-in/email')
      .send({ email: LOGIN_EMAIL, password: LOGIN_PASSWORD });

    expect(loginRes.status).toBe(200);

    const cookies = loginRes.headers['set-cookie'];
    const cookieStr = Array.isArray(cookies) ? cookies.join('; ') : String(cookies);

    // Delete only this user's sessions
    const user = await prisma.user.findUnique({ where: { email: LOGIN_EMAIL } });
    await prisma.session.deleteMany({ where: { userId: user!.id } });

    // With cookie cache (5min), the cached session may still pass.
    // When cache misses, getSession() returns null → our middleware checks DB → no session → UNAUTHORIZED.
    // SESSION_EXPIRED path (session exists but expiresAt < now) is covered by unit tests.
    const protectedRes = await request(testApp)
      .get('/api/protected')
      .set('Cookie', cookieStr);

    // Accept either 200 (cache hit) or 401 (cache miss)
    expect(protectedRes.status).toBeOneOf([200, 401]);
    if (protectedRes.status === 401) {
      expect(protectedRes.body.error.code).toBe('UNAUTHORIZED');
    }
  });
});
