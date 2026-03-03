import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import request from 'supertest';
import express from 'express';
import cors from 'cors';
import { toNodeHandler } from 'better-auth/node';
import { auth } from '../lib/auth.js';
import { prisma } from '../lib/prisma.js';
import { errorHandler } from '../middleware/error-handler.js';
import { reportRouter } from './reports.routes.js';
import { downloadImage } from '../services/s3.service.js';

// Mock S3
vi.mock('../services/s3.service.js', () => ({
  uploadImage: vi.fn().mockResolvedValue('s3://test-bucket/test-key'),
  downloadImage: vi.fn().mockResolvedValue(Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
    'base64'
  )),
  getSignedImageUrl: vi.fn().mockImplementation((key: string) => Promise.resolve(`https://signed.example.com/${key}`)),
  resolveS3Url: vi.fn().mockImplementation((s3UrlOrKey: string) => {
    const match = s3UrlOrKey.match(/^s3:\/\/([^/]+)\/(.+)$/);
    if (match) return { bucket: match[1], key: match[2] };
    return { bucket: 'test-bucket', key: s3UrlOrKey };
  }),
  deleteImage: vi.fn().mockResolvedValue(undefined),
}));

const TEST_EMAIL = 'report-test@example.com';
const TEST_PASSWORD = 'securepass123';
const OTHER_USER_ID = 'report-test-other-user';

const COMPLETED_RESULTS = {
  scoring: {
    overallScore: 7.5,
    verdict: 'Good',
    subScores: { attention: 8.0, branding: 7.0, message: 7.5, aesthetic: 7.0 },
    elements: [
      { type: 'branding', found: true, attentionPercent: 25.0 },
      { type: 'headline', found: true, attentionPercent: 35.0 },
      { type: 'cta', found: false, attentionPercent: 5.0 },
    ],
    issues: [
      { severity: 'warning', element: 'cta', message: 'CTA not found' },
    ],
    platformModifiers: { attention: 1.0, branding: 1.0, message: 1.0, aesthetic: 1.0 },
  },
  insights: {
    unavailable: false,
    working: ['Strong branding presence'],
    issues: ['Missing CTA'],
    recommendations: ['Add a clear call-to-action'],
    platformNotes: 'Meta ads typically need strong CTA placement.',
  },
  classification: {
    sentiment: { primary: 'joy', secondary: 'trust', scores: { joy: 0.8, trust: 0.6 } },
    category: { levels: [{ level: 1, label: 'Technology', confidence: 0.9 }] },
  },
  heatmaps: {
    heatmap: 'analyses/heatmap.png',
    overlay: 'analyses/overlay.png',
    grayscale: 'analyses/gray.png',
  },
};

function createTestApp() {
  const testApp = express();
  testApp.use(cors({ origin: true, credentials: true }));
  testApp.all('/api/auth/*splat', toNodeHandler(auth));
  testApp.use(express.json());
  testApp.use('/api', reportRouter);
  testApp.use(errorHandler);
  return testApp;
}

const testApp = createTestApp();
let sessionCookie: string;
let userId: string;

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

beforeAll(async () => {
  await cleanupUserByEmail(TEST_EMAIL);

  const signupRes = await request(testApp)
    .post('/api/auth/sign-up/email')
    .send({ name: 'Report Test', email: TEST_EMAIL, password: TEST_PASSWORD });

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

  // Create other user for ownership tests
  await prisma.user.upsert({
    where: { id: OTHER_USER_ID },
    update: {},
    create: { id: OTHER_USER_ID, name: 'Other User', email: 'report-other@example.com', emailVerified: true },
  });
});

afterAll(async () => {
  await prisma.analysis.deleteMany({ where: { userId: OTHER_USER_ID } });
  await prisma.user.deleteMany({ where: { id: OTHER_USER_ID } });
  await cleanupUserByEmail(TEST_EMAIL);
});

describe('GET /api/analyses/:analysisId/report', () => {
  it('returns 401 without auth (AC #1-5, auth required)', async () => {
    const res = await request(testApp)
      .get('/api/analyses/some-id/report');

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
  });

  it('returns 404 for non-existent analysis (AC #4)', async () => {
    const res = await request(testApp)
      .get('/api/analyses/clxxxxxxxxxxxxxxxxxxxxxxxxx/report')
      .set('Cookie', sessionCookie);

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('ANALYSIS_NOT_FOUND');
  });

  it('returns 404 for analysis owned by another user (AC #4)', async () => {
    const otherAnalysis = await prisma.analysis.create({
      data: { userId: OTHER_USER_ID, platform: 'META', imageUrl: 's3://bucket/other.png', status: 'COMPLETED', results: COMPLETED_RESULTS },
    });

    const res = await request(testApp)
      .get(`/api/analyses/${otherAnalysis.id}/report`)
      .set('Cookie', sessionCookie);

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('ANALYSIS_NOT_FOUND');
  });

  it('returns 404 for DELETED analysis (AC #5)', async () => {
    const analysis = await prisma.analysis.create({
      data: { userId, platform: 'META', imageUrl: 's3://bucket/del.png', status: 'DELETED', results: COMPLETED_RESULTS },
    });

    const res = await request(testApp)
      .get(`/api/analyses/${analysis.id}/report`)
      .set('Cookie', sessionCookie);

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('ANALYSIS_NOT_FOUND');
  });

  it('returns 400 ANALYSIS_NOT_COMPLETE for PENDING analysis (AC #3)', async () => {
    const analysis = await prisma.analysis.create({
      data: { userId, platform: 'META', imageUrl: 's3://bucket/pending.png', status: 'PENDING' },
    });

    const res = await request(testApp)
      .get(`/api/analyses/${analysis.id}/report`)
      .set('Cookie', sessionCookie);

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('ANALYSIS_NOT_COMPLETE');
  });

  it('returns 400 ANALYSIS_NOT_COMPLETE for PROCESSING analysis (AC #3)', async () => {
    const analysis = await prisma.analysis.create({
      data: { userId, platform: 'META', imageUrl: 's3://bucket/proc.png', status: 'PROCESSING' },
    });

    const res = await request(testApp)
      .get(`/api/analyses/${analysis.id}/report`)
      .set('Cookie', sessionCookie);

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('ANALYSIS_NOT_COMPLETE');
  });

  it('returns 400 ANALYSIS_NOT_COMPLETE for FAILED analysis (AC #3)', async () => {
    const analysis = await prisma.analysis.create({
      data: { userId, platform: 'META', imageUrl: 's3://bucket/failed.png', status: 'FAILED' },
    });

    const res = await request(testApp)
      .get(`/api/analyses/${analysis.id}/report`)
      .set('Cookie', sessionCookie);

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('ANALYSIS_NOT_COMPLETE');
  });

  it('returns 200 with Content-Type application/pdf and Content-Disposition for COMPLETED analysis (AC #1, #2)', async () => {
    const analysis = await prisma.analysis.create({
      data: { userId, platform: 'META', imageUrl: 's3://test-bucket/img.png', status: 'COMPLETED', results: COMPLETED_RESULTS },
    });

    const res = await request(testApp)
      .get(`/api/analyses/${analysis.id}/report`)
      .set('Cookie', sessionCookie)
      .buffer(true)
      .parse((res, callback) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => callback(null, Buffer.concat(chunks)));
      });

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('application/pdf');
    expect(res.headers['content-disposition']).toBe(`attachment; filename="adpulse-report-${analysis.id}.pdf"`);
    expect(res.headers['content-length']).toBeDefined();
  });

  it('response body is valid PDF (starts with %PDF-) (AC #1)', async () => {
    const analysis = await prisma.analysis.create({
      data: { userId, platform: 'TIKTOK', imageUrl: 's3://test-bucket/img2.png', status: 'COMPLETED', results: COMPLETED_RESULTS },
    });

    const res = await request(testApp)
      .get(`/api/analyses/${analysis.id}/report`)
      .set('Cookie', sessionCookie)
      .buffer(true)
      .parse((res, callback) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => callback(null, Buffer.concat(chunks)));
      });

    expect(res.status).toBe(200);
    const body = res.body as Buffer;
    const header = body.subarray(0, 5).toString('ascii');
    expect(header).toBe('%PDF-');
  });

  it('returns 500 S3_DOWNLOAD_FAILED when image download fails', async () => {
    const analysis = await prisma.analysis.create({
      data: { userId, platform: 'META', imageUrl: 's3://test-bucket/broken.png', status: 'COMPLETED', results: COMPLETED_RESULTS },
    });

    vi.mocked(downloadImage).mockRejectedValueOnce(new Error('S3 connection timeout'));

    const res = await request(testApp)
      .get(`/api/analyses/${analysis.id}/report`)
      .set('Cookie', sessionCookie);

    expect(res.status).toBe(500);
    expect(res.body.error.code).toBe('S3_DOWNLOAD_FAILED');
  });
});
