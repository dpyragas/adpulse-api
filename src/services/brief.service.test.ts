import { describe, it, expect, beforeEach, vi } from 'vitest';

const mockGenerateObject = vi.fn();
vi.mock('ai', () => ({
  generateObject: mockGenerateObject,
}));

vi.mock('../lib/ai.js', () => ({
  getModel: vi.fn().mockReturnValue('mock-model'),
}));

const { generateCreativeBrief, buildBriefPrompt, creativeBriefSchema } = await import('./brief.service.js');

const mockBriefResponse = {
  summary: 'The ad needs a stronger CTA and better logo placement.',
  changes: [
    {
      priority: 'critical' as const,
      element: 'CTA' as const,
      currentState: 'CTA receives only 1.2% attention',
      recommendation: 'Increase CTA size by 40% and use contrasting color',
      specificDetails: 'Move to bottom-right, use #FF6600 background',
      expectedImpact: 'Expected 3-5% attention increase',
    },
    {
      priority: 'high' as const,
      element: 'Logo' as const,
      currentState: 'Logo is barely visible at 2% attention',
      recommendation: 'Increase logo size and move to top-left corner',
      expectedImpact: 'Improved brand recall',
    },
  ],
  designNotes: 'Consider a Z-pattern layout for better visual flow.',
  platformTips: 'Meta ads perform best with bold, centered CTAs above the fold.',
};

const mockAnalysisResults = {
  scoring: {
    overallScore: 5.2,
    verdict: 'Needs Work',
    subScores: { attention: 4.0, branding: 3.5, message: 6.0, aesthetic: 7.0 },
    elements: [
      { type: 'branding', found: true, attentionPercent: 2.0 },
      { type: 'cta', found: true, attentionPercent: 1.2 },
      { type: 'headline', found: true, attentionPercent: 8.5 },
      { type: 'product', found: false, attentionPercent: 0 },
    ],
    issues: [
      { severity: 'critical', element: 'cta', message: 'CTA below 2% attention threshold' },
      { severity: 'warning', element: 'product', message: 'Product not detected' },
    ],
    platformModifiers: { attention: 0.30, branding: 0.20, message: 0.30, aesthetic: 0.20 },
  },
  classification: {
    sentiment: { primary: 'cheerful' },
    category: { levels: [{ label: 'Food' }, { label: 'Restaurants' }] },
  },
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('creativeBriefSchema', () => {
  it('validates a correct brief object', () => {
    const result = creativeBriefSchema.safeParse(mockBriefResponse);
    expect(result.success).toBe(true);
  });

  it('rejects missing summary', () => {
    const { summary, ...rest } = mockBriefResponse;
    const result = creativeBriefSchema.safeParse(rest);
    expect(result.success).toBe(false);
  });

  it('rejects invalid priority value', () => {
    const invalid = {
      ...mockBriefResponse,
      changes: [{ ...mockBriefResponse.changes[0], priority: 'low' }],
    };
    const result = creativeBriefSchema.safeParse(invalid);
    expect(result.success).toBe(false);
  });

  it('rejects invalid element value', () => {
    const invalid = {
      ...mockBriefResponse,
      changes: [{ ...mockBriefResponse.changes[0], element: 'Footer' }],
    };
    const result = creativeBriefSchema.safeParse(invalid);
    expect(result.success).toBe(false);
  });

  it('allows optional specificDetails', () => {
    const brief = {
      ...mockBriefResponse,
      changes: [{ ...mockBriefResponse.changes[1] }], // no specificDetails
    };
    const result = creativeBriefSchema.safeParse(brief);
    expect(result.success).toBe(true);
  });
});

describe('buildBriefPrompt', () => {
  it('includes platform, overall score, and verdict', () => {
    const prompt = buildBriefPrompt(mockAnalysisResults, 'META');
    expect(prompt).toContain('META');
    expect(prompt).toContain('5.2');
    expect(prompt).toContain('Needs Work');
  });

  it('includes attention hierarchy sorted descending', () => {
    const prompt = buildBriefPrompt(mockAnalysisResults, 'META');
    expect(prompt).toContain('Attention Hierarchy');
    const headlineIdx = prompt.indexOf('headline');
    const brandingIdx = prompt.indexOf('branding');
    const ctaIdx = prompt.indexOf('cta');
    // headline 8.5% > branding 2.0% > cta 1.2%
    expect(headlineIdx).toBeLessThan(brandingIdx);
    expect(brandingIdx).toBeLessThan(ctaIdx);
  });

  it('includes missing elements', () => {
    const prompt = buildBriefPrompt(mockAnalysisResults, 'META');
    expect(prompt).toContain('Missing elements: product');
  });

  it('includes issues with severity', () => {
    const prompt = buildBriefPrompt(mockAnalysisResults, 'META');
    expect(prompt).toContain('[critical] cta');
    expect(prompt).toContain('[warning] product');
  });

  it('includes sub-scores with gaps', () => {
    const prompt = buildBriefPrompt(mockAnalysisResults, 'META');
    expect(prompt).toContain('attention: 4/10');
    expect(prompt).toContain('gap: 6.0');
  });

  it('includes classification when provided', () => {
    const prompt = buildBriefPrompt(mockAnalysisResults, 'META');
    expect(prompt).toContain('cheerful');
    expect(prompt).toContain('Food');
    expect(prompt).toContain('Restaurants');
  });

  it('omits classification when not provided', () => {
    const { classification, ...rest } = mockAnalysisResults;
    const prompt = buildBriefPrompt(rest, 'META');
    expect(prompt).not.toContain('Emotional Tone');
    expect(prompt).not.toContain('Category');
  });

  it('returns fallback when no scoring data', () => {
    const prompt = buildBriefPrompt({}, 'META');
    expect(prompt).toBe('No scoring data available.');
  });
});

describe('generateCreativeBrief', () => {
  it('returns CreativeBrief on success', async () => {
    mockGenerateObject.mockResolvedValue({ object: mockBriefResponse });

    const result = await generateCreativeBrief(mockAnalysisResults, 'META', 'test-id');

    expect(result.summary).toBe(mockBriefResponse.summary);
    expect(result.changes).toHaveLength(2);
    expect(result.changes[0].priority).toBe('critical');
    expect(result.designNotes).toBe(mockBriefResponse.designNotes);
    expect(result.platformTips).toBe(mockBriefResponse.platformTips);
  });

  it('passes model, schema, system, and prompt to generateObject', async () => {
    mockGenerateObject.mockResolvedValue({ object: mockBriefResponse });

    await generateCreativeBrief(mockAnalysisResults, 'META', 'test-id');

    const call = mockGenerateObject.mock.calls[0][0];
    expect(call.model).toBe('mock-model');
    expect(call.schema).toBeDefined();
    expect(call.system).toContain('expert ad creative director');
    expect(call.prompt).toContain('META');
    expect(call.prompt).toContain('5.2');
  });

  it('throws AppError with BRIEF_GENERATION_FAILED on API error', async () => {
    mockGenerateObject.mockRejectedValue(new Error('API error'));

    await expect(generateCreativeBrief(mockAnalysisResults, 'META', 'test-id'))
      .rejects
      .toMatchObject({
        code: 'BRIEF_GENERATION_FAILED',
        status: 502,
      });
  });
});
