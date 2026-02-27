import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { S3Client, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { Readable } from 'node:stream';
import { sdkStreamMixin } from '@smithy/util-stream';
import { downloadImage, uploadBuffer, getSignedImageUrl, resolveS3Url } from './s3.service.js';

vi.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: vi.fn().mockResolvedValue('https://s3.amazonaws.com/signed-url'),
}));

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

describe('resolveS3Url', () => {
  it('parses s3:// URL into bucket and key', () => {
    const result = resolveS3Url('s3://my-bucket/analyses/abc/image.png');
    expect(result).toEqual({ bucket: 'my-bucket', key: 'analyses/abc/image.png' });
  });

  it('uses BUCKET env var for bare keys', () => {
    const result = resolveS3Url('analyses/abc/heatmaps/heatmap.png');
    expect(result.key).toBe('analyses/abc/heatmaps/heatmap.png');
    // bucket comes from S3_BUCKET_NAME env var
    expect(typeof result.bucket).toBe('string');
  });
});

describe('getSignedImageUrl', () => {
  it('returns signed URL for s3:// format', async () => {
    const url = await getSignedImageUrl('s3://my-bucket/analyses/abc/image.png');
    expect(url).toBe('https://s3.amazonaws.com/signed-url');
  });

  it('returns signed URL for bare key format', async () => {
    const url = await getSignedImageUrl('analyses/abc/heatmaps/heatmap.png');
    expect(url).toBe('https://s3.amazonaws.com/signed-url');
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
