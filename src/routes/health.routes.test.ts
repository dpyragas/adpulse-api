import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { app } from '../app.js';

describe('GET /api/health', () => {
  it('returns 200 with status ok and timestamp', async () => {
    const res = await request(app).get('/api/health');

    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('ok');
    expect(res.body.data.timestamp).toBeDefined();
    expect(new Date(res.body.data.timestamp).toISOString()).toBe(
      res.body.data.timestamp
    );
  });
});
