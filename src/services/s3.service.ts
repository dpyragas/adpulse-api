import { S3Client, PutObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
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
