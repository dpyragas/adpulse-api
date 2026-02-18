import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { ScoringResult } from '../types/scoring.js';
import type { MlPipelineResult } from '../types/ml.js';

const mockGenerateObject = vi.fn();
vi.mock('ai', () => ({
  generateObject: mockGenerateObject,
}));

vi.mock('../lib/ai.js', () => ({
  getModel: vi.fn().mockReturnValue('mock-model'),
}));

const { generateInsights } = await import('./llm.service.js');

const mockScoringResult: ScoringResult = {
  overallScore: 7.5,
  verdict: 'Good',
  subScores: { attention: 7.0, branding: 6.5, message: 8.0, aesthetic: 7.2 },
  elements: [
    { type: 'branding', found: true, attentionPercent: 12.3, confidence: 0.85 },
    { type: 'cta', found: true, attentionPercent: 5.2 },
    { type: 'headline', found: true, attentionPercent: 8.1 },
    { type: 'product', found: false, attentionPercent: 0 },
  ],
  issues: [
    { severity: 'warning', element: 'product', message: 'Product receives only 0% of visual attention', attentionPercent: 0 },
  ],
  platformModifiers: { attention: 0.30, branding: 0.20, message: 0.30, aesthetic: 0.20 },
};

const mockMlResult: MlPipelineResult = {
  imageSize: { width: 1080, height: 1080 },
  aois: { branding: { found: true, bbox: [10, 20, 100, 80], confidence: 0.85 } },
  masks: null,
  aestheticScore: 7.2,
  heatmaps: { heatmap: 'h.png', overlay: 'o.png', grayscale: 'g.png' },
  allTextRegions: [],
  processingTimeMs: 3400,
  pipelineStatus: { pipeline: 'success', sum: 'success' },
  classification: null,
};

const mockClassification = {
  sentiment: { primary: 'cheerful', secondary: 'excitement', scores: { cheerful: 0.18, excitement: 0.14 } },
  category: { levels: [{ level: 1, label: 'Food', confidence: 0.87 }, { level: 2, label: 'eateries', confidence: 0.72 }] },
};

const mockInsightsResponse = {
  summary: 'Good ad with strong branding but missing product visibility.',
  working: ['Strong CTA placement with 5.2% attention', 'Good branding visibility at 12.3%'],
  issues: ['Product not detected in the image'],
  recommendations: [
    { text: 'Add a visible product element', impact: 'high', element: 'product' },
    { text: 'Increase headline contrast', impact: 'medium', element: 'headline' },
  ],
  platformTips: ['Meta favors bold CTAs and clear branding placement'],
};

beforeEach(() => {
  vi.clearAllMocks();
  process.env.OPENAI_API_KEY = 'test-key';
  process.env.AI_PROVIDER = 'openai';
  process.env.AI_MODEL = 'gpt-4o-mini';
});

describe('generateInsights', () => {
  it('returns InsightsResult with all fields on success', async () => {
    mockGenerateObject.mockResolvedValue({ object: mockInsightsResponse });

    const result = await generateInsights(mockScoringResult, mockMlResult, 'META', 'test-id');

    expect(result.unavailable).toBe(false);
    if (!result.unavailable) {
      expect(result.summary).toBe(mockInsightsResponse.summary);
      expect(result.working).toEqual(mockInsightsResponse.working);
      expect(result.issues).toEqual(mockInsightsResponse.issues);
      expect(result.recommendations).toEqual(mockInsightsResponse.recommendations);
      expect(result.platformTips).toEqual(mockInsightsResponse.platformTips);
    }
  });

  it('returns InsightsUnavailable when generateObject throws', async () => {
    mockGenerateObject.mockRejectedValue(new Error('API error'));

    const result = await generateInsights(mockScoringResult, mockMlResult, 'META', 'test-id');

    expect(result.unavailable).toBe(true);
    if (result.unavailable) {
      expect(result.message).toBe('Insights temporarily unavailable');
    }
  });

  it('includes platform name in generateObject call', async () => {
    mockGenerateObject.mockResolvedValue({ object: mockInsightsResponse });

    await generateInsights(mockScoringResult, mockMlResult, 'TIKTOK', 'test-id');

    const call = mockGenerateObject.mock.calls[0][0];
    expect(call.prompt).toContain('TIKTOK');
  });

  it('includes overallScore, verdict, elements, and issues in prompt', async () => {
    mockGenerateObject.mockResolvedValue({ object: mockInsightsResponse });

    await generateInsights(mockScoringResult, mockMlResult, 'META', 'test-id');

    const call = mockGenerateObject.mock.calls[0][0];
    expect(call.prompt).toContain('7.5');
    expect(call.prompt).toContain('Good');
    expect(call.prompt).toContain('branding');
    expect(call.prompt).toContain('product');
    expect(call.prompt).toContain('Product receives only 0%');
  });

  it('returns InsightsUnavailable when OPENAI_API_KEY not set', async () => {
    delete process.env.OPENAI_API_KEY;

    const result = await generateInsights(mockScoringResult, mockMlResult, 'META', 'test-id');

    expect(result.unavailable).toBe(true);
    expect(mockGenerateObject).not.toHaveBeenCalled();
  });

  it('passes system prompt to generateObject', async () => {
    mockGenerateObject.mockResolvedValue({ object: mockInsightsResponse });

    await generateInsights(mockScoringResult, mockMlResult, 'META', 'test-id');

    const call = mockGenerateObject.mock.calls[0][0];
    expect(call.system).toContain('expert ad creative analyst');
  });

  it('does not pass temperature to generateObject (reasoning models)', async () => {
    mockGenerateObject.mockResolvedValue({ object: mockInsightsResponse });

    await generateInsights(mockScoringResult, mockMlResult, 'META', 'test-id');

    const call = mockGenerateObject.mock.calls[0][0];
    expect(call.temperature).toBeUndefined();
  });

  it('passes model from getModel() to generateObject', async () => {
    mockGenerateObject.mockResolvedValue({ object: mockInsightsResponse });

    await generateInsights(mockScoringResult, mockMlResult, 'META', 'test-id');

    const call = mockGenerateObject.mock.calls[0][0];
    expect(call.model).toBe('mock-model');
  });

  it('includes sub-scores and scoring context in prompt', async () => {
    mockGenerateObject.mockResolvedValue({ object: mockInsightsResponse });

    await generateInsights(mockScoringResult, mockMlResult, 'META', 'test-id');

    const call = mockGenerateObject.mock.calls[0][0];
    expect(call.prompt).toContain('Attention 7');
    expect(call.prompt).toContain('Branding 6.5');
    expect(call.prompt).toContain('Message 8');
    expect(call.prompt).toContain('Aesthetic 7.2');
    expect(call.prompt).toContain('CTA drives 50% of Message score');
    expect(call.prompt).toContain('Score Gap Analysis');
  });

  it('includes attention hierarchy sorted by attention', async () => {
    mockGenerateObject.mockResolvedValue({ object: mockInsightsResponse });

    await generateInsights(mockScoringResult, mockMlResult, 'META', 'test-id');

    const call = mockGenerateObject.mock.calls[0][0];
    expect(call.prompt).toContain('Attention Hierarchy');
    // branding 12.3% > headline 8.1% > cta 5.2%
    const hierarchyMatch = call.prompt.match(/1\. branding.*\n.*2\. headline.*\n.*3\. cta/);
    expect(hierarchyMatch).not.toBeNull();
  });

  it('handles NoObjectGeneratedError gracefully', async () => {
    const error = new Error('No object generated');
    error.name = 'NoObjectGeneratedError';
    mockGenerateObject.mockRejectedValue(error);

    const result = await generateInsights(mockScoringResult, mockMlResult, 'META', 'test-id');

    expect(result.unavailable).toBe(true);
    if (result.unavailable) {
      expect(result.message).toBe('Insights temporarily unavailable');
    }
  });

  it('includes classification in prompt when provided', async () => {
    mockGenerateObject.mockResolvedValue({ object: mockInsightsResponse });

    await generateInsights(mockScoringResult, mockMlResult, 'META', 'test-id', mockClassification);

    const call = mockGenerateObject.mock.calls[0][0];
    expect(call.prompt).toContain('Emotional Tone: cheerful');
    expect(call.prompt).toContain('excitement');
    expect(call.prompt).toContain('Ad Category: Food');
    expect(call.prompt).toContain('eateries');
  });

  it('omits classification block when classification is null', async () => {
    mockGenerateObject.mockResolvedValue({ object: mockInsightsResponse });

    await generateInsights(mockScoringResult, mockMlResult, 'META', 'test-id', null);

    const call = mockGenerateObject.mock.calls[0][0];
    expect(call.prompt).not.toContain('Emotional Tone');
    expect(call.prompt).not.toContain('Ad Category');
  });

  it('omits classification block when sentiment and category are both null (old pipeline)', async () => {
    mockGenerateObject.mockResolvedValue({ object: mockInsightsResponse });

    await generateInsights(mockScoringResult, mockMlResult, 'META', 'test-id', { sentiment: null, category: null });

    const call = mockGenerateObject.mock.calls[0][0];
    expect(call.prompt).not.toContain('Emotional Tone');
    expect(call.prompt).not.toContain('Ad Category');
  });

  it('includes classification context in system prompt', async () => {
    mockGenerateObject.mockResolvedValue({ object: mockInsightsResponse });

    await generateInsights(mockScoringResult, mockMlResult, 'META', 'test-id', mockClassification);

    const call = mockGenerateObject.mock.calls[0][0];
    expect(call.system).toContain('category data');
  });
});
