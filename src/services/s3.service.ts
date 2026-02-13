import { S3Client, PutObjectCommand, DeleteObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { AppError } from '../lib/app-error.js';
import { logger } from '../lib/logger.js';

const s3Client = new S3Client({ region: process.env.AWS_REGION! });
const BUCKET = process.env.S3_BUCKET_NAME!; // Validated at startup in index.ts

export async function uploadImage(
  buffer: Buffer,
  key: string,
  contentType: string
): Promise<string> {
  try {
    await s3Client.send(new PutObjectCommand({
      Bucket: BUCKET,
      Key: key,
      Body: buffer,
      ContentType: contentType,
      ServerSideEncryption: 'AES256',
    }));
    logger.info('Image uploaded to S3', { key });
    return `s3://${BUCKET}/${key}`;
  } catch (error) {
    logger.error('S3 upload failed', { key, error: String(error) });
    throw new AppError('S3_UPLOAD_FAILED', 500, 'Failed to upload image');
  }
}

// Placeholder for future use — will generate pre-signed download URLs
export async function getSignedImageUrl(_key: string): Promise<string> {
  // TODO: implement with @aws-sdk/s3-request-presigner when needed
  throw new AppError('NOT_IMPLEMENTED', 501, 'Signed URLs not yet implemented');
}

export async function deleteImage(key: string): Promise<void> {
  await s3Client.send(new DeleteObjectCommand({
    Bucket: BUCKET,
    Key: key,
  }));
  logger.info('Image deleted from S3', { key });
}

export async function downloadImage(s3Url: string): Promise<Buffer> {
  const match = s3Url.match(/^s3:\/\/([^/]+)\/(.+)$/);
  if (!match) {
    throw new AppError('S3_INVALID_URL', 400, `Invalid S3 URL: ${s3Url}`);
  }
  const [, bucket, key] = match;

  try {
    const response = await s3Client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    const bytes = await response.Body!.transformToByteArray();
    logger.info('Image downloaded from S3', { key });
    return Buffer.from(bytes);
  } catch (error) {
    logger.error('S3 download failed', { s3Url, error: String(error) });
    throw new AppError('S3_DOWNLOAD_FAILED', 500, 'Failed to download image from S3');
  }
}

export async function uploadBuffer(
  buffer: Buffer,
  key: string,
  contentType: string,
): Promise<string> {
  try {
    await s3Client.send(new PutObjectCommand({
      Bucket: BUCKET,
      Key: key,
      Body: buffer,
      ContentType: contentType,
    }));
    logger.info('Buffer uploaded to S3', { key });
    return key;
  } catch (error) {
    logger.error('S3 upload failed', { key, error: String(error) });
    throw new AppError('S3_UPLOAD_FAILED', 500, 'Failed to upload buffer to S3');
  }
}
