import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockFfprobe } = vi.hoisted(() => {
  const mockFfprobe = vi.fn();
  return { mockFfprobe };
});

vi.mock('fluent-ffmpeg', () => ({
  default: { setFfprobePath: vi.fn(), ffprobe: mockFfprobe },
}));
vi.mock('@ffprobe-installer/ffprobe', () => ({ default: { path: '/mock/ffprobe' } }));
vi.mock('fs/promises', () => ({
  writeFile: vi.fn().mockResolvedValue(undefined),
  unlink: vi.fn().mockResolvedValue(undefined),
}));

import { getVideoDuration, validateVideoDuration } from './video.service.js';

describe('getVideoDuration', () => {
  beforeEach(() => {
    mockFfprobe.mockReset();
  });

  it('returns correct duration for valid video buffer', async () => {
    mockFfprobe.mockImplementation((_path: string, cb: Function) => {
      cb(null, { format: { duration: 30.5 } });
    });

    const duration = await getVideoDuration(Buffer.from('fake-video'));
    expect(duration).toBe(30.5);
  });

  it('rejects when ffprobe errors', async () => {
    mockFfprobe.mockImplementation((_path: string, cb: Function) => {
      cb(new Error('ffprobe failed'));
    });

    await expect(getVideoDuration(Buffer.from('bad'))).rejects.toThrow('Could not read video metadata');
  });

  it('rejects when duration is undefined', async () => {
    mockFfprobe.mockImplementation((_path: string, cb: Function) => {
      cb(null, { format: {} });
    });

    await expect(getVideoDuration(Buffer.from('no-duration'))).rejects.toThrow('Could not determine video duration');
  });
});

describe('validateVideoDuration', () => {
  beforeEach(() => {
    mockFfprobe.mockReset();
  });

  it('throws VIDEO_TOO_LONG for >60s video', async () => {
    mockFfprobe.mockImplementation((_path: string, cb: Function) => {
      cb(null, { format: { duration: 61 } });
    });

    await expect(validateVideoDuration(Buffer.from('long-video'))).rejects.toMatchObject({
      code: 'VIDEO_TOO_LONG',
      status: 400,
    });
  });

  it('passes for <=60s video', async () => {
    mockFfprobe.mockImplementation((_path: string, cb: Function) => {
      cb(null, { format: { duration: 59.9 } });
    });

    await expect(validateVideoDuration(Buffer.from('short-video'))).resolves.toBeUndefined();
  });

  it('passes for exactly 60s video', async () => {
    mockFfprobe.mockImplementation((_path: string, cb: Function) => {
      cb(null, { format: { duration: 60 } });
    });

    await expect(validateVideoDuration(Buffer.from('exact-video'))).resolves.toBeUndefined();
  });
});
