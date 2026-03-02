import { describe, it, expect } from 'vitest';
import { processClassification } from './classification.service.js';
import type { PipelineResponse } from '../types/ml.js';

const basePipelineResponse: PipelineResponse = {
  image_size: { width: 1080, height: 1080 },
  aois: {},
  aesthetic_score: 7.0,
  processing_time_ms: 3000,
  sentiment: {
    scores: {
      cheerful: 0.18,
      excitement: 0.14,
      trust: 0.09,
      warmth: 0.08,
      inspiration: 0.07,
    },
  },
  category: {
    levels: [
      { level: 1, label: 'Food', confidence: 0.87 },
      { level: 2, label: 'eateries', confidence: 0.72 },
    ],
  },
};

describe('processClassification', () => {
  it('returns correct primary/secondary sentiment and all category levels', () => {
    const result = processClassification(basePipelineResponse);

    expect(result.sentiment).not.toBeNull();
    expect(result.sentiment!.primary).toBe('cheerful');
    expect(result.sentiment!.secondary).toBe('excitement');
    expect(result.sentiment!.scores).toEqual(basePipelineResponse.sentiment!.scores);

    expect(result.category).not.toBeNull();
    expect(result.category!.levels).toHaveLength(2);
    expect(result.category!.levels[0].label).toBe('Food');
    expect(result.category!.levels[1].label).toBe('eateries');
  });

  it('truncates category levels when sub-category confidence < 60%', () => {
    const response: PipelineResponse = {
      ...basePipelineResponse,
      category: {
        levels: [
          { level: 1, label: 'Food', confidence: 0.87 },
          { level: 2, label: 'eateries', confidence: 0.45 },
        ],
      },
    };

    const result = processClassification(response);
    expect(result.category!.levels).toHaveLength(1);
    expect(result.category!.levels[0].label).toBe('Food');
  });

  it('returns all levels when all confidence >= 60%', () => {
    const response: PipelineResponse = {
      ...basePipelineResponse,
      category: {
        levels: [
          { level: 1, label: 'Electronics', confidence: 0.92 },
          { level: 2, label: 'mobile devices', confidence: 0.78 },
        ],
      },
    };

    const result = processClassification(response);
    expect(result.category!.levels).toHaveLength(2);
  });

  it('returns null category when top-level confidence < 60%', () => {
    const response: PipelineResponse = {
      ...basePipelineResponse,
      category: {
        levels: [
          { level: 1, label: 'Sports', confidence: 0.35 },
        ],
      },
    };

    const result = processClassification(response);
    expect(result.category).toBeNull();
  });

  it('returns null sentiment when pipeline has no sentiment', () => {
    const response: PipelineResponse = {
      ...basePipelineResponse,
      sentiment: undefined,
    };

    const result = processClassification(response);
    expect(result.sentiment).toBeNull();
  });

  it('returns null category when pipeline has no category', () => {
    const response: PipelineResponse = {
      ...basePipelineResponse,
      category: undefined,
    };

    const result = processClassification(response);
    expect(result.category).toBeNull();
  });

  it('handles null sentiment and category (old pipeline deployment)', () => {
    const response: PipelineResponse = {
      ...basePipelineResponse,
      sentiment: null,
      category: null,
    };

    const result = processClassification(response);
    expect(result.sentiment).toBeNull();
    expect(result.category).toBeNull();
  });

  it('uses primary as secondary when only one sentiment score', () => {
    const response: PipelineResponse = {
      ...basePipelineResponse,
      sentiment: { scores: { cheerful: 1.0 } },
    };

    const result = processClassification(response);
    expect(result.sentiment!.primary).toBe('cheerful');
    expect(result.sentiment!.secondary).toBe('cheerful');
  });
});
