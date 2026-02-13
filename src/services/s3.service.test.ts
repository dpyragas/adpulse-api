import { describe, it, expect, beforeEach } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { S3Client, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { Readable } from 'node:stream';
import { sdkStreamMixin } from '@smithy/util-stream';
import { downloadImage, uploadBuffer } from './s3.service.js';

const s3Mock = mockClient(S3Client);

beforeEach(() => {
  s3Mock.reset();
});

describe('downloadImage', () => {
  it('downloads image buffer from valid s3:// URL', async () => {
    const content = Buffer.from('fake-image-data');
    const stream = sdkStreamMixin(Readable.from([content]));
    s3Mock.on(GetObjectCommand).resolves({ Body: stream });

    const result = await downloadImage('s3://my-bucket/analyses/abc/image.png');

    expect(Buffer.isBuffer(result)).toBe(true);
    expect(result.toString()).toBe('fake-image-data');

    const call = s3Mock.commandCalls(GetObjectCommand)[0];
    expect(call.args[0].input).toEqual({
      Bucket: 'my-bucket',
      Key: 'analyses/abc/image.png',
    });
  });

  it('throws S3_INVALID_URL for malformed URL', async () => {
    await expect(downloadImage('https://bucket/key'))
      .rejects.toMatchObject({ code: 'S3_INVALID_URL', status: 400 });
  });

  it('throws S3_DOWNLOAD_FAILED on S3 error', async () => {
    s3Mock.on(GetObjectCommand).rejects(new Error('NoSuchKey'));

    await expect(downloadImage('s3://bucket/key'))
      .rejects.toMatchObject({ code: 'S3_DOWNLOAD_FAILED', status: 500 });
  });
});

describe('uploadBuffer', () => {
  it('uploads buffer and returns key', async () => {
    s3Mock.on(PutObjectCommand).resolves({});

    const key = await uploadBuffer(Buffer.from('png-data'), 'analyses/abc/heatmaps/heatmap.png', 'image/png');

    expect(key).toBe('analyses/abc/heatmaps/heatmap.png');

    const call = s3Mock.commandCalls(PutObjectCommand)[0];
    expect(call.args[0].input.Key).toBe('analyses/abc/heatmaps/heatmap.png');
    expect(call.args[0].input.ContentType).toBe('image/png');
  });

  it('throws S3_UPLOAD_FAILED on S3 error', async () => {
    s3Mock.on(PutObjectCommand).rejects(new Error('Access denied'));

    await expect(uploadBuffer(Buffer.from('data'), 'key', 'image/png'))
      .rejects.toMatchObject({ code: 'S3_UPLOAD_FAILED', status: 500 });
  });
});
