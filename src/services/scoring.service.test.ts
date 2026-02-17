import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PNG } from 'pngjs';
import type { MlPipelineResult } from '../types/ml.js';
import type { ElementScore } from '../types/scoring.js';

// ── Mock S3 downloadImage ──

vi.mock('./s3.service.js', () => ({
  downloadImage: vi.fn(),
}));

vi.mock('../lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { downloadImage } from './s3.service.js';
import {
  computeScores,
  computeElementAttention,
  computeAttentionScore,
  computeBrandingScore,
  computeMessageScore,
  computeOverallScore,
  getVerdict,
  detectIssues,
  getPlatformWeights,
  loadHeatmapPixels,
} from './scoring.service.js';

// ── Test fixture: create fake grayscale PNG ──

function createTestHeatmap(
  width: number,
  height: number,
  intensityFn: (x: number, y: number) => number,
): Buffer {
  const png = new PNG({ width, height });
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = (y * width + x) * 4;
      const intensity = intensityFn(x, y);
      png.data[idx] = intensity;     // R
      png.data[idx + 1] = intensity; // G
      png.data[idx + 2] = intensity; // B
      png.data[idx + 3] = 255;       // A
    }
  }
  return PNG.sync.write(png);
}

// ── Shared test data ──

const fullAois: NonNullable<MlPipelineResult['aois']> = {
  branding: { found: true, bbox: [0, 0, 25, 25], confidence: 0.9 },
  product: { found: true, bbox: [50, 0, 100, 50], confidence: 0.8 },
  headline: { found: true, bbox: [0, 50, 100, 75], text: 'Big Sale', confidence: 0.95 },
  cta: { found: true, bbox: [25, 75, 75, 100], text: 'Shop Now', confidence: 0.98 },
  body_text: { found: true, regions: [{ bbox: [0, 25, 50, 50] as [number, number, number, number], text: 'Save 50%', confidence: 0.9 }] },
};

const textRegions: MlPipelineResult['allTextRegions'] = [
  { bbox: [0, 50, 100, 75] as [number, number, number, number], text: 'Big Sale', confidence: 0.95 },
  { bbox: [25, 75, 75, 100] as [number, number, number, number], text: 'Shop Now', confidence: 0.98 },
];

function buildMlResult(overrides: Partial<MlPipelineResult> = {}): MlPipelineResult {
  return {
    imageSize: { width: 100, height: 100 },
    aois: fullAois,
    masks: null,
    aestheticScore: 7.5,
    heatmaps: { heatmap: 'h.png', overlay: 'o.png', grayscale: 'g.png' },
    allTextRegions: textRegions,
    processingTimeMs: 3000,
    pipelineStatus: { pipeline: 'success', sum: 'success' },
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.S3_BUCKET_NAME = 'test-bucket';
});

// ── Tests ──

describe('loadHeatmapPixels', () => {
  it('decodes grayscale PNG from S3 into pixel array', async () => {
    const buffer = createTestHeatmap(10, 10, (x, y) => x + y * 10);
    vi.mocked(downloadImage).mockResolvedValue(buffer);

    const result = await loadHeatmapPixels('analyses/123/heatmaps/grayscale.png');

    expect(result.width).toBe(10);
    expect(result.height).toBe(10);
    expect(result.pixels[0][0]).toBe(0);
    expect(result.pixels[0][5]).toBe(5);
    expect(result.pixels[5][0]).toBe(50);
    expect(vi.mocked(downloadImage)).toHaveBeenCalledWith('s3://test-bucket/analyses/123/heatmaps/grayscale.png');
  });
});

describe('computeElementAttention', () => {
  it('computes attention % correctly from heatmap pixels', () => {
    // 100x100 image, bright top-left quadrant (200 intensity), dim elsewhere (20)
    const pixels: number[][] = [];
    let totalIntensity = 0;
    for (let y = 0; y < 100; y++) {
      const row: number[] = [];
      for (let x = 0; x < 100; x++) {
        const val = x < 50 && y < 50 ? 200 : 20;
        row.push(val);
        totalIntensity += val;
      }
      pixels.push(row);
    }

    const aois: NonNullable<MlPipelineResult['aois']> = {
      branding: { found: true, bbox: [0, 0, 50, 50], confidence: 0.9 }, // top-left bright quadrant
      product: { found: true, bbox: [50, 50, 100, 100], confidence: 0.8 }, // bottom-right dim
      headline: { found: false },
      cta: { found: false },
    };

    const elements = computeElementAttention(pixels, totalIntensity, aois, 100, 100);

    const brandingEl = elements.find((e) => e.type === 'branding')!;
    const productEl = elements.find((e) => e.type === 'product')!;

    // Top-left quadrant: 50*50*200 = 500000
    // Total: 50*50*200 + 7500*20 = 500000 + 150000 = 650000
    // branding attention = 500000/650000 * 100 ≈ 76.9%
    expect(brandingEl.attentionPercent).toBeGreaterThan(70);
    expect(brandingEl.found).toBe(true);

    // Bottom-right: 50*50*20 = 50000 → 50000/650000 * 100 ≈ 7.7%
    expect(productEl.attentionPercent).toBeGreaterThan(5);
    expect(productEl.attentionPercent).toBeLessThan(15);
  });

  it('returns 0% attention for unfound elements', () => {
    const pixels = [[100]];
    const aois: NonNullable<MlPipelineResult['aois']> = {
      branding: { found: false },
      headline: { found: false },
    };

    const elements = computeElementAttention(pixels, 100, aois, 1, 1);
    for (const el of elements) {
      expect(el.attentionPercent).toBe(0);
      expect(el.found).toBe(false);
    }
  });

  it('handles zero total intensity (blank heatmap)', () => {
    const pixels = [[0, 0], [0, 0]];
    const aois: NonNullable<MlPipelineResult['aois']> = {
      branding: { found: true, bbox: [0, 0, 1, 1], confidence: 0.9 },
    };

    const elements = computeElementAttention(pixels, 0, aois, 2, 2);
    expect(elements[0].attentionPercent).toBe(0);
  });
});

describe('computeAttentionScore', () => {
  it('high element attention → high score (7-10 range)', () => {
    const elements: ElementScore[] = [
      { type: 'branding', found: true, attentionPercent: 20 },
      { type: 'cta', found: true, attentionPercent: 15 },
      { type: 'headline', found: true, attentionPercent: 20 },
    ];
    // total = 55 → base = 7 + (55-50)/25*3 = 7.6, cta >= 5 → +0.5 = 8.1, headline >= 8 → +0.5 = 8.6
    const score = computeAttentionScore(elements);
    expect(score).toBeGreaterThanOrEqual(7);
    expect(score).toBeLessThanOrEqual(10);
  });

  it('low attention → low score (1-4 range)', () => {
    const elements: ElementScore[] = [
      { type: 'branding', found: true, attentionPercent: 3 },
      { type: 'cta', found: true, attentionPercent: 1 },
      { type: 'headline', found: true, attentionPercent: 2 },
    ];
    // total = 6 → base = 1 + 6/25*3 = 1.72, cta < 2 & found → -1 = 0.72 → clamped to 1.0
    const score = computeAttentionScore(elements);
    expect(score).toBeGreaterThanOrEqual(1);
    expect(score).toBeLessThanOrEqual(4);
  });
});

describe('computeBrandingScore', () => {
  it('no branding found → returns 2.0', () => {
    const elements: ElementScore[] = [{ type: 'branding', found: false, attentionPercent: 0 }];
    expect(computeBrandingScore(elements)).toBe(2.0);
  });

  it('high brand attention → high score', () => {
    const elements: ElementScore[] = [{ type: 'branding', found: true, attentionPercent: 10, confidence: 0.95 }];
    const score = computeBrandingScore(elements);
    expect(score).toBeGreaterThanOrEqual(8);
  });
});

describe('computeMessageScore', () => {
  it('computes weighted score from CTA + headline + text clarity', () => {
    const elements: ElementScore[] = [
      { type: 'cta', found: true, attentionPercent: 6 },
      { type: 'headline', found: true, attentionPercent: 10 },
    ];
    const regions = [{ bbox: [0, 0, 10, 10] as [number, number, number, number], text: 'x', confidence: 0.9 }];
    const score = computeMessageScore(elements, regions);
    // cta >= 5 → 9.0, headline >= 8 → 9.0, text = 1+0.9*9 = 9.1
    // = 9*0.5 + 9*0.3 + 9.1*0.2 = 4.5 + 2.7 + 1.82 = 9.02
    expect(score).toBeGreaterThanOrEqual(8);
    expect(score).toBeLessThanOrEqual(10);
  });

  it('no CTA → ctaScore = 2.0', () => {
    const elements: ElementScore[] = [
      { type: 'cta', found: false, attentionPercent: 0 },
      { type: 'headline', found: true, attentionPercent: 10 },
    ];
    const score = computeMessageScore(elements, null);
    // cta = 2.0, headline >= 8 → 9.0, text = 1+0.8*9=8.2
    // = 2*0.5 + 9*0.3 + 8.2*0.2 = 1 + 2.7 + 1.64 = 5.34
    expect(score).toBeGreaterThanOrEqual(4);
    expect(score).toBeLessThanOrEqual(7);
  });
});

describe('getVerdict', () => {
  it.each([
    [10.0, 'Strong'],
    [8.0, 'Strong'],
    [7.9, 'Good'],
    [5.0, 'Good'],
    [4.9, 'Needs Work'],
    [1.0, 'Needs Work'],
  ] as const)('score %f → verdict %s', (score, expected) => {
    expect(getVerdict(score)).toBe(expected);
  });
});

describe('detectIssues', () => {
  it('flags CTA <2% attention as critical', () => {
    const elements: ElementScore[] = [
      { type: 'cta', found: true, attentionPercent: 1.5 },
      { type: 'headline', found: true, attentionPercent: 10 },
      { type: 'branding', found: true, attentionPercent: 5 },
    ];
    const issues = detectIssues(elements);
    const ctaIssue = issues.find((i) => i.element === 'cta');
    expect(ctaIssue).toBeDefined();
    expect(ctaIssue!.severity).toBe('critical');
    expect(ctaIssue!.attentionPercent).toBe(1.5);
  });

  it('flags missing CTA as critical', () => {
    const elements: ElementScore[] = [
      { type: 'cta', found: false, attentionPercent: 0 },
      { type: 'headline', found: true, attentionPercent: 10 },
      { type: 'branding', found: true, attentionPercent: 5 },
    ];
    const issues = detectIssues(elements);
    const ctaIssue = issues.find((i) => i.element === 'cta');
    expect(ctaIssue).toBeDefined();
    expect(ctaIssue!.severity).toBe('critical');
    expect(ctaIssue!.message).toContain('No call-to-action');
  });

  it('flags missing branding as warning', () => {
    const elements: ElementScore[] = [
      { type: 'cta', found: true, attentionPercent: 5 },
      { type: 'branding', found: false, attentionPercent: 0 },
    ];
    const issues = detectIssues(elements);
    const brandIssue = issues.find((i) => i.element === 'branding');
    expect(brandIssue).toBeDefined();
    expect(brandIssue!.severity).toBe('warning');
  });

  it('flags product <2% as warning', () => {
    const elements: ElementScore[] = [
      { type: 'product', found: true, attentionPercent: 1.0 },
      { type: 'cta', found: true, attentionPercent: 5 },
      { type: 'branding', found: true, attentionPercent: 5 },
    ];
    const issues = detectIssues(elements);
    const productIssue = issues.find((i) => i.element === 'product');
    expect(productIssue).toBeDefined();
    expect(productIssue!.severity).toBe('warning');
  });

  it('no issues when all elements have good attention', () => {
    const elements: ElementScore[] = [
      { type: 'cta', found: true, attentionPercent: 5 },
      { type: 'headline', found: true, attentionPercent: 10 },
      { type: 'branding', found: true, attentionPercent: 5 },
      { type: 'product', found: true, attentionPercent: 5 },
    ];
    expect(detectIssues(elements)).toHaveLength(0);
  });
});

describe('getPlatformWeights', () => {
  it('returns different weights per platform', () => {
    const general = getPlatformWeights('GENERAL');
    const tiktok = getPlatformWeights('TIKTOK');
    const linkedin = getPlatformWeights('LINKEDIN');

    expect(general.attention).toBe(0.30);
    expect(tiktok.attention).toBe(0.35);
    expect(linkedin.message).toBe(0.35);

    // All weights sum to 1.0
    for (const w of [general, tiktok, linkedin]) {
      const sum = w.attention + w.branding + w.message + w.aesthetic;
      expect(sum).toBeCloseTo(1.0);
    }
  });
});

describe('computeOverallScore', () => {
  it('produces weighted average', () => {
    const subScores = { attention: 8.0, branding: 7.0, message: 9.0, aesthetic: 6.0 };
    const score = computeOverallScore(subScores, 'GENERAL');
    // 8*0.3 + 7*0.2 + 9*0.3 + 6*0.2 = 2.4 + 1.4 + 2.7 + 1.2 = 7.7
    expect(score).toBe(7.7);
  });

  it('clamps to [1.0, 10.0]', () => {
    const low = { attention: 1.0, branding: 1.0, message: 1.0, aesthetic: 1.0 };
    const high = { attention: 10.0, branding: 10.0, message: 10.0, aesthetic: 10.0 };
    expect(computeOverallScore(low, 'GENERAL')).toBeGreaterThanOrEqual(1.0);
    expect(computeOverallScore(high, 'GENERAL')).toBeLessThanOrEqual(10.0);
  });
});

describe('computeScores — full pipeline', () => {
  it('computes all scores from full ML data', async () => {
    // 100x100 heatmap: bright in CTA/headline areas, moderate elsewhere
    const buffer = createTestHeatmap(100, 100, (x, y) => {
      // CTA area (25-75, 75-100)
      if (x >= 25 && x < 75 && y >= 75 && y < 100) return 200;
      // Headline area (0-100, 50-75)
      if (y >= 50 && y < 75) return 150;
      // Branding area (0-25, 0-25)
      if (x < 25 && y < 25) return 180;
      return 30;
    });
    vi.mocked(downloadImage).mockResolvedValue(buffer);

    const mlResult = buildMlResult();
    const result = await computeScores(mlResult, 'META', 'test-123');

    expect(result.overallScore).toBeGreaterThanOrEqual(1.0);
    expect(result.overallScore).toBeLessThanOrEqual(10.0);
    expect(['Strong', 'Good', 'Needs Work']).toContain(result.verdict);
    expect(result.subScores.attention).toBeGreaterThanOrEqual(1.0);
    expect(result.subScores.branding).toBeGreaterThanOrEqual(1.0);
    expect(result.subScores.message).toBeGreaterThanOrEqual(1.0);
    expect(result.subScores.aesthetic).toBe(7.5);
    expect(result.elements.length).toBeGreaterThan(0);
    expect(result.platformModifiers).toEqual(getPlatformWeights('META'));
  });
});

describe('computeScores — partial pipeline', () => {
  it('no heatmaps → default attention score 5.0', async () => {
    const mlResult = buildMlResult({ heatmaps: null });
    const result = await computeScores(mlResult, 'GENERAL', 'test-partial-1');

    expect(result.subScores.attention).toBe(5.0);
    expect(result.elements.length).toBeGreaterThan(0);
    expect(vi.mocked(downloadImage)).not.toHaveBeenCalled();
  });

  it('no AOIs → default element scores 5.0', async () => {
    const buffer = createTestHeatmap(10, 10, () => 100);
    vi.mocked(downloadImage).mockResolvedValue(buffer);

    const mlResult = buildMlResult({ aois: null });
    const result = await computeScores(mlResult, 'GENERAL', 'test-partial-2');

    expect(result.subScores.attention).toBe(5.0);
    expect(result.subScores.branding).toBe(5.0);
    expect(result.subScores.message).toBe(5.0);
    expect(result.elements.every((el) => !el.found)).toBe(true);
  });

  it('null aesthetic score → defaults to 5.0', async () => {
    const buffer = createTestHeatmap(100, 100, () => 100);
    vi.mocked(downloadImage).mockResolvedValue(buffer);

    const mlResult = buildMlResult({ aestheticScore: null });
    const result = await computeScores(mlResult, 'GENERAL', 'test-aesthetic');

    expect(result.subScores.aesthetic).toBe(5.0);
  });
});

describe('score clamping', () => {
  it('all scores clamped to [1.0, 10.0]', async () => {
    // Edge case: all zeros
    const buffer = createTestHeatmap(100, 100, () => 0);
    vi.mocked(downloadImage).mockResolvedValue(buffer);

    const mlResult = buildMlResult({ aestheticScore: 0 });
    const result = await computeScores(mlResult, 'GENERAL', 'test-clamp');

    expect(result.overallScore).toBeGreaterThanOrEqual(1.0);
    expect(result.overallScore).toBeLessThanOrEqual(10.0);
    expect(result.subScores.attention).toBeGreaterThanOrEqual(1.0);
    expect(result.subScores.branding).toBeGreaterThanOrEqual(1.0);
    expect(result.subScores.message).toBeGreaterThanOrEqual(1.0);
    expect(result.subScores.aesthetic).toBeGreaterThanOrEqual(1.0);
  });
});
