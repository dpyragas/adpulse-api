import { describe, it, expect } from 'vitest';
import request from 'supertest';
import express from 'express';
import { AppError } from '../lib/app-error.js';
import { errorHandler } from './error-handler.js';

function createTestApp(handler: express.RequestHandler) {
  const app = express();
  app.get('/test', handler);
  app.use(errorHandler);
  return app;
}

describe('errorHandler middleware', () => {
  it('catches AppError and returns structured error response', async () => {
    const app = createTestApp((_req, _res) => {
      throw new AppError('VALIDATION_ERROR', 400, 'Bad input', {
        field: 'email',
      });
    });

    const res = await request(app).get('/test');

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(res.body.error.message).toBe('Bad input');
    expect(res.body.error.details).toEqual({ field: 'email' });
  });

  it('catches unknown errors and returns INTERNAL_ERROR', async () => {
    const app = createTestApp((_req, _res) => {
      throw new Error('something broke');
    });

    const res = await request(app).get('/test');

    expect(res.status).toBe(500);
    expect(res.body.error.code).toBe('INTERNAL_ERROR');
    expect(res.body.error.message).toBe('An unexpected error occurred');
  });

  it('handles async errors (Express 5 native)', async () => {
    const app = createTestApp(async (_req, _res) => {
      throw new AppError('NOT_FOUND', 404, 'Resource not found');
    });

    const res = await request(app).get('/test');

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });
});
