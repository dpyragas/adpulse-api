import ffmpeg from 'fluent-ffmpeg';
import ffprobeInstaller from '@ffprobe-installer/ffprobe';
import { writeFile, unlink } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import crypto from 'crypto';
import { AppError } from '../lib/app-error.js';
import { MAX_VIDEO_DURATION } from '../lib/constants.js';

ffmpeg.setFfprobePath(ffprobeInstaller.path);

export function getVideoDuration(buffer: Buffer): Promise<number> {
  return new Promise((resolve, reject) => {
    const tmpPath = join(tmpdir(), `adpulse-probe-${crypto.randomUUID()}`);

    writeFile(tmpPath, buffer)
      .then(() => {
        ffmpeg.ffprobe(tmpPath, (err, metadata) => {
          unlink(tmpPath).catch(() => {});
          if (err) {
            reject(new AppError('VIDEO_PROBE_FAILED', 400, 'Could not read video metadata'));
            return;
          }
          const duration = metadata.format.duration;
          if (typeof duration !== 'number') {
            reject(new AppError('VIDEO_PROBE_FAILED', 400, 'Could not determine video duration'));
            return;
          }
          resolve(duration);
        });
      })
      .catch(reject);
  });
}

export async function validateVideoDuration(buffer: Buffer, maxSeconds: number = MAX_VIDEO_DURATION): Promise<void> {
  const duration = await getVideoDuration(buffer);
  if (duration > maxSeconds) {
    throw new AppError('VIDEO_TOO_LONG', 400, `Max ${maxSeconds} seconds`);
  }
}
