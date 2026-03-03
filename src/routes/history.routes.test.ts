import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import request from 'supertest';
import express from 'express';
import cors from 'cors';
import { toNodeHandler } from 'better-auth/node';
import { auth } from '../lib/auth.js';
import { prisma } from '../lib/prisma.js';
import { errorHandler } from '../middleware/error-handler.js';
import { historyRouter } from './history.routes.js';

// Mock S3
vi.mock('../services/s3.service.js', () => ({
  getSignedImageUrl: vi.fn().mockImplementation((key: string) =>
    Promise.resolve(`https://signed.example.com/${key}`)
  ),
}));

const TEST_EMAIL = 'history-route-test@example.com';
const TEST_PASSWORD = 'securepass123';

function createTestApp() {
  const testApp = express();
  testApp.use(cors({ origin: true, credentials: true }));
  testApp.all('/api/auth/*splat', toNodeHandler(auth));
  testApp.use(express.json());
  testApp.use('/api', historyRouter);
  testApp.use(errorHandler);
  return testApp;
}

const testApp = createTestApp();
let sessionCookie: string;
let userId: string;

async function cleanupUser(email: string) {
  const user = await prisma.user.findUnique({ where: { email } });
  if (user) {
    await prisma.analysis.deleteMany({ where: { userId: user.id } });
    await prisma.account.deleteMany({ where: { userId: user.id } });
    await prisma.session.deleteMany({ where: { userId: user.id } });
    await prisma.user.delete({ where: { id: user.id } });
  }
}

beforeAll(async () => {
  await cleanupUser(TEST_EMAIL);

  // Create + login
  const signupRes = await request(testApp)
    .post('/api/auth/sign-up/email')
    .send({ name: 'History Test', email: TEST_EMAIL, password: TEST_PASSWORD });

  if (signupRes.status !== 200) {
    throw new Error(`Signup failed: ${signupRes.status} ${JSON.stringify(signupRes.body)}`);
  }

  const loginRes = await request(testApp)
    .post('/api/auth/sign-in/email')
    .send({ email: TEST_EMAIL, password: TEST_PASSWORD });

  expect(loginRes.status).toBe(200);
  userId = loginRes.body.user.id;

  const cookies = loginRes.headers['set-cookie'];
  sessionCookie = Array.isArray(cookies) ? cookies.join('; ') : String(cookies);

  // Seed some analyses
  await prisma.analysis.createMany({
    data: [
      { id: 'hrt-1', userId, platform: 'META', status: 'COMPLETED', imageUrl: 's3://b/img1.png', results: { scoring: { overallScore: 7.5, verdict: 'Good' } } },
      { id: 'hrt-2', userId, platform: 'TIKTOK', status: 'COMPLETED', imageUrl: 's3://b/img2.png', results: { scoring: { overallScore: 3.0, verdict: 'Needs Work' } } },
      { id: 'hrt-3', userId, platform: 'META', status: 'PENDING', imageUrl: 's3://b/img3.png' },
    ],
  });
});

afterAll(async () => {
  await prisma.analysis.deleteMany({ where: { id: { startsWith: 'hrt-' } } });
  await cleanupUser(TEST_EMAIL);
});

describe('GET /api/analyses', () => {
  it('returns 401 without auth (AC #1)', async () => {
    const res = await request(testApp).get('/api/analyses');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
  });

  it('returns paginated response shape (AC #1)', async () => {
    const res = await request(testApp)
      .get('/api/analyses')
      .set('Cookie', sessionCookie);

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('data');
    expect(res.body).toHaveProperty('pagination');
    expect(res.body.pagination).toHaveProperty('page');
    expect(res.body.pagination).toHaveProperty('pageSize');
    expect(res.body.pagination).toHaveProperty('total');
    expect(Array.isArray(res.body.data)).toBe(true);
  });

  it('defaults to page 1, pageSize 10 (AC #5)', async () => {
    const res = await request(testApp)
      .get('/api/analyses')
      .set('Cookie', sessionCookie);

    expect(res.body.pagination.page).toBe(1);
    expect(res.body.pagination.pageSize).toBe(10);
  });

  it('excludes PENDING by default (AC #6)', async () => {
    const res = await request(testApp)
      .get('/api/analyses')
      .set('Cookie', sessionCookie);

    const ids = res.body.data.map((a: { id: string }) => a.id);
    expect(ids).not.toContain('hrt-3');
  });

  it('validates bad pageSize → 400 (AC #2)', async () => {
    const res = await request(testApp)
      .get('/api/analyses?pageSize=7')
      .set('Cookie', sessionCookie);

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('validates bad platform → 400', async () => {
    const res = await request(testApp)
      .get('/api/analyses?platform=invalid')
      .set('Cookie', sessionCookie);

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('validates scoreMin > scoreMax → 400', async () => {
    const res = await request(testApp)
      .get('/api/analyses?scoreMin=8&scoreMax=3')
      .set('Cookie', sessionCookie);

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('returns empty result correctly (AC #5)', async () => {
    const res = await request(testApp)
      .get('/api/analyses?platform=linkedin')
      .set('Cookie', sessionCookie);

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([]);
    expect(res.body.pagination.total).toBe(0);
  });

  it('returns 400 for workspace=true (stubbed) (AC #4)', async () => {
    const res = await request(testApp)
      .get('/api/analyses?workspace=true')
      .set('Cookie', sessionCookie);

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('WORKSPACE_NOT_CONFIGURED');
  });

  it('summary items have correct shape — no results blob', async () => {
    const res = await request(testApp)
      .get('/api/analyses')
      .set('Cookie', sessionCookie);

    expect(res.body.data.length).toBeGreaterThan(0);
    const item = res.body.data[0];
    expect(item).toHaveProperty('id');
    expect(item).toHaveProperty('status');
    expect(item).toHaveProperty('platform');
    expect(item).toHaveProperty('imageUrl');
    expect(item).toHaveProperty('createdAt');
    expect(item).not.toHaveProperty('results');
  });
});
