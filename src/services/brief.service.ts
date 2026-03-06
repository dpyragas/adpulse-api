import { generateObject } from 'ai';
import { z } from 'zod';
import { getModel } from '../lib/ai.js';
import { AppError } from '../lib/app-error.js';
import { logger } from '../lib/logger.js';

// ── Creative Brief Schema (AC #2) ──

export const creativeBriefSchema = z.object({
  summary: z.string().describe('Overall brief summary — what the ad needs most'),
  changes: z.array(z.object({
    priority: z.enum(['critical', 'high', 'medium']).describe('Change priority'),
    element: z.enum(['CTA', 'Headline', 'Logo', 'Product', 'Background']).describe('Which element to change'),
    currentState: z.string().describe('What is happening now with this element'),
    recommendation: z.string().describe('What to change'),
    specificDetails: z.string().optional().describe('Position, size, color, or text suggestions'),
    expectedImpact: z.string().describe('Predicted improvement from this change'),
  })).describe('Recommended changes ordered by priority'),
  designNotes: z.string().describe('Overall composition and layout advice'),
  platformTips: z.string().describe('Platform-specific format and placement advice'),
});

export type CreativeBrief = z.infer<typeof creativeBriefSchema>;

// ── Brief Generation ──

const BRIEF_SYSTEM_PROMPT = `You are an expert ad creative director. Generate a specific, actionable creative brief with concrete changes to improve the ad.

Rules:
- Be precise about positions, sizes, colors, and text
- Reference actual attention data and scores provided
- Order changes by priority (critical first)
- Keep recommendations concrete — a designer should be able to act on each one immediately
- Platform tips must be specific to the given platform
- Do NOT fabricate numbers or scores you weren't given`;

interface AnalysisResults {
  scoring?: {
    overallScore?: number;
    verdict?: string;
    subScores?: Record<string, number>;
    elements?: Array<{ type: string; found: boolean; attentionPercent?: number }>;
    issues?: Array<{ severity: string; element: string; message: string }>;
    platformModifiers?: Record<string, number>;
  };
  insights?: {
    summary?: string;
    issues?: string[];
    recommendations?: Array<{ text: string; impact: string; element: string }>;
  };
  classification?: {
    sentiment?: { primary: string };
    category?: { levels: Array<{ label: string }> };
  };
}

export function buildBriefPrompt(results: AnalysisResults, platform: string): string {
  const scoring = results.scoring;
  if (!scoring) return 'No scoring data available.';

  const attentionHierarchy = (scoring.elements ?? [])
    .filter((el) => el.found)
    .sort((a, b) => (b.attentionPercent ?? 0) - (a.attentionPercent ?? 0))
    .map((el, i) => `  ${i + 1}. ${el.type}: ${el.attentionPercent ?? 0}%`)
    .join('\n');

  const missingElements = (scoring.elements ?? [])
    .filter((el) => !el.found)
    .map((el) => el.type);

  const issueLines = (scoring.issues ?? []).length > 0
    ? (scoring.issues ?? []).map((iss) => `- [${iss.severity}] ${iss.element}: ${iss.message}`).join('\n')
    : '- No critical issues detected';

  const subScores = scoring.subScores ?? {};
  const subScoreLines = Object.entries(subScores)
    .map(([name, score]) => `  ${name}: ${score}/10 (gap: ${(10 - score).toFixed(1)})`)
    .join('\n');

  let classificationBlock = '';
  if (results.classification) {
    const parts: string[] = [];
    if (results.classification.sentiment?.primary) {
      parts.push(`Emotional Tone: ${results.classification.sentiment.primary}`);
    }
    if (results.classification.category?.levels?.length) {
      parts.push(`Category: ${results.classification.category.levels.map((l) => l.label).join(' → ')}`);
    }
    if (parts.length > 0) classificationBlock = `\n\n${parts.join('\n')}`;
  }

  return `Ad Analysis Results:
- Platform: ${platform}
- Overall Score: ${scoring.overallScore ?? 'N/A'}/10 (${scoring.verdict ?? 'N/A'})

Attention Hierarchy (where viewers look):
${attentionHierarchy || '  (no elements detected)'}${missingElements.length > 0 ? `\n  Missing elements: ${missingElements.join(', ')}` : ''}

Issues:
${issueLines}

Sub-Scores (gap to perfect 10):
${subScoreLines || '  (no sub-scores)'}${classificationBlock}

Generate a creative brief with specific, actionable changes to improve this ad.`;
}

export async function generateCreativeBrief(
  results: AnalysisResults,
  platform: string,
  analysisId: string,
): Promise<CreativeBrief> {
  try {
    const { object } = await generateObject({
      model: getModel(),
      schema: creativeBriefSchema,
      system: BRIEF_SYSTEM_PROMPT,
      prompt: buildBriefPrompt(results, platform),
    });

    logger.info('Creative brief generated', { analysisId });
    return object;
  } catch (error) {
    logger.error('Creative brief generation failed', { analysisId, error: String(error) });
    throw new AppError('BRIEF_GENERATION_FAILED', 502, 'Creative brief generation failed. Please try again.');
  }
}
