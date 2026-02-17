import { Consumer } from 'sqs-consumer';
import { SQSClient } from '@aws-sdk/client-sqs';
import type { Message } from '@aws-sdk/client-sqs';
import { z } from 'zod';
import type { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { AppError } from '../lib/app-error.js';
import { logger } from '../lib/logger.js';
import { downloadImage, uploadBuffer } from '../services/s3.service.js';
import { callPipelineEndpoint, callSumEndpoint, getConditionForPlatform } from '../services/modal.service.js';
import type { MlPipelineResult, PipelineResponse, SumResponse } from '../types/ml.js';
import { computeScores } from '../services/scoring.service.js';
import type { Platform } from '../types/scoring.js';

const messageSchema = z.object({
  analysisId: z.string(),
  imageUrl: z.string(),
  platform: z.string(),
});

export type AnalysisMessageBody = z.infer<typeof messageSchema>;

async function retryOnce<T>(fn: () => Promise<T>, label: string): Promise<T> {
  try {
    return await fn();
  } catch (firstError) {
    logger.warn(`${label} failed, retrying once`, { error: String(firstError) });
    return fn();
  }
}

export async function runPipeline(body: AnalysisMessageBody): Promise<Prisma.InputJsonValue> {
  const imageBuffer = await downloadImage(body.imageUrl);
  const imageBase64 = imageBuffer.toString('base64');
  const condition = getConditionForPlatform(body.platform);

  const [pipelineResult, sumResult] = await Promise.allSettled([
    callPipelineEndpoint(imageBase64),
    callSumEndpoint(imageBase64, condition),
  ]);

  // Auto-retry failed endpoints once
  let pipelineData: PipelineResponse | null = null;
  let sumData: SumResponse | null = null;
  let pipelineError: string | undefined;
  let sumError: string | undefined;

  if (pipelineResult.status === 'fulfilled') {
    pipelineData = pipelineResult.value;
  } else {
    try {
      pipelineData = await retryOnce(() => callPipelineEndpoint(imageBase64), 'Pipeline retry');
    } catch (err) {
      pipelineError = String(err);
      logger.error('Pipeline failed after retry', { analysisId: body.analysisId, error: pipelineError });
    }
  }

  if (sumResult.status === 'fulfilled') {
    sumData = sumResult.value;
  } else {
    try {
      sumData = await retryOnce(() => callSumEndpoint(imageBase64, condition), 'SUM retry');
    } catch (err) {
      sumError = String(err);
      logger.error('SUM failed after retry', { analysisId: body.analysisId, error: sumError });
    }
  }

  if (!pipelineData && !sumData) {
    throw new AppError('MODAL_BOTH_FAILED', 502, 'Both ML endpoints failed after retry');
  }

  // Upload heatmap PNGs to S3
  let heatmaps: MlPipelineResult['heatmaps'] = null;
  if (sumData) {
    try {
      const prefix = `analyses/${body.analysisId}/heatmaps`;
      const [heatmapKey, overlayKey, grayscaleKey] = await Promise.all([
        uploadBuffer(Buffer.from(sumData.heatmap, 'base64'), `${prefix}/heatmap.png`, 'image/png'),
        uploadBuffer(Buffer.from(sumData.overlay, 'base64'), `${prefix}/overlay.png`, 'image/png'),
        uploadBuffer(Buffer.from(sumData.grayscale, 'base64'), `${prefix}/grayscale.png`, 'image/png'),
      ]);
      heatmaps = { heatmap: heatmapKey, overlay: overlayKey, grayscale: grayscaleKey };
    } catch (err) {
      logger.error('Heatmap S3 upload failed', { analysisId: body.analysisId, error: String(err) });
      throw new AppError('S3_UPLOAD_FAILED', 500, 'Failed to upload heatmap images to S3');
    }
  }

  const mlResult: MlPipelineResult = {
    imageSize: pipelineData?.image_size ?? null,
    aois: pipelineData?.aois ?? null,
    masks: pipelineData?.masks ?? null,
    aestheticScore: pipelineData?.aesthetic_score ?? null,
    heatmaps,
    allTextRegions: pipelineData?.all_text_regions ?? null,
    processingTimeMs: pipelineData?.processing_time_ms ?? null,
    pipelineStatus: {
      pipeline: pipelineData ? 'success' : 'failed',
      sum: sumData ? 'success' : 'failed',
      ...(pipelineError && { pipelineError }),
      ...(sumError && { sumError }),
    },
  };

  const platform = (body.platform?.toUpperCase() || 'GENERAL') as Platform;
  const scoringResult = await computeScores(mlResult, platform, body.analysisId);

  return { ...mlResult, scoring: scoringResult } as unknown as Prisma.InputJsonValue;
}

export type PipelineFn = (body: AnalysisMessageBody) => Promise<Prisma.InputJsonValue>;

export async function handleMessage(
  message: { Body?: string },
  pipeline: PipelineFn = runPipeline,
) {
  const body = messageSchema.parse(JSON.parse(message.Body!));

  logger.info('Worker processing analysis', { analysisId: body.analysisId });

  const existing = await prisma.analysis.findUnique({ where: { id: body.analysisId } });
  if (!existing) {
    throw new AppError('ANALYSIS_NOT_FOUND', 404, `Analysis ${body.analysisId} not found`);
  }

  await prisma.analysis.update({
    where: { id: body.analysisId },
    data: { status: 'PROCESSING' },
  });

  try {
    const results = await pipeline(body);

    await prisma.analysis.update({
      where: { id: body.analysisId },
      data: { status: 'COMPLETED', results },
    });

    logger.info('Analysis completed', { analysisId: body.analysisId });
  } catch (error) {
    logger.error('Analysis pipeline failed', { analysisId: body.analysisId, error: String(error) });

    await prisma.analysis.update({
      where: { id: body.analysisId },
      data: { status: 'FAILED' },
    });

    throw new AppError('ANALYSIS_PIPELINE_FAILED', 500, 'Analysis processing failed');
  }
}

let consumer: Consumer | null = null;

export function startWorker() {
  consumer = Consumer.create({
    queueUrl: process.env.SQS_QUEUE_URL!,
    handleMessage: async (msg: Message) => { await handleMessage(msg); return msg; },
    sqs: new SQSClient({ region: process.env.AWS_REGION! }),
    batchSize: 1,
    visibilityTimeout: 120,
    heartbeatInterval: 30,
  });

  consumer.on('error', (err) => {
    logger.error('SQS consumer error', { error: err.message });
  });

  consumer.on('processing_error', (err) => {
    logger.error('SQS processing error', { error: err.message });
  });

  consumer.start();
  logger.info('Analysis worker started');
}

export function stopWorker() {
  if (consumer) {
    consumer.stop();
    logger.info('Analysis worker stopped');
  }
}
