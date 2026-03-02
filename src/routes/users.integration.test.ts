import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import cors from 'cors';
import { toNodeHandler } from 'better-auth/node';
import { auth } from '../lib/auth.js';
import { prisma } from '../lib/prisma.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { errorHandler } from '../middleware/error-handler.js';
import { usersRouter } from './users.routes.js';

const TEST_EMAIL = 'profile-story16@example.com';
const TEST_PASSWORD = 'securepass123';

async function cleanupUserByEmail(email: string) {
  const user = await prisma.user.findUnique({ where: { email } });
  if (user) {
    await prisma.verification.deleteMany();
    await prisma.account.deleteMany({ where: { userId: user.id } });
    await prisma.session.deleteMany({ where: { userId: user.id } });
    await prisma.user.delete({ where: { id: user.id } });
  }
}

function createTestApp() {
  const testApp = express();
  testApp.use(cors({ origin: true, credentials: true }));
  testApp.all('/api/auth/*splat', toNodeHandler(auth));
  testApp.use(express.json());
  testApp.use('/api', usersRouter);
  // Admin-only test endpoint for requireRole integration testing
  testApp.get('/api/admin/test', requireAuth, requireRole('admin'), (_req, res) => {
    res.json({ data: { ok: true } });
  });
  testApp.use(errorHandler);
  return testApp;
}

const testApp = createTestApp();
let sessionCookie: string;

beforeAll(async () => {
  await cleanupUserByEmail(TEST_EMAIL);

  // Create test user via signup
  const signupRes = await request(testApp)
    .post('/api/auth/sign-up/email')
    .send({ name: 'Profile Test', email: TEST_EMAIL, password: TEST_PASSWORD });

  if (signupRes.status !== 200) {
    throw new Error(`Failed to create test user: ${signupRes.status} ${JSON.stringify(signupRes.body)}`);
  }

  // Login to get session cookie
  const loginRes = await request(testApp)
    .post('/api/auth/sign-in/email')
    .send({ email: TEST_EMAIL, password: TEST_PASSWORD });

  expect(loginRes.status).toBe(200);

  const cookies = loginRes.headers['set-cookie'];
  sessionCookie = Array.isArray(cookies) ? cookies.join('; ') : String(cookies);
});

afterAll(async () => {
  await cleanupUserByEmail(TEST_EMAIL);
});

describe('GET /api/users/me', () => {
  it('returns 200 with user profile including role (AC #1)', async () => {
    const res = await request(testApp)
      .get('/api/users/me')
      .set('Cookie', sessionCookie);

    expect(res.status).toBe(200);
    expect(res.body.data).toBeDefined();
    expect(res.body.data.id).toBeDefined();
    expect(res.body.data.email).toBe(TEST_EMAIL);
    expect(res.body.data.name).toBe('Profile Test');
    expect(res.body.data.role).toBe('member');
    expect(res.body.data.createdAt).toBeDefined();
    // image can be null
    expect('image' in res.body.data).toBe(true);
  });

  it('returns 401 UNAUTHORIZED without session cookie (AC #3)', async () => {
    const res = await request(testApp).get('/api/users/me');

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
  });
});

describe('PATCH /api/users/me', () => {
  it('returns 200 with updated user when name provided (AC #2)', async () => {
    const res = await request(testApp)
      .patch('/api/users/me')
      .set('Cookie', sessionCookie)
      .send({ name: 'Updated Name' });

    expect(res.status).toBe(200);
    expect(res.body.data.name).toBe('Updated Name');
    expect(res.body.data.email).toBe(TEST_EMAIL);
    expect(res.body.data.role).toBe('member');

    // Verify in DB
    const user = await prisma.user.findUnique({ where: { email: TEST_EMAIL } });
    expect(user!.name).toBe('Updated Name');
  });

  it('returns validation error with empty body (AC #2)', async () => {
    const res = await request(testApp)
      .patch('/api/users/me')
      .set('Cookie', sessionCookie)
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('returns 401 without session cookie (AC #3)', async () => {
    const res = await request(testApp)
      .patch('/api/users/me')
      .send({ name: 'Hacker' });

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
  });
});

describe('requireRole integration (AC #4)', () => {
  it('returns 403 FORBIDDEN when member accesses admin endpoint', async () => {
    const res = await request(testApp)
      .get('/api/admin/test')
      .set('Cookie', sessionCookie);

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
    expect(res.body.error.message).toBe('Insufficient permissions');
  });

  it('returns 200 when admin accesses admin endpoint', async () => {
    // Set user role to admin directly in DB
    const user = await prisma.user.findUnique({ where: { email: TEST_EMAIL } });
    await prisma.user.update({ where: { id: user!.id }, data: { role: 'admin' } });

    // Force fresh session by logging in again (bypasses cookie cache)
    const loginRes = await request(testApp)
      .post('/api/auth/sign-in/email')
      .send({ email: TEST_EMAIL, password: TEST_PASSWORD });
    const freshCookies = loginRes.headers['set-cookie'];
    const adminCookie = Array.isArray(freshCookies) ? freshCookies.join('; ') : String(freshCookies);

    const res = await request(testApp)
      .get('/api/admin/test')
      .set('Cookie', adminCookie);

    expect(res.status).toBe(200);
    expect(res.body.data.ok).toBe(true);

    // Restore member role
    await prisma.user.update({ where: { id: user!.id }, data: { role: 'member' } });
  });
});

// --- Story 1.7: Account Deletion (GDPR) ---

const DELETION_EMAIL = 'deletion-story17@example.com';
const DELETION_PASSWORD = 'securepass123';

function createDeletionTestApp() {
  const app = express();
  app.use(cors({ origin: true, credentials: true }));
  app.all('/api/auth/*splat', toNodeHandler(auth));
  app.use(express.json());
  app.use('/api', usersRouter);
  app.use(errorHandler);
  return app;
}

const deletionApp = createDeletionTestApp();

describe('DELETE /api/users/me (Story 1.7)', () => {
  let deletionCookie: string;
  let userId: string;

  beforeEach(async () => {
    await cleanupUserByEmail(DELETION_EMAIL);

    // Create test user
    const signupRes = await request(deletionApp)
      .post('/api/auth/sign-up/email')
      .send({ name: 'Deletion Test', email: DELETION_EMAIL, password: DELETION_PASSWORD });

    if (signupRes.status !== 200) {
      throw new Error(`Signup failed: ${signupRes.status} ${JSON.stringify(signupRes.body)}`);
    }

    // Login to get fresh session
    const loginRes = await request(deletionApp)
      .post('/api/auth/sign-in/email')
      .send({ email: DELETION_EMAIL, password: DELETION_PASSWORD });

    expect(loginRes.status).toBe(200);
    userId = loginRes.body.user.id;

    const cookies = loginRes.headers['set-cookie'];
    deletionCookie = Array.isArray(cookies) ? cookies.join('; ') : String(cookies);
  });

  afterAll(async () => {
    await cleanupUserByEmail(DELETION_EMAIL);
  });

  it('returns 200 with "Account deleted" message (AC #1)', async () => {
    const res = await request(deletionApp)
      .delete('/api/users/me')
      .set('Cookie', deletionCookie)
      .send({ password: DELETION_PASSWORD });

    expect(res.status).toBe(200);
    expect(res.body.data.message).toBe('Account deleted');
  });

  it('user record no longer exists after deletion (AC #1)', async () => {
    await request(deletionApp)
      .delete('/api/users/me')
      .set('Cookie', deletionCookie)
      .send({ password: DELETION_PASSWORD });

    const user = await prisma.user.findUnique({ where: { id: userId } });
    expect(user).toBeNull();
  });

  it('sessions no longer exist after deletion (AC #1)', async () => {
    await request(deletionApp)
      .delete('/api/users/me')
      .set('Cookie', deletionCookie)
      .send({ password: DELETION_PASSWORD });

    const sessions = await prisma.session.findMany({ where: { userId } });
    expect(sessions).toHaveLength(0);
  });

  it('accounts no longer exist after deletion (AC #1)', async () => {
    await request(deletionApp)
      .delete('/api/users/me')
      .set('Cookie', deletionCookie)
      .send({ password: DELETION_PASSWORD });

    const accounts = await prisma.account.findMany({ where: { userId } });
    expect(accounts).toHaveLength(0);
  });

  it('returns 401 without session cookie (AC #1)', async () => {
    const res = await request(deletionApp)
      .delete('/api/users/me');

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
  });

  it('returns 400 without password in body (AC #1)', async () => {
    const res = await request(deletionApp)
      .delete('/api/users/me')
      .set('Cookie', deletionCookie)
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('same session cookie returns 401 after deletion (AC #1)', async () => {
    await request(deletionApp)
      .delete('/api/users/me')
      .set('Cookie', deletionCookie)
      .send({ password: DELETION_PASSWORD });

    const res = await request(deletionApp)
      .get('/api/users/me')
      .set('Cookie', deletionCookie);

    // After deletion: session invalidated → 401, or cookie cache stale + user gone → 401
    expect(res.status).toBe(401);
    expect(res.body.data).toBeUndefined();
  });
});
