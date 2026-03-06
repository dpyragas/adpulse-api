import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
import { AppError } from '../lib/app-error.js';
import { logger } from '../lib/logger.js';

const sqsClient = new SQSClient({ region: process.env.AWS_REGION! });
const QUEUE_URL = process.env.SQS_QUEUE_URL!; // Validated at startup in index.ts

export async function sendAnalysisMessage(
  analysisId: string,
  imageUrl: string,
  platform: string,
  mediaType: string = 'IMAGE'
): Promise<string> {
  try {
    const result = await sqsClient.send(new SendMessageCommand({
      QueueUrl: QUEUE_URL,
      MessageBody: JSON.stringify({ analysisId, imageUrl, platform, mediaType }),
    }));
    logger.info('Analysis message sent to SQS', { analysisId, messageId: result.MessageId });
    return result.MessageId!;
  } catch (error) {
    logger.error('SQS send failed', { analysisId, error: String(error) });
    throw new AppError('SQS_SEND_FAILED', 500, 'Failed to queue analysis job');
  }
}
