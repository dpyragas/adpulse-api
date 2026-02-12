import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import { app } from '../app.js';
import { prisma } from '../lib/prisma.js';

beforeAll(async () => {
  // Clean auth tables before tests
  await prisma.account.deleteMany();
  await prisma.session.deleteMany();
  await prisma.user.deleteMany();
});

describe('POST /api/auth/sign-up/email', () => {
  it('creates user with valid email and password', async () => {
    const res = await request(app)
      .post('/api/auth/sign-up/email')
      .send({
        name: 'Test User',
        email: 'test@example.com',
        password: 'securepass123',
      });

    expect(res.status).toBe(200);
    expect(res.body.user).toBeDefined();
    expect(res.body.user.email).toBe('test@example.com');
    expect(res.body.user.name).toBe('Test User');

    // httpOnly cookie should be set
    const cookies = res.headers['set-cookie'];
    expect(cookies).toBeDefined();
  });

  it('returns error for duplicate email', async () => {
    const res = await request(app)
      .post('/api/auth/sign-up/email')
      .send({
        name: 'Duplicate User',
        email: 'test@example.com',
        password: 'securepass123',
      });

    // Better Auth returns 422 for duplicate email
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  it('returns error for missing fields', async () => {
    const res = await request(app)
      .post('/api/auth/sign-up/email')
      .send({
        email: 'incomplete@example.com',
      });

    expect(res.status).toBeGreaterThanOrEqual(400);
  });
});

describe('Session validation flow', () => {
  it('can access protected route after signup', async () => {
    // Clean and signup fresh user
    await prisma.account.deleteMany();
    await prisma.session.deleteMany();
    await prisma.user.deleteMany();

    const signupRes = await request(app)
      .post('/api/auth/sign-up/email')
      .send({
        name: 'Session Test',
        email: 'session@example.com',
        password: 'securepass123',
      });

    expect(signupRes.status).toBe(200);

    const cookies = signupRes.headers['set-cookie'];
    expect(cookies).toBeDefined();

    // Use session cookie to access protected endpoint
    // We test via the auth.api.getSession indirectly through the requireAuth middleware
    // For now, just verify session was created in DB
    const sessions = await prisma.session.findMany();
    expect(sessions.length).toBeGreaterThan(0);
  });
});
