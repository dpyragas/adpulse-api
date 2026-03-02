import { createOpenAI } from '@ai-sdk/openai';
import type { LanguageModel } from 'ai';
import { AppError } from './app-error.js';

export function getModel(): LanguageModel {
  const provider = process.env.AI_PROVIDER || 'openai';
  const modelId = process.env.AI_MODEL || 'gpt-4o-mini';

  switch (provider) {
    case 'openai':
      return createOpenAI({ apiKey: process.env.OPENAI_API_KEY })(modelId);
    default:
      throw new AppError('UNSUPPORTED_AI_PROVIDER', 500, `Unknown AI provider: ${provider}`);
  }
}
