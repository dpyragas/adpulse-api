import { describe, it, expect } from 'vitest';
import request from 'supertest';
import express from 'express';
import { uploadSingleVideo } from './upload.js';
import { errorHandler } from './error-handler.js';

function createApp() {
  const app = express();
  app.post('/upload-video', uploadSingleVideo, (_req, res) => {
    res.json({ ok: true, mimetype: _req.file?.mimetype });
  });
  app.use(errorHandler);
  return app;
}

const app = createApp();

describe('uploadSingleVideo MIME filter', () => {
  it('accepts video/mp4', async () => {
    const res = await request(app)
      .post('/upload-video')
      .attach('image', Buffer.from('fake-mp4'), { filename: 'test.mp4', contentType: 'video/mp4' });

    expect(res.status).toBe(200);
    expect(res.body.mimetype).toBe('video/mp4');
  });

  it('accepts video/quicktime (MOV)', async () => {
    const res = await request(app)
      .post('/upload-video')
      .attach('image', Buffer.from('fake-mov'), { filename: 'test.mov', contentType: 'video/quicktime' });

    expect(res.status).toBe(200);
    expect(res.body.mimetype).toBe('video/quicktime');
  });

  it('rejects video/x-msvideo (AVI)', async () => {
    const res = await request(app)
      .post('/upload-video')
      .attach('image', Buffer.from('fake-avi'), { filename: 'test.avi', contentType: 'video/x-msvideo' });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('UNSUPPORTED_FORMAT');
    expect(res.body.error.message).toBe('Supported: MP4, MOV');
  });

  it('rejects image/png', async () => {
    const res = await request(app)
      .post('/upload-video')
      .attach('image', Buffer.from('fake-png'), { filename: 'test.png', contentType: 'image/png' });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('UNSUPPORTED_FORMAT');
  });
});
