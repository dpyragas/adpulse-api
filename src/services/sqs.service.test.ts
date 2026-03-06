import { describe, it, expect, beforeEach } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
import { sendAnalysisMessage } from './sqs.service.js';

const sqsMock = mockClient(SQSClient);

beforeEach(() => {
  sqsMock.reset();
});

describe('sendAnalysisMessage', () => {
  it('sends JSON message to SQS and returns MessageId', async () => {
    sqsMock.on(SendMessageCommand).resolves({ MessageId: 'msg-123' });

    const messageId = await sendAnalysisMessage('analysis-1', 's3://bucket/key', 'META');

    expect(messageId).toBe('msg-123');

    const call = sqsMock.commandCalls(SendMessageCommand)[0];
    const body = JSON.parse(call.args[0].input.MessageBody!);
    expect(body).toEqual({
      analysisId: 'analysis-1',
      imageUrl: 's3://bucket/key',
      platform: 'META',
      mediaType: 'IMAGE',
    });
  });

  it('throws AppError SQS_SEND_FAILED on AWS error', async () => {
    sqsMock.on(SendMessageCommand).rejects(new Error('Network error'));

    await expect(sendAnalysisMessage('analysis-2', 's3://bucket/key', 'META'))
      .rejects.toMatchObject({
        code: 'SQS_SEND_FAILED',
        status: 500,
      });
  });
});
