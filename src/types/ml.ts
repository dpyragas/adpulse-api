import { z } from 'zod';
import type { ClassificationResult } from './classification.js';

// ── Pipeline request options ──

export interface PipelineRequestOptions {
  useSamMasks?: boolean;
  detectBranding?: boolean;
  detectProduct?: boolean;
}

// ── Pipeline response (snake_case — matches Modal endpoint JSON) ──

const bboxSchema = z.tuple([z.number(), z.number(), z.number(), z.number()]);

const objectAoiSchema = z.object({
  found: z.boolean(),
  bbox: bboxSchema.optional(),
  confidence: z.number().optional(),
});

const textAoiSchema = z.object({
  found: z.boolean(),
  bbox: bboxSchema.optional(),
  text: z.string().optional(),
  confidence: z.number().optional(),
});

const textRegionSchema = z.object({
  bbox: bboxSchema,
  text: z.string(),
  confidence: z.number(),
});

const bodyTextAoiSchema = z.object({
  found: z.boolean(),
  regions: z.array(textRegionSchema).optional(),
});

const rleSchema = z.object({
  counts: z.array(z.number()),
  size: z.tuple([z.number(), z.number()]),
});

const maskSchema = z.object({
  shape: z.tuple([z.number(), z.number()]),
  sum: z.number(),
  rle: rleSchema,
});

const sentimentResponseSchema = z.object({
  scores: z.record(z.string(), z.number()),
}).nullable();

const categoryLevelSchema = z.object({
  level: z.number(),
  label: z.string(),
  confidence: z.number(),
});

const categoryResponseSchema = z.object({
  levels: z.array(categoryLevelSchema),
}).nullable();

export const pipelineResponseSchema = z.object({
  image_size: z.object({ width: z.number(), height: z.number() }),
  aois: z.object({
    branding: objectAoiSchema.optional(),
    product: objectAoiSchema.optional(),
    headline: textAoiSchema.optional(),
    cta: textAoiSchema.optional(),
    body_text: bodyTextAoiSchema.optional(),
  }),
  masks: z.record(z.string(), maskSchema).optional(),
  aesthetic_score: z.number().nullable(),
  processing_time_ms: z.number(),
  all_text_regions: z.array(textRegionSchema).optional(),
  sentiment: sentimentResponseSchema.optional(),
  category: categoryResponseSchema.optional(),
});

export type PipelineResponse = z.infer<typeof pipelineResponseSchema>;

// ── SUM response (snake_case — matches Modal endpoint JSON) ──

export const sumResponseSchema = z.object({
  heatmap: z.string(),
  overlay: z.string(),
  grayscale: z.string(),
  condition: z.number(),
  condition_name: z.string(),
  original_size: z.tuple([z.number(), z.number()]),
  inference_stdout: z.string().optional(),
});

export type SumResponse = z.infer<typeof sumResponseSchema>;

// ── Heatmap S3 keys ──

export interface HeatmapS3Keys {
  heatmap: string;
  overlay: string;
  grayscale: string;
}

// ── Pipeline status tracking ──

export type EndpointStatus = 'success' | 'failed';

export interface PipelineStatus {
  pipeline: EndpointStatus;
  sum: EndpointStatus;
  pipelineError?: string;
  sumError?: string;
}

// ── Combined ML result (camelCase — stored in analysis.results) ──

export interface MlPipelineResult {
  imageSize: { width: number; height: number } | null;
  aois: PipelineResponse['aois'] | null;
  masks: PipelineResponse['masks'] | null;
  aestheticScore: number | null;
  heatmaps: HeatmapS3Keys | null;
  allTextRegions: PipelineResponse['all_text_regions'] | null;
  processingTimeMs: number | null;
  pipelineStatus: PipelineStatus;
  classification: ClassificationResult | null;
}
