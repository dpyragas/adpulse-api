import { generateObject } from 'ai';
import { z } from 'zod';
import { getModel } from '../lib/ai.js';
import { logger } from '../lib/logger.js';
import type { ScoringResult } from '../types/scoring.js';
import type { MlPipelineResult } from '../types/ml.js';
import type { Insights } from '../types/insights.js';

const InsightsResponseSchema = z.object({
  working: z.array(z.string()).min(1).describe('2-4 things the ad does well'),
  issues: z.array(z.string()).min(1).describe('2-4 problems or weaknesses'),
  recommendations: z.array(z.string()).min(1).describe('2-4 actionable improvements'),
  platformNotes: z.string().describe('Platform-specific observations'),
});

const SYSTEM_PROMPT = `You are an expert ad creative analyst. Given structured analysis data (attention scores, detected elements, issues, and platform context), generate actionable insights.

Rules:
- Each insight should be 1-2 sentences, specific and actionable
- Reference specific elements and scores when relevant
- Platform notes should reference platform-specific best practices
- Be direct and practical, not generic or vague
- Generate 2-4 items per category`;

function buildUserPrompt(
  scoringResult: ScoringResult,
  mlResult: MlPipelineResult,
  platform: string,
): string {
  const { overallScore, verdict, subScores, elements, issues, platformModifiers } = scoringResult;

  const elementLines = elements
    .map((el) => `- ${el.type}: ${el.found ? `found, ${el.attentionPercent}% attention` : 'not found'}`)
    .join('\n');

  const issueLines = issues.length > 0
    ? issues.map((iss) => `- [${iss.severity}] ${iss.element}: ${iss.message}`).join('\n')
    : '- No critical issues detected';

  return `Ad Analysis Results:
- Platform: ${platform}
- Overall Score: ${overallScore}/10 (${verdict})
- Sub-Scores: Attention ${subScores.attention}, Branding ${subScores.branding}, Message ${subScores.message}, Aesthetic ${subScores.aesthetic}
- Pipeline Status: ${mlResult.pipelineStatus.pipeline}/${mlResult.pipelineStatus.sum}

Detected Elements:
${elementLines}

Critical Issues:
${issueLines}

Platform Weight Profile: Attention ${platformModifiers.attention}, Branding ${platformModifiers.branding}, Message ${platformModifiers.message}, Aesthetic ${platformModifiers.aesthetic}`;
}

export async function generateInsights(
  scoringResult: ScoringResult,
  mlResult: MlPipelineResult,
  platform: string,
  analysisId: string,
): Promise<Insights> {
  try {
    if (!process.env.OPENAI_API_KEY) {
      logger.warn('OPENAI_API_KEY not configured, skipping insights', { analysisId });
      return { unavailable: true, message: 'Insights temporarily unavailable' };
    }

    const { object } = await generateObject({
      model: getModel(),
      schema: InsightsResponseSchema,
      system: SYSTEM_PROMPT,
      prompt: buildUserPrompt(scoringResult, mlResult, platform),
      temperature: 0.7,
    });

    logger.info('Insights generated', { analysisId });
    return { unavailable: false, ...object };
  } catch (error) {
    logger.warn('Insights generation failed, degrading gracefully', { analysisId, error: String(error) });
    return { unavailable: true, message: 'Insights temporarily unavailable' };
  }
}
