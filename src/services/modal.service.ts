import { AppError } from '../lib/app-error.js';
import { logger } from '../lib/logger.js';
import {
  pipelineResponseSchema,
  sumResponseSchema,
  type PipelineResponse,
  type SumResponse,
  type PipelineRequestOptions,
} from '../types/ml.js';

const PIPELINE_URL = process.env.MODAL_PIPELINE_URL!; // Validated at startup in index.ts
const SUM_URL = process.env.MODAL_SUM_URL!;
const TIMEOUT_MS = 120_000;
const COLD_START_WARN_MS = 15_000;

export async function callPipelineEndpoint(
  imageBase64: string,
  options: PipelineRequestOptions = {},
): Promise<PipelineResponse> {
  const {
    useSamMasks = true,
    detectBranding = true,
    detectProduct = true,
  } = options;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  const start = Date.now();

  try {
    const response = await fetch(PIPELINE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        image_base64: imageBase64,
        use_sam_masks: useSamMasks,
        detect_branding: detectBranding,
        detect_product: detectProduct,
      }),
      signal: controller.signal,
    });

    const elapsed = Date.now() - start;
    if (elapsed > COLD_START_WARN_MS) {
      logger.warn('Pipeline cold start detected', { elapsedMs: elapsed });
    }

    if (!response.ok) {
      throw new AppError('MODAL_PIPELINE_FAILED', 502, `Pipeline returned ${response.status}`);
    }

    const json = await response.json();
    const parsed = pipelineResponseSchema.safeParse(json);
    if (!parsed.success) {
      logger.error('Pipeline invalid response', { error: String(parsed.error) });
      throw new AppError('MODAL_PIPELINE_INVALID_RESPONSE', 502, 'Pipeline returned invalid data');
    }

    logger.info('Pipeline endpoint succeeded', { elapsedMs: elapsed });
    return parsed.data;
  } catch (error) {
    if (error instanceof AppError) throw error;
    if (controller.signal.aborted) {
      throw new AppError('MODAL_PIPELINE_TIMEOUT', 504, 'Pipeline request timed out');
    }
    logger.error('Pipeline unreachable', { error: String(error) });
    throw new AppError('MODAL_PIPELINE_UNAVAILABLE', 503, 'Pipeline endpoint unreachable');
  } finally {
    clearTimeout(timer);
  }
}

export async function callSumEndpoint(
  imageBase64: string,
  condition: number,
): Promise<SumResponse> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  const start = Date.now();

  try {
    const response = await fetch(SUM_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        image_base64: imageBase64,
        condition,
      }),
      signal: controller.signal,
    });

    const elapsed = Date.now() - start;
    if (elapsed > COLD_START_WARN_MS) {
      logger.warn('SUM cold start detected', { elapsedMs: elapsed });
    }

    if (!response.ok) {
      throw new AppError('MODAL_SUM_FAILED', 502, `SUM returned ${response.status}`);
    }

    const json = await response.json();
    const parsed = sumResponseSchema.safeParse(json);
    if (!parsed.success) {
      logger.error('SUM invalid response', { error: String(parsed.error) });
      throw new AppError('MODAL_SUM_INVALID_RESPONSE', 502, 'SUM returned invalid data');
    }

    logger.info('SUM endpoint succeeded', { elapsedMs: elapsed });
    return parsed.data;
  } catch (error) {
    if (error instanceof AppError) throw error;
    if (controller.signal.aborted) {
      throw new AppError('MODAL_SUM_TIMEOUT', 504, 'SUM request timed out');
    }
    logger.error('SUM unreachable', { error: String(error) });
    throw new AppError('MODAL_SUM_UNAVAILABLE', 503, 'SUM endpoint unreachable');
  } finally {
    clearTimeout(timer);
  }
}

const PLATFORM_CONDITION_MAP: Record<string, number> = {
  META: 2,
  TIKTOK: 2,
  LINKEDIN: 2,
  GENERAL: 1,
};

export function getConditionForPlatform(platform: string): number {
  return PLATFORM_CONDITION_MAP[platform] ?? 2;
}
