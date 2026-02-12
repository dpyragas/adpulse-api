import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import request from 'supertest';
import express from 'express';
import cors from 'cors';
import { toNodeHandler } from 'better-auth/node';
import { prisma } from '../lib/prisma.js';

// Mock email service before importing auth (which imports email.service)
vi.mock('../services/email.service.js', () => ({
  sendEmail: vi.fn().mockResolvedValue(undefined),
}));

// Import auth after mock is in place
const { auth } = await import('../lib/auth.js');
const { sendEmail } = await import('../services/email.service.js');

const mockedSendEmail = vi.mocked(sendEmail);

const RESET_EMAIL = 'reset-story15@example.com';
const RESET_PASSWORD = 'securepass123';
const NEW_PASSWORD = 'newsecurepass456';

function createTestApp() {
  const testApp = express();
  testApp.use(cors({ origin: true, credentials: true }));
  testApp.all('/api/auth/*splat', toNodeHandler(auth));
  testApp.use(express.json());
  return testApp;
}

const testApp = createTestApp();

async function cleanupTestUser() {
  const user = await prisma.user.findUnique({ where: { email: RESET_EMAIL } });
  if (user) {
    await prisma.verification.deleteMany();
    await prisma.account.deleteMany({ where: { userId: user.id } });
    await prisma.session.deleteMany({ where: { userId: user.id } });
    await prisma.user.delete({ where: { id: user.id } });
  }
}

/** Extract reset token from the mocked sendEmail call's text body */
function extractTokenFromMock(): string {
  const call = mockedSendEmail.mock.calls[0];
  if (!call) throw new Error('sendEmail was not called');
  const text = call[0].text;
  // URL format: http://localhost:3001/api/auth/reset-password/TOKEN?callbackURL=...
  const match = text.match(/\/reset-password\/([^?\s]+)/);
  if (!match) throw new Error(`Could not extract token from email text: ${text}`);
  return match[1];
}

beforeAll(async () => {
  await cleanupTestUser();

  // Create test user via signup
  const res = await request(testApp)
    .post('/api/auth/sign-up/email')
    .send({ name: 'Reset Test', email: RESET_EMAIL, password: RESET_PASSWORD });

  if (res.status !== 200) {
    throw new Error(`Failed to create test user: ${res.status} ${JSON.stringify(res.body)}`);
  }
});

afterAll(async () => {
  await cleanupTestUser();
});

describe('POST /api/auth/request-password-reset', () => {
  it('returns 200 for registered email (AC #1)', async () => {
    mockedSendEmail.mockClear();

    const res = await request(testApp)
      .post('/api/auth/request-password-reset')
      .send({ email: RESET_EMAIL });

    expect(res.status).toBe(200);

    // sendResetPassword callback fires via void — wait for async call
    await vi.waitFor(() => {
      expect(mockedSendEmail).toHaveBeenCalledWith(
        expect.objectContaining({
          to: RESET_EMAIL,
          subject: 'Reset your AdPulse password',
        })
      );
    });
  });

  it('returns 200 for unregistered email — no enumeration (AC #2)', async () => {
    mockedSendEmail.mockClear();
    await prisma.verification.deleteMany();

    const res = await request(testApp)
      .post('/api/auth/request-password-reset')
      .send({ email: 'nonexistent@example.com' });

    expect(res.status).toBe(200);

    // Wait to ensure async callback would have fired
    await new Promise((r) => setTimeout(r, 200));

    // Email should NOT have been sent for unregistered user
    expect(mockedSendEmail).not.toHaveBeenCalled();

    // No verification record should exist for unregistered email
    const verifications = await prisma.verification.findMany();
    expect(verifications).toHaveLength(0);
  });

  it('includes redirectTo in reset URL when provided (AC #1)', async () => {
    mockedSendEmail.mockClear();

    const redirectTo = 'http://localhost:3000/reset-password';
    const res = await request(testApp)
      .post('/api/auth/request-password-reset')
      .send({ email: RESET_EMAIL, redirectTo });

    expect(res.status).toBe(200);

    await vi.waitFor(() => {
      expect(mockedSendEmail).toHaveBeenCalled();
    });

    // Verify reset URL contains the callbackURL/redirectTo (URL-encoded)
    const call = mockedSendEmail.mock.calls[0];
    const text = call[0].text;
    expect(text).toContain('callbackURL=http%3A%2F%2Flocalhost%3A3000%2Freset-password');
  });
});

describe('POST /api/auth/reset-password', () => {
  it('resets password with valid token (AC #3)', async () => {
    mockedSendEmail.mockClear();

    // Request password reset to generate token
    await request(testApp)
      .post('/api/auth/request-password-reset')
      .send({ email: RESET_EMAIL });

    await vi.waitFor(() => {
      expect(mockedSendEmail).toHaveBeenCalled();
    });

    // Extract token from the mocked sendEmail call
    const token = extractTokenFromMock();

    const res = await request(testApp)
      .post('/api/auth/reset-password')
      .send({ newPassword: NEW_PASSWORD, token });

    expect(res.status).toBe(200);
  });

  it('returns error for invalid token (AC #4)', async () => {
    const res = await request(testApp)
      .post('/api/auth/reset-password')
      .send({ newPassword: NEW_PASSWORD, token: 'invalid-token-abc123' });

    expect(res.status).toBeGreaterThanOrEqual(400);
    // Verify it's not a success response
    expect(res.body).not.toHaveProperty('user');
  });

  it('allows login with new password after reset (AC #3)', async () => {
    const res = await request(testApp)
      .post('/api/auth/sign-in/email')
      .send({ email: RESET_EMAIL, password: NEW_PASSWORD });

    expect(res.status).toBe(200);
    expect(res.body.user).toBeDefined();
    expect(res.body.user.email).toBe(RESET_EMAIL);
  });

  it('rejects login with old password after reset (AC #3)', async () => {
    const res = await request(testApp)
      .post('/api/auth/sign-in/email')
      .send({ email: RESET_EMAIL, password: RESET_PASSWORD });

    expect(res.status).toBeGreaterThanOrEqual(400);
  });
});
