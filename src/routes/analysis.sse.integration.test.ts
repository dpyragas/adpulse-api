import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import http from 'http';
import request from 'supertest';
import express from 'express';
import cors from 'cors';
import { toNodeHandler } from 'better-auth/node';
import { auth } from '../lib/auth.js';
import { prisma } from '../lib/prisma.js';
import { errorHandler } from '../middleware/error-handler.js';
import { analysisRouter } from './analysis.routes.js';

// Mock S3 + SQS — not used in SSE tests but needed by analysis.routes.ts imports
vi.mock('../services/s3.service.js', () => ({
  uploadImage: vi.fn().mockResolvedValue('s3://test-bucket/test-key'),
}));
vi.mock('../services/sqs.service.js', () => ({
  sendAnalysisMessage: vi.fn().mockResolvedValue('mock-message-id'),
}));

const TEST_EMAIL = 'sse-story36@example.com';
const TEST_PASSWORD = 'securepass123';
const OTHER_EMAIL = 'sse-other-story36@example.com';

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
let otherUserId: string;

beforeAll(async () => {
  await cleanupUserByEmail(TEST_EMAIL);
  await cleanupUserByEmail(OTHER_EMAIL);

  // Create test user
  const signupRes = await request(testApp)
    .post('/api/auth/sign-up/email')
    .send({ name: 'SSE Test', email: TEST_EMAIL, password: TEST_PASSWORD });
  if (signupRes.status !== 200) throw new Error(`Signup failed: ${signupRes.status}`);

  const loginRes = await request(testApp)
    .post('/api/auth/sign-in/email')
    .send({ email: TEST_EMAIL, password: TEST_PASSWORD });
  expect(loginRes.status).toBe(200);
  userId = loginRes.body.user.id;
  const cookies = loginRes.headers['set-cookie'];
  sessionCookie = Array.isArray(cookies) ? cookies.join('; ') : String(cookies);

  // Create second user for ownership tests
  const signup2 = await request(testApp)
    .post('/api/auth/sign-up/email')
    .send({ name: 'Other User', email: OTHER_EMAIL, password: TEST_PASSWORD });
  if (signup2.status !== 200) throw new Error(`Signup2 failed: ${signup2.status}`);
  const login2 = await request(testApp)
    .post('/api/auth/sign-in/email')
    .send({ email: OTHER_EMAIL, password: TEST_PASSWORD });
  otherUserId = login2.body.user.id;
});

afterAll(async () => {
  await cleanupUserByEmail(TEST_EMAIL);
  await cleanupUserByEmail(OTHER_EMAIL);
});

describe('GET /api/analyses/:id/stream (SSE)', () => {
  it('authenticated user connects to stream for own PROCESSING analysis → 200 with SSE headers (AC #1)', async () => {
    const analysis = await prisma.analysis.create({
      data: { userId, platform: 'META', imageUrl: 's3://test/img.png', status: 'PROCESSING' },
    });

    const { status, headers, data } = await new Promise<{ status: number; headers: http.IncomingHttpHeaders; data: string }>((resolve) => {
      request(testApp)
        .get(`/api/analyses/${analysis.id}/stream`)
        .set('Cookie', sessionCookie)
        .buffer(true)
        .parse((res, callback) => {
          const incoming = res as unknown as http.IncomingMessage;
          let chunks = '';
          incoming.on('data', (chunk: Buffer) => {
            chunks += chunk.toString();
            resolve({ status: incoming.statusCode ?? 0, headers: incoming.headers, data: chunks });
            incoming.destroy();
            callback(null, chunks);
          });
          incoming.on('error', () => { /* destroy triggers error, safe to ignore */ });
        })
        .end(() => { /* noop — response already handled via parse */ });
    });

    expect(status).toBe(200);
    expect(headers['content-type']).toBe('text/event-stream');
    expect(headers['cache-control']).toBe('no-cache');
    expect(headers['connection']).toBe('keep-alive');
    expect(headers['x-accel-buffering']).toBe('no');
    expect(data).toContain('event: progress');
    expect(data).toContain('"stage":0');
    expect(data).toContain('"label":"Queued..."');
  });

  it('unauthenticated request → 401 (AC #1)', async () => {
    const analysis = await prisma.analysis.create({
      data: { userId, platform: 'META', imageUrl: 's3://test/img.png', status: 'PROCESSING' },
    });

    const res = await request(testApp)
      .get(`/api/analyses/${analysis.id}/stream`);

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
  });

  it('analysis not found → 404 (AC #1)', async () => {
    const res = await request(testApp)
      .get('/api/analyses/nonexistent-id/stream')
      .set('Cookie', sessionCookie);

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('ANALYSIS_NOT_FOUND');
  });

  it('analysis belongs to different user → 404 (AC #1)', async () => {
    const analysis = await prisma.analysis.create({
      data: { userId: otherUserId, platform: 'META', imageUrl: 's3://test/img.png', status: 'PROCESSING' },
    });

    const res = await request(testApp)
      .get(`/api/analyses/${analysis.id}/stream`)
      .set('Cookie', sessionCookie);

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('ANALYSIS_NOT_FOUND');
  });

  it('already COMPLETED analysis → immediate complete event (AC #3)', async () => {
    const analysis = await prisma.analysis.create({
      data: { userId, platform: 'META', imageUrl: 's3://test/img.png', status: 'COMPLETED' },
    });

    const res = await request(testApp)
      .get(`/api/analyses/${analysis.id}/stream`)
      .set('Cookie', sessionCookie)
      .buffer(true)
      .parse((res, callback) => {
        let data = '';
        res.on('data', (chunk: Buffer) => { data += chunk.toString(); });
        res.on('end', () => callback(null, data));
      });

    expect(res.status).toBe(200);
    expect(res.body).toContain('event: complete');
    expect(res.body).toContain(`"analysisId":"${analysis.id}"`);
  });

  it('already FAILED analysis → immediate error event (AC #4)', async () => {
    const analysis = await prisma.analysis.create({
      data: { userId, platform: 'META', imageUrl: 's3://test/img.png', status: 'FAILED' },
    });

    const res = await request(testApp)
      .get(`/api/analyses/${analysis.id}/stream`)
      .set('Cookie', sessionCookie)
      .buffer(true)
      .parse((res, callback) => {
        let data = '';
        res.on('data', (chunk: Buffer) => { data += chunk.toString(); });
        res.on('end', () => callback(null, data));
      });

    expect(res.status).toBe(200);
    expect(res.body).toContain('event: error');
    expect(res.body).toContain('"code":"PROCESSING_FAILED"');
  });
});
