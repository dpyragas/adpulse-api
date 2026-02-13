import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import request from 'supertest';
import express from 'express';
import cors from 'cors';
import { toNodeHandler } from 'better-auth/node';
import { auth } from '../lib/auth.js';
import { prisma } from '../lib/prisma.js';
import { errorHandler } from '../middleware/error-handler.js';
import { analysisRouter } from './analysis.routes.js';
import { sendAnalysisMessage } from '../services/sqs.service.js';

// Mock S3 — do NOT call real AWS
vi.mock('../services/s3.service.js', () => ({
  uploadImage: vi.fn().mockResolvedValue('s3://test-bucket/test-key'),
  deleteImage: vi.fn().mockResolvedValue(undefined),
  getSignedImageUrl: vi.fn().mockRejectedValue(new Error('Not implemented')),
}));

// Mock SQS — do NOT call real AWS
vi.mock('../services/sqs.service.js', () => ({
  sendAnalysisMessage: vi.fn().mockResolvedValue('mock-message-id'),
}));

const TEST_EMAIL = 'analysis-story31@example.com';
const TEST_PASSWORD = 'securepass123';

// Minimal valid image buffers
// 1x1 PNG (smallest valid PNG)
const PNG_BUFFER = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64'
);

// 1x1 JPEG (smallest valid JPEG)
const JPG_BUFFER = Buffer.from(
  '/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////2wBDAf//////////////////////////////////////////////////////////////////////////////////////wAARCAABAAEDASIAAhEBAxEB/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/xAAUAQEAAAAAAAAAAAAAAAAAAAAA/8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAwDAQACEQMRAD8AKwA=',
  'base64'
);

// 1x1 WebP (smallest valid WebP)
const WEBP_BUFFER = Buffer.from(
  'UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEADsD+JaQAA3AAAAAA',
  'base64'
);

// 11MB buffer for oversized file test
const OVERSIZED_BUFFER = Buffer.alloc(11 * 1024 * 1024, 0);

// Small PDF-like buffer for unsupported format test
const PDF_BUFFER = Buffer.from('%PDF-1.4 fake pdf content');

async function cleanupUserByEmail(email: string) {
  const user = await prisma.user.findUnique({ where: { email } });
  if (user) {
    await prisma.analysis.deleteMany({ where: { userId: user.id } });
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
  testApp.use('/api', analysisRouter);
  testApp.use(errorHandler);
  return testApp;
}

const testApp = createTestApp();
let sessionCookie: string;
let userId: string;

beforeAll(async () => {
  await cleanupUserByEmail(TEST_EMAIL);

  // Create test user
  const signupRes = await request(testApp)
    .post('/api/auth/sign-up/email')
    .send({ name: 'Analysis Test', email: TEST_EMAIL, password: TEST_PASSWORD });

  if (signupRes.status !== 200) {
    throw new Error(`Signup failed: ${signupRes.status} ${JSON.stringify(signupRes.body)}`);
  }

  // Login to get session cookie
  const loginRes = await request(testApp)
    .post('/api/auth/sign-in/email')
    .send({ email: TEST_EMAIL, password: TEST_PASSWORD });

  expect(loginRes.status).toBe(200);
  userId = loginRes.body.user.id;

  const cookies = loginRes.headers['set-cookie'];
  sessionCookie = Array.isArray(cookies) ? cookies.join('; ') : String(cookies);
});

afterAll(async () => {
  await cleanupUserByEmail(TEST_EMAIL);
});

describe('POST /api/analyses', () => {
  beforeEach(() => {
    vi.mocked(sendAnalysisMessage).mockClear();
    vi.mocked(sendAnalysisMessage).mockResolvedValue('mock-message-id');
  });

  it('valid PNG upload → 201 + analysisId + PENDING status (AC #1)', async () => {
    const res = await request(testApp)
      .post('/api/analyses')
      .set('Cookie', sessionCookie)
      .attach('image', PNG_BUFFER, { filename: 'test.png', contentType: 'image/png' })
      .field('platform', 'meta');

    expect(res.status).toBe(201);
    expect(res.body.data).toBeDefined();
    expect(res.body.data.analysisId).toBeDefined();
    expect(res.body.data.status).toBe('PENDING');
  });

  it('valid JPG upload → 201 (AC #1)', async () => {
    const res = await request(testApp)
      .post('/api/analyses')
      .set('Cookie', sessionCookie)
      .attach('image', JPG_BUFFER, { filename: 'test.jpg', contentType: 'image/jpeg' })
      .field('platform', 'tiktok');

    expect(res.status).toBe(201);
    expect(res.body.data.analysisId).toBeDefined();
    expect(res.body.data.status).toBe('PENDING');
  });

  it('valid WebP upload → 201 (AC #1)', async () => {
    const res = await request(testApp)
      .post('/api/analyses')
      .set('Cookie', sessionCookie)
      .attach('image', WEBP_BUFFER, { filename: 'test.webp', contentType: 'image/webp' })
      .field('platform', 'linkedin');

    expect(res.status).toBe(201);
    expect(res.body.data.analysisId).toBeDefined();
    expect(res.body.data.status).toBe('PENDING');
  });

  it('unsupported format (PDF) → 400 UNSUPPORTED_FORMAT (AC #2)', async () => {
    const res = await request(testApp)
      .post('/api/analyses')
      .set('Cookie', sessionCookie)
      .attach('image', PDF_BUFFER, { filename: 'test.pdf', contentType: 'application/pdf' })
      .field('platform', 'meta');

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('UNSUPPORTED_FORMAT');
    expect(res.body.error.message).toBe('Supported: PNG, JPG, WebP');
  });

  it('file >10MB → 400 FILE_TOO_LARGE (AC #3)', async () => {
    const res = await request(testApp)
      .post('/api/analyses')
      .set('Cookie', sessionCookie)
      .attach('image', OVERSIZED_BUFFER, { filename: 'big.png', contentType: 'image/png' })
      .field('platform', 'meta');

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('FILE_TOO_LARGE');
    expect(res.body.error.message).toBe('Max 10MB');
  });

  it('no file attached → 400 FILE_REQUIRED', async () => {
    const res = await request(testApp)
      .post('/api/analyses')
      .set('Cookie', sessionCookie)
      .field('platform', 'meta');

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('FILE_REQUIRED');
  });

  it('no auth → 401 UNAUTHORIZED', async () => {
    const res = await request(testApp)
      .post('/api/analyses')
      .attach('image', PNG_BUFFER, { filename: 'test.png', contentType: 'image/png' })
      .field('platform', 'meta');

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
  });

  it('invalid platform value → 400 validation error', async () => {
    const res = await request(testApp)
      .post('/api/analyses')
      .set('Cookie', sessionCookie)
      .attach('image', PNG_BUFFER, { filename: 'test.png', contentType: 'image/png' })
      .field('platform', 'invalid_platform');

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('Analysis record has correct userId, platform, status, imageUrl (AC #4)', async () => {
    const res = await request(testApp)
      .post('/api/analyses')
      .set('Cookie', sessionCookie)
      .attach('image', PNG_BUFFER, { filename: 'test.png', contentType: 'image/png' })
      .field('platform', 'general');

    expect(res.status).toBe(201);

    const analysis = await prisma.analysis.findUnique({
      where: { id: res.body.data.analysisId },
    });

    expect(analysis).toBeDefined();
    expect(analysis!.userId).toBe(userId);
    expect(analysis!.platform).toBe('GENERAL');
    expect(analysis!.status).toBe('PENDING');
    expect(analysis!.imageUrl).toBe('s3://test-bucket/test-key');
  });

  it('SQS message sent after successful upload (AC #1 — enqueue)', async () => {
    const res = await request(testApp)
      .post('/api/analyses')
      .set('Cookie', sessionCookie)
      .attach('image', PNG_BUFFER, { filename: 'test.png', contentType: 'image/png' })
      .field('platform', 'meta');

    expect(res.status).toBe(201);
    expect(sendAnalysisMessage).toHaveBeenCalledWith(
      res.body.data.analysisId,
      's3://test-bucket/test-key',
      'META'
    );
  });

  it('SQS failure → 500 JOB_QUEUE_FAILED + analysis marked FAILED (AC #4)', async () => {
    vi.mocked(sendAnalysisMessage).mockRejectedValueOnce(new Error('SQS down'));

    const res = await request(testApp)
      .post('/api/analyses')
      .set('Cookie', sessionCookie)
      .attach('image', PNG_BUFFER, { filename: 'test.png', contentType: 'image/png' })
      .field('platform', 'meta');

    expect(res.status).toBe(500);
    expect(res.body.error.code).toBe('JOB_QUEUE_FAILED');

    // Verify analysis was marked FAILED in DB
    const analyses = await prisma.analysis.findMany({
      where: { userId, status: 'FAILED' },
      orderBy: { createdAt: 'desc' },
      take: 1,
    });
    expect(analyses.length).toBeGreaterThan(0);
    expect(analyses[0].status).toBe('FAILED');
  });
});
