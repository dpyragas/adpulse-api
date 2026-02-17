import { PNG } from 'pngjs';
import { downloadImage } from './s3.service.js';
import { logger } from '../lib/logger.js';
import type { MlPipelineResult } from '../types/ml.js';
import type {
  ScoringResult,
  SubScores,
  ElementScore,
  ScoringIssue,
  PlatformWeights,
  Verdict,
  Platform,
} from '../types/scoring.js';

// ── Platform weight profiles ──

const PLATFORM_WEIGHTS: Record<Platform, PlatformWeights> = {
  GENERAL:  { attention: 0.30, branding: 0.20, message: 0.30, aesthetic: 0.20 },
  META:     { attention: 0.30, branding: 0.20, message: 0.30, aesthetic: 0.20 },
  TIKTOK:   { attention: 0.35, branding: 0.15, message: 0.25, aesthetic: 0.25 },
  LINKEDIN: { attention: 0.25, branding: 0.25, message: 0.35, aesthetic: 0.15 },
};

// ── Helpers ──

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

// ── Heatmap loading ──

export async function loadHeatmapPixels(
  grayscaleS3Key: string,
): Promise<{ pixels: number[][]; width: number; height: number }> {
  const s3Url = `s3://${process.env.S3_BUCKET_NAME}/${grayscaleS3Key}`;
  const buffer = await downloadImage(s3Url);
  const png = PNG.sync.read(buffer);

  const pixels: number[][] = [];
  for (let y = 0; y < png.height; y++) {
    const row: number[] = [];
    for (let x = 0; x < png.width; x++) {
      const idx = (y * png.width + x) * 4;
      row.push(png.data[idx]); // R channel = grayscale intensity
    }
    pixels.push(row);
  }

  return { pixels, width: png.width, height: png.height };
}

// ── Element attention computation ──

export function computeElementAttention(
  pixels: number[][],
  totalIntensity: number,
  aois: NonNullable<MlPipelineResult['aois']>,
  imageWidth: number,
  imageHeight: number,
): ElementScore[] {
  const elements: ElementScore[] = [];
  const aoiEntries: Array<{ type: string; aoi: { found: boolean; bbox?: readonly [number, number, number, number]; confidence?: number } }> = [];

  if (aois.branding) aoiEntries.push({ type: 'branding', aoi: aois.branding as { found: boolean; bbox?: readonly [number, number, number, number]; confidence?: number } });
  if (aois.product) aoiEntries.push({ type: 'product', aoi: aois.product as { found: boolean; bbox?: readonly [number, number, number, number]; confidence?: number } });
  if (aois.headline) aoiEntries.push({ type: 'headline', aoi: aois.headline as { found: boolean; bbox?: readonly [number, number, number, number]; confidence?: number } });
  if (aois.cta) aoiEntries.push({ type: 'cta', aoi: aois.cta as { found: boolean; bbox?: readonly [number, number, number, number]; confidence?: number } });
  if (aois.body_text) aoiEntries.push({ type: 'body_text', aoi: aois.body_text as unknown as { found: boolean; bbox?: readonly [number, number, number, number]; confidence?: number } });

  for (const { type, aoi } of aoiEntries) {
    if (!aoi.found || !aoi.bbox) {
      elements.push({
        type,
        found: aoi.found,
        attentionPercent: 0,
        confidence: aoi.confidence,
      });
      continue;
    }

    // Clamp bbox to image dimensions
    const x1 = clamp(Math.round(aoi.bbox[0]), 0, imageWidth);
    const y1 = clamp(Math.round(aoi.bbox[1]), 0, imageHeight);
    const x2 = clamp(Math.round(aoi.bbox[2]), 0, imageWidth);
    const y2 = clamp(Math.round(aoi.bbox[3]), 0, imageHeight);

    let bboxSum = 0;
    for (let y = y1; y < y2; y++) {
      for (let x = x1; x < x2; x++) {
        bboxSum += pixels[y][x];
      }
    }

    const attentionPercent = totalIntensity === 0 ? 0 : (bboxSum / totalIntensity) * 100;

    elements.push({
      type,
      found: true,
      attentionPercent: round1(attentionPercent),
      bbox: [x1, y1, x2, y2],
      confidence: aoi.confidence,
    });
  }

  return elements;
}

// ── Sub-score computations ──

export function computeAttentionScore(elements: ElementScore[]): number {
  const totalElementAttention = elements.reduce((sum, el) => sum + el.attentionPercent, 0);
  const cta = elements.find((el) => el.type === 'cta');
  const headline = elements.find((el) => el.type === 'headline');
  const ctaAttention = cta?.found ? cta.attentionPercent : 0;
  const headlineAttention = headline?.found ? headline.attentionPercent : 0;

  let base: number;
  if (totalElementAttention >= 50) {
    base = 7 + ((totalElementAttention - 50) / 25) * 3;
  } else if (totalElementAttention >= 25) {
    base = 4 + ((totalElementAttention - 25) / 25) * 3;
  } else {
    base = 1 + (totalElementAttention / 25) * 3;
  }

  if (ctaAttention >= 5) base += 0.5;
  else if (ctaAttention < 2 && cta?.found) base -= 1.0;

  if (headlineAttention >= 8) base += 0.5;

  return round1(clamp(base, 1.0, 10.0));
}

export function computeBrandingScore(elements: ElementScore[]): number {
  const branding = elements.find((el) => el.type === 'branding');
  if (!branding?.found) return 2.0;

  const brandAttention = branding.attentionPercent;
  const brandConfidence = branding.confidence ?? 0.5;

  let base: number;
  if (brandAttention >= 8) {
    base = 9.0;
  } else if (brandAttention >= 5) {
    base = 7.0 + ((brandAttention - 5) / 3) * 2;
  } else if (brandAttention >= 2) {
    base = 4.0 + ((brandAttention - 2) / 3) * 3;
  } else {
    base = 1.0 + (brandAttention / 2) * 3;
  }

  const score = base * (0.75 + brandConfidence * 0.25);
  return round1(clamp(score, 1.0, 10.0));
}

export function computeMessageScore(
  elements: ElementScore[],
  textRegions: MlPipelineResult['allTextRegions'],
): number {
  const cta = elements.find((el) => el.type === 'cta');
  const headline = elements.find((el) => el.type === 'headline');
  const ctaFound = cta?.found ?? false;
  const ctaAttention = cta?.attentionPercent ?? 0;
  const headlineFound = headline?.found ?? false;
  const headlineAttention = headline?.attentionPercent ?? 0;

  const avgTextConfidence =
    textRegions && textRegions.length > 0
      ? textRegions.reduce((sum, r) => sum + r.confidence, 0) / textRegions.length
      : 0.8;

  // CTA component (50% weight)
  let ctaScore: number;
  if (!ctaFound) {
    ctaScore = 2.0;
  } else if (ctaAttention >= 5) {
    ctaScore = 9.0;
  } else if (ctaAttention >= 2) {
    ctaScore = 5.0 + ((ctaAttention - 2) / 3) * 4;
  } else {
    ctaScore = 2.0 + (ctaAttention / 2) * 3;
  }

  // Headline component (30% weight)
  let headlineScore: number;
  if (!headlineFound) {
    headlineScore = 4.0;
  } else if (headlineAttention >= 8) {
    headlineScore = 9.0;
  } else if (headlineAttention >= 3) {
    headlineScore = 5.0 + ((headlineAttention - 3) / 5) * 4;
  } else {
    headlineScore = 2.0 + (headlineAttention / 3) * 3;
  }

  // Text clarity component (20% weight)
  const textClarityScore = 1.0 + avgTextConfidence * 9.0;

  const messageScore = ctaScore * 0.5 + headlineScore * 0.3 + textClarityScore * 0.2;
  return round1(clamp(messageScore, 1.0, 10.0));
}

// ── Overall score & verdict ──

export function computeOverallScore(subScores: SubScores, platform: Platform): number {
  const weights = getPlatformWeights(platform);
  const overall =
    subScores.attention * weights.attention +
    subScores.branding * weights.branding +
    subScores.message * weights.message +
    subScores.aesthetic * weights.aesthetic;
  return round1(clamp(overall, 1.0, 10.0));
}

export function getVerdict(score: number): Verdict {
  if (score >= 8.0) return 'Strong';
  if (score >= 5.0) return 'Good';
  return 'Needs Work';
}

// ── Issue detection ──

export function detectIssues(elements: ElementScore[]): ScoringIssue[] {
  const issues: ScoringIssue[] = [];

  const cta = elements.find((el) => el.type === 'cta');
  const headline = elements.find((el) => el.type === 'headline');
  const branding = elements.find((el) => el.type === 'branding');
  const product = elements.find((el) => el.type === 'product');

  // CTA issues
  if (!cta?.found) {
    issues.push({ severity: 'critical', element: 'cta', message: 'No call-to-action detected in the image' });
  } else if (cta.attentionPercent < 2) {
    issues.push({ severity: 'critical', element: 'cta', message: `CTA receives only ${cta.attentionPercent}% of visual attention`, attentionPercent: cta.attentionPercent });
  }

  // Headline issues
  if (headline?.found && headline.attentionPercent < 2) {
    issues.push({ severity: 'critical', element: 'headline', message: `Headline receives only ${headline.attentionPercent}% of visual attention`, attentionPercent: headline.attentionPercent });
  }

  // Branding issues
  if (!branding?.found) {
    issues.push({ severity: 'warning', element: 'branding', message: 'No branding/logo detected in the image' });
  } else if (branding.attentionPercent < 2) {
    issues.push({ severity: 'warning', element: 'branding', message: `Logo/branding receives only ${branding.attentionPercent}% of visual attention`, attentionPercent: branding.attentionPercent });
  }

  // Product issues
  if (product?.found && product.attentionPercent < 2) {
    issues.push({ severity: 'warning', element: 'product', message: `Product receives only ${product.attentionPercent}% of visual attention`, attentionPercent: product.attentionPercent });
  }

  return issues;
}

// ── Platform weights ──

export function getPlatformWeights(platform: Platform): PlatformWeights {
  return PLATFORM_WEIGHTS[platform] ?? PLATFORM_WEIGHTS.GENERAL;
}

// ── Default element data for partial pipeline ──

function defaultElements(): ElementScore[] {
  return ['branding', 'product', 'headline', 'cta', 'body_text'].map((type) => ({
    type,
    found: false,
    attentionPercent: 0,
  }));
}

// ── Main entry point ──

export async function computeScores(
  mlResult: MlPipelineResult,
  platform: Platform,
  analysisId: string,
): Promise<ScoringResult> {
  const weights = getPlatformWeights(platform);
  let elements: ElementScore[];

  // Partial pipeline: no heatmaps → skip attention, use defaults
  if (!mlResult.heatmaps) {
    logger.warn('No heatmap data — using default attention scores', { analysisId });

    if (mlResult.aois) {
      // Have AOIs but no heatmap — elements found but attention unknown
      elements = [];
      const aoiEntries: Array<{ type: string; found: boolean; confidence?: number }> = [
        { type: 'branding', found: mlResult.aois.branding?.found ?? false, confidence: mlResult.aois.branding?.confidence },
        { type: 'product', found: mlResult.aois.product?.found ?? false, confidence: mlResult.aois.product?.confidence },
        { type: 'headline', found: mlResult.aois.headline?.found ?? false, confidence: mlResult.aois.headline?.confidence },
        { type: 'cta', found: mlResult.aois.cta?.found ?? false, confidence: mlResult.aois.cta?.confidence },
        { type: 'body_text', found: mlResult.aois.body_text?.found ?? false },
      ];
      for (const entry of aoiEntries) {
        elements.push({ type: entry.type, found: entry.found, attentionPercent: 0, confidence: entry.confidence });
      }
    } else {
      elements = defaultElements();
    }

    const subScores: SubScores = {
      attention: 5.0, // neutral default when no heatmap
      branding: mlResult.aois ? computeBrandingScore(elements) : 5.0,
      message: mlResult.aois ? computeMessageScore(elements, mlResult.allTextRegions) : 5.0,
      aesthetic: mlResult.aestheticScore && mlResult.aestheticScore > 0 ? round1(mlResult.aestheticScore) : 5.0,
    };

    const overallScore = computeOverallScore(subScores, platform);
    const verdict = getVerdict(overallScore);
    const issues = detectIssues(elements);

    logger.info('Scoring completed (partial — no heatmap)', { analysisId, overallScore });

    return { overallScore, verdict, subScores, elements, issues, platformModifiers: weights };
  }

  // Partial pipeline: no AOIs → default element data
  if (!mlResult.aois) {
    logger.warn('No AOI data — using default element scores', { analysisId });
    elements = defaultElements();

    const subScores: SubScores = {
      attention: 5.0,
      branding: 5.0,
      message: 5.0,
      aesthetic: mlResult.aestheticScore && mlResult.aestheticScore > 0 ? round1(mlResult.aestheticScore) : 5.0,
    };

    const overallScore = computeOverallScore(subScores, platform);
    const verdict = getVerdict(overallScore);
    const issues = detectIssues(elements);

    logger.info('Scoring completed (partial — no AOIs)', { analysisId, overallScore });

    return { overallScore, verdict, subScores, elements, issues, platformModifiers: weights };
  }

  // Full pipeline — load heatmap and compute attention
  const { pixels, width, height } = await loadHeatmapPixels(mlResult.heatmaps.grayscale);

  let totalIntensity = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      totalIntensity += pixels[y][x];
    }
  }

  elements = computeElementAttention(pixels, totalIntensity, mlResult.aois, width, height);

  const subScores: SubScores = {
    attention: computeAttentionScore(elements),
    branding: computeBrandingScore(elements),
    message: computeMessageScore(elements, mlResult.allTextRegions),
    aesthetic: mlResult.aestheticScore && mlResult.aestheticScore > 0 ? round1(mlResult.aestheticScore) : 5.0,
  };

  const overallScore = computeOverallScore(subScores, platform);
  const verdict = getVerdict(overallScore);
  const issues = detectIssues(elements);

  logger.info('Scoring completed', { analysisId, overallScore });

  return { overallScore, verdict, subScores, elements, issues, platformModifiers: weights };
}
