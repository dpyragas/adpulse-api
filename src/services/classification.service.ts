import type { PipelineResponse } from '../types/ml.js';
import type { ClassificationResult, SentimentResult, CategoryResult } from '../types/classification.js';

const CATEGORY_CONFIDENCE_THRESHOLD = 0.60;

export function processClassification(pipelineResponse: PipelineResponse): ClassificationResult {
  return {
    sentiment: processSentiment(pipelineResponse),
    category: processCategory(pipelineResponse),
  };
}

function processSentiment(response: PipelineResponse): SentimentResult | null {
  if (!response.sentiment?.scores) return null;

  const entries = Object.entries(response.sentiment.scores);
  if (entries.length === 0) return null;

  entries.sort((a, b) => b[1] - a[1]);

  return {
    primary: entries[0][0],
    secondary: entries[1]?.[0] ?? entries[0][0],
    scores: response.sentiment.scores,
  };
}

function processCategory(response: PipelineResponse): CategoryResult | null {
  if (!response.category?.levels || response.category.levels.length === 0) return null;

  const filteredLevels = [];
  for (const level of response.category.levels) {
    if (level.confidence < CATEGORY_CONFIDENCE_THRESHOLD) break;
    filteredLevels.push(level);
  }

  return filteredLevels.length > 0 ? { levels: filteredLevels } : null;
}
