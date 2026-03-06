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
import { deleteImage, resolveS3Url } from '../services/s3.service.js';
import { validateVideoDuration } from '../services/video.service.js';

// Mock S3 — do NOT call real AWS
vi.mock('../services/s3.service.js', () => ({
  uploadImage: vi.fn().mockResolvedValue('s3://test-bucket/test-key'),
  deleteImage: vi.fn().mockResolvedValue(undefined),
  getSignedImageUrl: vi.fn().mockImplementation((key: string) => Promise.resolve(`https://signed.example.com/${key}`)),
  resolveS3Url: vi.fn().mockImplementation((s3UrlOrKey: string) => {
    const match = s3UrlOrKey.match(/^s3:\/\/([^/]+)\/(.+)$/);
    if (match) return { bucket: match[1], key: match[2] };
    return { bucket: 'test-bucket', key: s3UrlOrKey };
  }),
}));

// Mock SQS — do NOT call real AWS
vi.mock('../services/sqs.service.js', () => ({
  sendAnalysisMessage: vi.fn().mockResolvedValue('mock-message-id'),
}));

// Mock video service — do NOT call real ffprobe
vi.mock('../services/video.service.js', () => ({
  validateVideoDuration: vi.fn().mockResolvedValue(undefined),
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
    await prisma.usageRecord.deleteMany({ where: { userId: user.id } });
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
  beforeEach(async () => {
    vi.mocked(sendAnalysisMessage).mockReset();
    vi.mocked(sendAnalysisMessage).mockResolvedValue('mock-message-id');
    await prisma.usageRecord.deleteMany({ where: { userId } });
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
      'META',
      'IMAGE'
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

// Minimal valid MP4 buffer (ftyp box header)
const MP4_BUFFER = Buffer.from(
  'AAAAIGZ0eXBpc29tAAACAGlzb21pc28yYXZjMW1wNDE=',
  'base64'
);

describe('POST /api/analyses?type=video', () => {
  beforeEach(async () => {
    vi.mocked(sendAnalysisMessage).mockReset();
    vi.mocked(sendAnalysisMessage).mockResolvedValue('mock-message-id');
    vi.mocked(validateVideoDuration).mockReset();
    vi.mocked(validateVideoDuration).mockResolvedValue(undefined);
    await prisma.usageRecord.deleteMany({ where: { userId } });
  });

  it('valid MP4 upload → 201 with mediaType VIDEO (AC #1)', async () => {
    const res = await request(testApp)
      .post('/api/analyses?type=video')
      .set('Cookie', sessionCookie)
      .attach('image', MP4_BUFFER, { filename: 'test.mp4', contentType: 'video/mp4' })
      .field('platform', 'meta');

    expect(res.status).toBe(201);
    expect(res.body.data.analysisId).toBeDefined();
    expect(res.body.data.status).toBe('PENDING');

    // Verify mediaType in DB
    const analysis = await prisma.analysis.findUnique({
      where: { id: res.body.data.analysisId },
    });
    expect(analysis!.mediaType).toBe('VIDEO');
  });

  it('valid MOV upload → 201 (AC #1)', async () => {
    const res = await request(testApp)
      .post('/api/analyses?type=video')
      .set('Cookie', sessionCookie)
      .attach('image', MP4_BUFFER, { filename: 'test.mov', contentType: 'video/quicktime' })
      .field('platform', 'tiktok');

    expect(res.status).toBe(201);
    expect(res.body.data.status).toBe('PENDING');
  });

  it('AVI file → 400 UNSUPPORTED_FORMAT (AC #3)', async () => {
    const res = await request(testApp)
      .post('/api/analyses?type=video')
      .set('Cookie', sessionCookie)
      .attach('image', Buffer.from('fake-avi'), { filename: 'test.avi', contentType: 'video/x-msvideo' })
      .field('platform', 'meta');

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('UNSUPPORTED_FORMAT');
    expect(res.body.error.message).toBe('Supported: MP4, MOV');
  });

  it('>60s video → 400 VIDEO_TOO_LONG (AC #2)', async () => {
    const { AppError } = await import('../lib/app-error.js');
    vi.mocked(validateVideoDuration).mockRejectedValueOnce(
      new AppError('VIDEO_TOO_LONG', 400, 'Max 60 seconds')
    );

    const res = await request(testApp)
      .post('/api/analyses?type=video')
      .set('Cookie', sessionCookie)
      .attach('image', MP4_BUFFER, { filename: 'long.mp4', contentType: 'video/mp4' })
      .field('platform', 'meta');

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VIDEO_TOO_LONG');
  });

  it('SQS message includes mediaType field (AC #6)', async () => {
    const res = await request(testApp)
      .post('/api/analyses?type=video')
      .set('Cookie', sessionCookie)
      .attach('image', MP4_BUFFER, { filename: 'test.mp4', contentType: 'video/mp4' })
      .field('platform', 'meta');

    expect(res.status).toBe(201);
    expect(sendAnalysisMessage).toHaveBeenCalledWith(
      res.body.data.analysisId,
      's3://test-bucket/test-key',
      'META',
      'VIDEO'
    );
  });
});

describe('POST /api/analyses backward compatibility (AC #8)', () => {
  beforeEach(async () => {
    vi.mocked(sendAnalysisMessage).mockReset();
    vi.mocked(sendAnalysisMessage).mockResolvedValue('mock-message-id');
    await prisma.usageRecord.deleteMany({ where: { userId } });
  });

  it('image upload without ?type param → works with mediaType IMAGE', async () => {
    const res = await request(testApp)
      .post('/api/analyses')
      .set('Cookie', sessionCookie)
      .attach('image', PNG_BUFFER, { filename: 'test.png', contentType: 'image/png' })
      .field('platform', 'meta');

    expect(res.status).toBe(201);

    const analysis = await prisma.analysis.findUnique({
      where: { id: res.body.data.analysisId },
    });
    expect(analysis!.mediaType).toBe('IMAGE');

    expect(sendAnalysisMessage).toHaveBeenCalledWith(
      res.body.data.analysisId,
      's3://test-bucket/test-key',
      'META',
      'IMAGE'
    );
  });
});

describe('GET /api/analyses/:analysisId', () => {
  let analysisId: string;

  beforeAll(async () => {
    await prisma.usageRecord.deleteMany({ where: { userId } });
    // Create a PENDING analysis for tests
    const res = await request(testApp)
      .post('/api/analyses')
      .set('Cookie', sessionCookie)
      .attach('image', PNG_BUFFER, { filename: 'test.png', contentType: 'image/png' })
      .field('platform', 'meta');
    analysisId = res.body.data.analysisId;
  });

  it('returns analysis with signed imageUrl for PENDING status', async () => {
    const res = await request(testApp)
      .get(`/api/analyses/${analysisId}`)
      .set('Cookie', sessionCookie);

    expect(res.status).toBe(200);
    expect(res.body.data.id).toBe(analysisId);
    expect(res.body.data.status).toBe('PENDING');
    expect(res.body.data.imageUrl).toContain('https://signed.example.com/');
    expect(res.body.data.results).toBeNull();
    expect(res.body.data.platform).toBe('META');
    expect(res.body.data.createdAt).toBeDefined();
  });

  it('returns COMPLETED analysis with signed heatmap URLs', async () => {
    // Update analysis to COMPLETED with results
    await prisma.analysis.update({
      where: { id: analysisId },
      data: {
        status: 'COMPLETED',
        results: {
          heatmaps: { heatmap: 'analyses/heatmap.png', overlay: 'analyses/overlay.png', grayscale: 'analyses/gray.png' },
          scoring: null,
          insights: null,
          classification: null,
          imageSize: { width: 800, height: 600 },
        },
      },
    });

    const res = await request(testApp)
      .get(`/api/analyses/${analysisId}`)
      .set('Cookie', sessionCookie);

    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('COMPLETED');
    expect(res.body.data.results).toBeDefined();
    expect(res.body.data.results.heatmaps.heatmap).toContain('https://signed.example.com/');
    expect(res.body.data.results.heatmaps.overlay).toContain('https://signed.example.com/');
    expect(res.body.data.results.heatmaps.grayscale).toBeUndefined();
  });

  it('returns PROCESSING analysis with null results and signed imageUrl', async () => {
    await prisma.analysis.update({
      where: { id: analysisId },
      data: { status: 'PROCESSING' },
    });

    const res = await request(testApp)
      .get(`/api/analyses/${analysisId}`)
      .set('Cookie', sessionCookie);

    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('PROCESSING');
    expect(res.body.data.results).toBeNull();
    expect(res.body.data.imageUrl).toContain('https://signed.example.com/');
  });

  it('returns FAILED analysis with null results and signed imageUrl', async () => {
    await prisma.analysis.update({
      where: { id: analysisId },
      data: { status: 'FAILED' },
    });

    const res = await request(testApp)
      .get(`/api/analyses/${analysisId}`)
      .set('Cookie', sessionCookie);

    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('FAILED');
    expect(res.body.data.results).toBeNull();
    expect(res.body.data.imageUrl).toContain('https://signed.example.com/');
  });

  it('returns 404 for non-existent analysis', async () => {
    const res = await request(testApp)
      .get('/api/analyses/non-existent-id')
      .set('Cookie', sessionCookie);

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('ANALYSIS_NOT_FOUND');
  });

  it('returns 401 without auth', async () => {
    const res = await request(testApp)
      .get(`/api/analyses/${analysisId}`);

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
  });
});

describe('DELETE /api/analyses/:analysisId', () => {
  const OTHER_USER_ID = 'delete-test-other-user';

  beforeAll(async () => {
    // Create a second user for ownership tests
    await prisma.user.upsert({
      where: { id: OTHER_USER_ID },
      update: {},
      create: { id: OTHER_USER_ID, name: 'Other User', email: 'delete-other@example.com', emailVerified: true },
    });
  });

  afterAll(async () => {
    await prisma.usageRecord.deleteMany({ where: { userId: OTHER_USER_ID } });
    await prisma.analysis.deleteMany({ where: { userId: OTHER_USER_ID } });
    await prisma.user.deleteMany({ where: { id: OTHER_USER_ID } });
  });

  beforeEach(() => {
    vi.mocked(deleteImage).mockClear();
    vi.mocked(resolveS3Url).mockClear();
  });

  it('returns 401 without auth (AC #5)', async () => {
    const res = await request(testApp)
      .delete('/api/analyses/some-id');

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
  });

  it('returns 404 for non-existent analysis (AC #2)', async () => {
    const res = await request(testApp)
      .delete('/api/analyses/clxxxxxxxxxxxxxxxxxxxxxxxxx')
      .set('Cookie', sessionCookie);

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('ANALYSIS_NOT_FOUND');
  });

  it('returns 404 for analysis owned by another user (AC #5)', async () => {
    const otherAnalysis = await prisma.analysis.create({
      data: { userId: OTHER_USER_ID, platform: 'META', imageUrl: 's3://bucket/other.png', status: 'COMPLETED' },
    });

    const res = await request(testApp)
      .delete(`/api/analyses/${otherAnalysis.id}`)
      .set('Cookie', sessionCookie);

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('ANALYSIS_NOT_FOUND');

    // Verify analysis not deleted
    const check = await prisma.analysis.findUnique({ where: { id: otherAnalysis.id } });
    expect(check!.status).toBe('COMPLETED');
  });

  it('returns 409 for PENDING analysis (AC #6)', async () => {
    const analysis = await prisma.analysis.create({
      data: { userId, platform: 'META', imageUrl: 's3://bucket/pending.png', status: 'PENDING' },
    });

    const res = await request(testApp)
      .delete(`/api/analyses/${analysis.id}`)
      .set('Cookie', sessionCookie);

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('ANALYSIS_IN_PROGRESS');
  });

  it('returns 409 for PROCESSING analysis (AC #6)', async () => {
    const analysis = await prisma.analysis.create({
      data: { userId, platform: 'META', imageUrl: 's3://bucket/processing.png', status: 'PROCESSING' },
    });

    const res = await request(testApp)
      .delete(`/api/analyses/${analysis.id}`)
      .set('Cookie', sessionCookie);

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('ANALYSIS_IN_PROGRESS');
  });

  it('returns 200 and sets status to DELETED for COMPLETED analysis (AC #3)', async () => {
    const analysis = await prisma.analysis.create({
      data: {
        userId,
        platform: 'META',
        imageUrl: 's3://test-bucket/analyses/img.png',
        status: 'COMPLETED',
        results: {
          heatmaps: { heatmap: 'analyses/heatmap.png', overlay: 'analyses/overlay.png', grayscale: 'analyses/gray.png' },
          scoring: { overallScore: 7.5, verdict: 'Good' },
        },
      },
    });

    const res = await request(testApp)
      .delete(`/api/analyses/${analysis.id}`)
      .set('Cookie', sessionCookie);

    expect(res.status).toBe(200);
    expect(res.body.data.message).toBe('Analysis deleted');

    // Verify status in DB
    const check = await prisma.analysis.findUnique({ where: { id: analysis.id } });
    expect(check!.status).toBe('DELETED');
  });

  it('returns 200 for FAILED analysis (AC #3)', async () => {
    const analysis = await prisma.analysis.create({
      data: { userId, platform: 'TIKTOK', imageUrl: 's3://test-bucket/analyses/failed.png', status: 'FAILED' },
    });

    const res = await request(testApp)
      .delete(`/api/analyses/${analysis.id}`)
      .set('Cookie', sessionCookie);

    expect(res.status).toBe(200);
    expect(res.body.data.message).toBe('Analysis deleted');

    const check = await prisma.analysis.findUnique({ where: { id: analysis.id } });
    expect(check!.status).toBe('DELETED');
  });

  it('GET /analyses/:id returns 404 for DELETED analysis (AC #3)', async () => {
    const analysis = await prisma.analysis.create({
      data: { userId, platform: 'META', imageUrl: 's3://test-bucket/analyses/del.png', status: 'COMPLETED' },
    });

    // Delete it
    await request(testApp)
      .delete(`/api/analyses/${analysis.id}`)
      .set('Cookie', sessionCookie);

    // GET should return 404
    const res = await request(testApp)
      .get(`/api/analyses/${analysis.id}`)
      .set('Cookie', sessionCookie);

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('ANALYSIS_NOT_FOUND');
  });

  it('S3 cleanup extracts correct keys from analysis record (AC #4)', async () => {
    const analysis = await prisma.analysis.create({
      data: {
        userId,
        platform: 'META',
        imageUrl: 's3://test-bucket/analyses/user1/img.png',
        status: 'COMPLETED',
        results: {
          heatmaps: { heatmap: 'analyses/user1/heat.png', overlay: 'analyses/user1/over.png', grayscale: 'analyses/user1/gray.png' },
        },
      },
    });

    await request(testApp)
      .delete(`/api/analyses/${analysis.id}`)
      .set('Cookie', sessionCookie);

    // Wait a tick for fire-and-forget to execute
    await new Promise((r) => setTimeout(r, 50));

    // resolveS3Url should be called for imageUrl + 3 heatmap keys
    expect(resolveS3Url).toHaveBeenCalledWith('s3://test-bucket/analyses/user1/img.png');
    expect(resolveS3Url).toHaveBeenCalledWith('analyses/user1/heat.png');
    expect(resolveS3Url).toHaveBeenCalledWith('analyses/user1/over.png');
    expect(resolveS3Url).toHaveBeenCalledWith('analyses/user1/gray.png');

    // deleteImage called 4 times (image + 3 heatmaps)
    expect(deleteImage).toHaveBeenCalledTimes(4);
  });
});

describe('POST /api/analyses quota check (Story 3.8 AC #2)', () => {
  beforeEach(async () => {
    vi.mocked(sendAnalysisMessage).mockReset();
    vi.mocked(sendAnalysisMessage).mockResolvedValue('mock-message-id');
    await prisma.usageRecord.deleteMany({ where: { userId } });
  });

  it('charges quota after successful analysis creation', async () => {
    const res = await request(testApp)
      .post('/api/analyses')
      .set('Cookie', sessionCookie)
      .attach('image', PNG_BUFFER, { filename: 'test.png', contentType: 'image/png' })
      .field('platform', 'meta');

    expect(res.status).toBe(201);

    const record = await prisma.usageRecord.findFirst({
      where: { analysisId: res.body.data.analysisId },
    });
    expect(record).toBeTruthy();
    expect(record!.credits).toBe(1);
  });

  it('returns 402 QUOTA_EXCEEDED when at limit', async () => {
    // Use up all 3 trial credits
    for (let i = 0; i < 3; i++) {
      const a = await prisma.analysis.create({
        data: { userId, platform: 'META', imageUrl: `s3://b/quota-${i}`, status: 'COMPLETED' },
      });
      await prisma.usageRecord.create({
        data: { userId, analysisId: a.id, credits: 1 },
      });
    }

    const res = await request(testApp)
      .post('/api/analyses')
      .set('Cookie', sessionCookie)
      .attach('image', PNG_BUFFER, { filename: 'test.png', contentType: 'image/png' })
      .field('platform', 'meta');

    expect(res.status).toBe(402);
    expect(res.body.error.code).toBe('QUOTA_EXCEEDED');
    expect(res.body.error.details.estimatedCredits).toBe(1);
    expect(res.body.error.details.used).toBe(3);
    expect(res.body.error.details.limit).toBe(3);
  });

  it('refunds quota when SQS fails', async () => {
    vi.mocked(sendAnalysisMessage).mockRejectedValueOnce(new Error('SQS down'));

    const res = await request(testApp)
      .post('/api/analyses')
      .set('Cookie', sessionCookie)
      .attach('image', PNG_BUFFER, { filename: 'test.png', contentType: 'image/png' })
      .field('platform', 'meta');

    expect(res.status).toBe(500);

    const records = await prisma.usageRecord.findMany({ where: { userId } });
    expect(records.length).toBe(1);
    expect(records[0].refunded).toBe(true);
  });
});

describe('POST /api/analyses/:id/retry (Story 3.8 AC #3)', () => {
  beforeEach(async () => {
    vi.mocked(sendAnalysisMessage).mockReset();
    vi.mocked(sendAnalysisMessage).mockResolvedValue('mock-message-id');
    await prisma.usageRecord.deleteMany({ where: { userId } });
  });

  it('retries a FAILED analysis → 200 + PENDING status', async () => {
    const analysis = await prisma.analysis.create({
      data: { userId, platform: 'META', imageUrl: 's3://b/retry.png', status: 'FAILED' },
    });

    const res = await request(testApp)
      .post(`/api/analyses/${analysis.id}/retry`)
      .set('Cookie', sessionCookie);

    expect(res.status).toBe(200);
    expect(res.body.data.analysisId).toBe(analysis.id);
    expect(res.body.data.status).toBe('PENDING');

    const updated = await prisma.analysis.findUnique({ where: { id: analysis.id } });
    expect(updated!.status).toBe('PENDING');
    expect(updated!.results).toBeNull();
  });

  it('returns 404 for non-existent analysis', async () => {
    const res = await request(testApp)
      .post('/api/analyses/clxxxxxxxxxxxxxxxxxxxxxxxxx/retry')
      .set('Cookie', sessionCookie);

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('ANALYSIS_NOT_FOUND');
  });

  it('returns 400 for non-FAILED analysis', async () => {
    const analysis = await prisma.analysis.create({
      data: { userId, platform: 'META', imageUrl: 's3://b/pending.png', status: 'COMPLETED' },
    });

    const res = await request(testApp)
      .post(`/api/analyses/${analysis.id}/retry`)
      .set('Cookie', sessionCookie);

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('ANALYSIS_NOT_FAILED');
  });

  it('returns 402 when quota exceeded on retry', async () => {
    // Use up all credits
    for (let i = 0; i < 3; i++) {
      const a = await prisma.analysis.create({
        data: { userId, platform: 'META', imageUrl: `s3://b/q-${i}`, status: 'COMPLETED' },
      });
      await prisma.usageRecord.create({
        data: { userId, analysisId: a.id, credits: 1 },
      });
    }

    const analysis = await prisma.analysis.create({
      data: { userId, platform: 'META', imageUrl: 's3://b/retry-quota.png', status: 'FAILED' },
    });

    const res = await request(testApp)
      .post(`/api/analyses/${analysis.id}/retry`)
      .set('Cookie', sessionCookie);

    expect(res.status).toBe(402);
    expect(res.body.error.code).toBe('QUOTA_EXCEEDED');
  });

  it('charges quota on successful retry', async () => {
    const analysis = await prisma.analysis.create({
      data: { userId, platform: 'META', imageUrl: 's3://b/retry-charge.png', status: 'FAILED' },
    });

    const res = await request(testApp)
      .post(`/api/analyses/${analysis.id}/retry`)
      .set('Cookie', sessionCookie);

    expect(res.status).toBe(200);

    const record = await prisma.usageRecord.findFirst({
      where: { analysisId: analysis.id },
    });
    expect(record).toBeTruthy();
    expect(record!.credits).toBe(1);
  });
});
