import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import request from 'supertest';
import express from 'express';
import cors from 'cors';
import { toNodeHandler } from 'better-auth/node';
import { auth } from '../lib/auth.js';
import { prisma } from '../lib/prisma.js';
import { errorHandler } from '../middleware/error-handler.js';
import { compareRouter } from './compare.routes.js';
import { sendAnalysisMessage } from '../services/sqs.service.js';

// Mock S3
vi.mock('../services/s3.service.js', () => ({
  uploadImage: vi.fn().mockResolvedValue('s3://test-bucket/test-key'),
  getSignedImageUrl: vi.fn().mockImplementation((key: string) => Promise.resolve(`https://signed.example.com/${key}`)),
  resolveS3Url: vi.fn().mockImplementation((s3UrlOrKey: string) => {
    const match = s3UrlOrKey.match(/^s3:\/\/([^/]+)\/(.+)$/);
    if (match) return { bucket: match[1], key: match[2] };
    return { bucket: 'test-bucket', key: s3UrlOrKey };
  }),
}));

// Mock SQS
vi.mock('../services/sqs.service.js', () => ({
  sendAnalysisMessage: vi.fn().mockResolvedValue('mock-message-id'),
}));

const TEST_EMAIL = 'compare-routes-test@example.com';
const TEST_PASSWORD = 'securepass123';

const PNG_BUFFER = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64'
);

async function cleanupUser(email: string) {
  const user = await prisma.user.findUnique({ where: { email } });
  if (user) {
    await prisma.usageRecord.deleteMany({ where: { userId: user.id } });
    await prisma.analysis.deleteMany({ where: { userId: user.id } });
    await prisma.compareJob.deleteMany({ where: { userId: user.id } });
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
  testApp.use('/api', compareRouter);
  testApp.use(errorHandler);
  return testApp;
}

let app: express.Express;
let cookies: string[];

beforeAll(async () => {
  await cleanupUser(TEST_EMAIL);
  app = createTestApp();

  // Register user
  await request(app)
    .post('/api/auth/sign-up/email')
    .send({ name: 'Compare Test', email: TEST_EMAIL, password: TEST_PASSWORD });

  // Upgrade to solo tier to allow 5-image tests
  const user = await prisma.user.findUnique({ where: { email: TEST_EMAIL } });
  if (user) {
    await prisma.user.update({ where: { id: user.id }, data: { tier: 'solo' } });
  }

  // Login
  const loginRes = await request(app)
    .post('/api/auth/sign-in/email')
    .send({ email: TEST_EMAIL, password: TEST_PASSWORD });

  cookies = loginRes.headers['set-cookie'] as unknown as string[];
});

afterAll(async () => {
  await cleanupUser(TEST_EMAIL);
});

beforeEach(async () => {
  // Clean compare jobs + analyses between tests
  const user = await prisma.user.findUnique({ where: { email: TEST_EMAIL } });
  if (user) {
    await prisma.usageRecord.deleteMany({ where: { userId: user.id } });
    await prisma.analysis.deleteMany({ where: { userId: user.id } });
    await prisma.compareJob.deleteMany({ where: { userId: user.id } });
  }
});

describe('POST /api/compare', () => {
  it('creates compare job with 2 images (AC #1)', async () => {
    const res = await request(app)
      .post('/api/compare')
      .set('Cookie', cookies)
      .field('platform', 'meta')
      .attach('images', PNG_BUFFER, 'img1.png')
      .attach('images', PNG_BUFFER, 'img2.png');

    expect(res.status).toBe(201);
    expect(res.body.data.compareId).toBeDefined();
    expect(res.body.data.analysisIds).toHaveLength(2);
    expect(res.body.data.status).toBe('PROCESSING');

    // Verify DB records
    const compareJob = await prisma.compareJob.findUnique({ where: { id: res.body.data.compareId } });
    expect(compareJob).toBeDefined();
    expect(compareJob!.status).toBe('PROCESSING');
    expect(compareJob!.platform).toBe('META');

    const analyses = await prisma.analysis.findMany({ where: { compareJobId: compareJob!.id } });
    expect(analyses).toHaveLength(2);
    expect(analyses.every((a) => a.status === 'PENDING')).toBe(true);
  });

  it('creates compare job with 5 images (AC #1)', async () => {
    const res = await request(app)
      .post('/api/compare')
      .set('Cookie', cookies)
      .field('platform', 'general')
      .attach('images', PNG_BUFFER, 'img1.png')
      .attach('images', PNG_BUFFER, 'img2.png')
      .attach('images', PNG_BUFFER, 'img3.png')
      .attach('images', PNG_BUFFER, 'img4.png')
      .attach('images', PNG_BUFFER, 'img5.png');

    expect(res.status).toBe(201);
    expect(res.body.data.analysisIds).toHaveLength(5);
  });

  it('rejects fewer than 2 images (AC #2)', async () => {
    const res = await request(app)
      .post('/api/compare')
      .set('Cookie', cookies)
      .field('platform', 'meta')
      .attach('images', PNG_BUFFER, 'img1.png');

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_COMPARE_COUNT');
    expect(res.body.error.message).toBe('Upload 2-5 images for comparison');
  });

  it('rejects no images (AC #2)', async () => {
    const res = await request(app)
      .post('/api/compare')
      .set('Cookie', cookies)
      .field('platform', 'meta');

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_COMPARE_COUNT');
  });

  it('rejects missing platform', async () => {
    const res = await request(app)
      .post('/api/compare')
      .set('Cookie', cookies)
      .attach('images', PNG_BUFFER, 'img1.png')
      .attach('images', PNG_BUFFER, 'img2.png');

    expect(res.status).toBe(400);
  });

  it('rejects invalid platform', async () => {
    const res = await request(app)
      .post('/api/compare')
      .set('Cookie', cookies)
      .field('platform', 'invalid')
      .attach('images', PNG_BUFFER, 'img1.png')
      .attach('images', PNG_BUFFER, 'img2.png');

    expect(res.status).toBe(400);
  });

  it('rejects more than 5 images (AC #2 — multer limit)', async () => {
    const res = await request(app)
      .post('/api/compare')
      .set('Cookie', cookies)
      .field('platform', 'meta')
      .attach('images', PNG_BUFFER, 'img1.png')
      .attach('images', PNG_BUFFER, 'img2.png')
      .attach('images', PNG_BUFFER, 'img3.png')
      .attach('images', PNG_BUFFER, 'img4.png')
      .attach('images', PNG_BUFFER, 'img5.png')
      .attach('images', PNG_BUFFER, 'img6.png');

    expect(res.status).toBe(400);
  });

  it('refunds quota and marks FAILED on SQS failure (AC #1 rollback)', async () => {
    const sqsMock = vi.mocked(sendAnalysisMessage);
    // Fail on the second SQS send
    sqsMock
      .mockResolvedValueOnce('msg-1')
      .mockRejectedValueOnce(new Error('SQS unavailable'));

    const res = await request(app)
      .post('/api/compare')
      .set('Cookie', cookies)
      .field('platform', 'meta')
      .attach('images', PNG_BUFFER, 'img1.png')
      .attach('images', PNG_BUFFER, 'img2.png');

    expect(res.status).toBe(500);

    // Verify CompareJob is FAILED
    const user = await prisma.user.findUnique({ where: { email: TEST_EMAIL } });
    const compareJobs = await prisma.compareJob.findMany({ where: { userId: user!.id } });
    expect(compareJobs).toHaveLength(1);
    expect(compareJobs[0].status).toBe('FAILED');

    // Verify analyses are FAILED
    const analyses = await prisma.analysis.findMany({ where: { userId: user!.id } });
    expect(analyses.every((a) => a.status === 'FAILED')).toBe(true);

    // Verify quota was refunded
    const records = await prisma.usageRecord.findMany({ where: { userId: user!.id } });
    expect(records.every((r) => r.refunded)).toBe(true);

    // Restore mock
    sqsMock.mockResolvedValue('mock-message-id');
  });

  it('requires authentication', async () => {
    const res = await request(app)
      .post('/api/compare')
      .field('platform', 'meta')
      .attach('images', PNG_BUFFER, 'img1.png')
      .attach('images', PNG_BUFFER, 'img2.png');

    expect(res.status).toBe(401);
  });
});

describe('GET /api/compare/:compareId', () => {
  it('returns compare details with variants (AC #6)', async () => {
    // Create compare job first
    const createRes = await request(app)
      .post('/api/compare')
      .set('Cookie', cookies)
      .field('platform', 'meta')
      .attach('images', PNG_BUFFER, 'img1.png')
      .attach('images', PNG_BUFFER, 'img2.png');

    const { compareId } = createRes.body.data;

    const res = await request(app)
      .get(`/api/compare/${compareId}`)
      .set('Cookie', cookies);

    expect(res.status).toBe(200);
    expect(res.body.data.compareId).toBe(compareId);
    expect(res.body.data.status).toBe('PROCESSING');
    expect(res.body.data.variants).toHaveLength(2);
    expect(res.body.data.analysisIds).toHaveLength(2);
    expect(res.body.data.platform).toBe('META');
  });

  it('returns 404 for non-existent compareId', async () => {
    const res = await request(app)
      .get('/api/compare/clxxxxxxxxxxxxxxxxxxxxxxxxx')
      .set('Cookie', cookies);

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('COMPARE_NOT_FOUND');
  });
});

describe('GET /api/compare (list)', () => {
  it('returns paginated list of compare jobs (AC #6)', async () => {
    // Create 2 compare jobs
    await request(app)
      .post('/api/compare')
      .set('Cookie', cookies)
      .field('platform', 'meta')
      .attach('images', PNG_BUFFER, 'img1.png')
      .attach('images', PNG_BUFFER, 'img2.png');

    await request(app)
      .post('/api/compare')
      .set('Cookie', cookies)
      .field('platform', 'tiktok')
      .attach('images', PNG_BUFFER, 'img1.png')
      .attach('images', PNG_BUFFER, 'img2.png')
      .attach('images', PNG_BUFFER, 'img3.png');

    const res = await request(app)
      .get('/api/compare')
      .set('Cookie', cookies);

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(2);
    expect(res.body.pagination).toEqual({ page: 1, pageSize: 10, total: 2 });
    expect(res.body.data[0].variantCount).toBeDefined();
  });
});
