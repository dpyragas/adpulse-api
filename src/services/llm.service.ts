import { generateObject } from 'ai';
import { z } from 'zod';
import { getModel } from '../lib/ai.js';
import { logger } from '../lib/logger.js';
import type { ScoringResult } from '../types/scoring.js';
import type { MlPipelineResult, PipelineResponse } from '../types/ml.js';
import type { Insights } from '../types/insights.js';
import type { ClassificationResult } from '../types/classification.js';

const InsightsResponseSchema = z.object({
  summary: z.string().describe('1 sentence overall assessment an advertiser can understand'),
  working: z.array(z.string()).min(1).max(3).describe('2-3 things the ad does well'),
  issues: z.array(z.string()).min(1).max(3).describe('2-3 problems, ordered by severity'),
  recommendations: z.array(z.object({
    text: z.string().describe('Actionable recommendation'),
    impact: z.enum(['high', 'medium', 'low']).describe('Expected impact on overall score based on scoring weights'),
    element: z.string().describe('Which element this targets: cta, branding, headline, body_text, aesthetic'),
  })).min(2).max(4).describe('2-4 fixes ordered by impact (highest first)'),
  platformTips: z.array(z.string()).min(1).max(2).describe('1-2 platform-specific tips'),
});

const SYSTEM_PROMPT = `You are an expert ad creative analyst helping advertisers improve their ads. Given structured analysis data, generate clear, actionable insights an advertiser can act on TODAY.

Rules:
- Write for a non-technical advertiser, not a data scientist
- Each insight: 1-2 sentences, reference specific elements and numbers
- Recommendations MUST be ordered by impact (biggest scoring weight first)
- Explain attention percentages naturally (e.g. "only 1 in 1000 viewers notice your CTA")
- Platform tips: 1-2 specific, platform-relevant tips — keep them short
- Use the scoring context to explain WHY scores are low, not just THAT they are
- Ground everything in the ML data — never speculate or estimate numbers you weren't given
- When category data is available, tailor advice to that industry
- Do NOT fabricate score predictions or improvement estimates`;

function buildUserPrompt(
  scoringResult: ScoringResult,
  mlResult: MlPipelineResult,
  platform: string,
  classification?: ClassificationResult | null,
): string {
  const { overallScore, verdict, subScores, elements, issues, platformModifiers } = scoringResult;

  // Attention hierarchy — sorted descending
  const attentionHierarchy = [...elements]
    .filter((el) => el.found)
    .sort((a, b) => b.attentionPercent - a.attentionPercent)
    .map((el, i) => `  ${i + 1}. ${el.type}: ${el.attentionPercent}%`)
    .join('\n');

  const missingElements = elements
    .filter((el) => !el.found)
    .map((el) => el.type);

  const issueLines = issues.length > 0
    ? issues.map((iss) => `- [${iss.severity}] ${iss.element}: ${iss.message}`).join('\n')
    : '- No critical issues detected';

  // Score gap analysis — find biggest opportunities
  const scoreGaps = [
    { name: 'Attention', score: subScores.attention, weight: platformModifiers.attention },
    { name: 'Branding', score: subScores.branding, weight: platformModifiers.branding },
    { name: 'Message', score: subScores.message, weight: platformModifiers.message },
    { name: 'Aesthetic', score: subScores.aesthetic, weight: platformModifiers.aesthetic },
  ]
    .map((s) => ({ ...s, gap: (10 - s.score) * s.weight }))
    .sort((a, b) => b.gap - a.gap);

  const gapLines = scoreGaps
    .map((s) => `  ${s.name}: ${s.score}/10 (weight ${(s.weight * 100).toFixed(0)}%) — gap: ${s.gap.toFixed(1)} points`)
    .join('\n');

  let classificationBlock = '';
  if (classification) {
    const parts: string[] = [];
    if (classification.sentiment) {
      const { primary, secondary, scores } = classification.sentiment;
      const primaryScore = scores[primary] ?? 0;
      const secondaryScore = scores[secondary] ?? 0;
      parts.push(`Emotional Tone: ${primary} (${(primaryScore * 100).toFixed(0)}%), ${secondary} (${(secondaryScore * 100).toFixed(0)}%)`);
    }
    if (classification.category && classification.category.levels.length > 0) {
      const categoryPath = classification.category.levels.map((l) => l.label).join(' → ');
      parts.push(`Ad Category: ${categoryPath}`);
    }
    if (parts.length > 0) {
      classificationBlock = `\n\n${parts.join('\n')}`;
    }
  }

  return `Ad Analysis Results:
- Platform: ${platform}
- Overall Score: ${overallScore}/10 (${verdict})
- Verdict scale: ≥8 Strong, ≥5 Good, <5 Needs Work
- Sub-Scores: Attention ${subScores.attention}, Branding ${subScores.branding}, Message ${subScores.message}, Aesthetic ${subScores.aesthetic} (each out of 10)

Attention Hierarchy (where viewers look, sorted):
${attentionHierarchy || '  (no elements detected)'}${missingElements.length > 0 ? `\n  Missing: ${missingElements.join(', ')}` : ''}

Issues:
${issueLines}

Score Gap Analysis (biggest improvement opportunities first):
${gapLines}

Scoring Context:
- CTA drives 50% of Message score, headline 30%, text clarity 20%
- Branding score floors at 2.0/10 when logo is not found
- CTA below 2% attention triggers a critical scoring penalty
- Platform weights: Attention ${(platformModifiers.attention * 100).toFixed(0)}%, Branding ${(platformModifiers.branding * 100).toFixed(0)}%, Message ${(platformModifiers.message * 100).toFixed(0)}%, Aesthetic ${(platformModifiers.aesthetic * 100).toFixed(0)}%${classificationBlock}`;
}

// ── AOI Validation ──

const ValidationSchema = z.object({
  cta: z.object({
    found: z.boolean().describe('Is there a call-to-action in the image?'),
    text: z.string().nullable().describe('CTA text if found, null if not'),
    bboxIndex: z.number().nullable().describe('Index into allTextRegions for the CTA text, null if not in list'),
  }),
  headline: z.object({
    found: z.boolean().describe('Is there a headline in the image?'),
    text: z.string().nullable().describe('Headline text if found, null if not'),
    bboxIndex: z.number().nullable().describe('Index into allTextRegions for the headline text, null if not in list'),
  }),
  branding: z.object({
    found: z.boolean().describe('Is brand/logo visible in the image?'),
  }),
  category: z.object({
    level1: z.string().describe('Top-level ad category (e.g. Cosmetics, Electronics, Food)'),
    level2: z.string().nullable().describe('Sub-category if identifiable, null if not'),
  }).nullable().describe('What product/service is being advertised, null if unclear'),
  corrected: z.boolean().describe('Did you change anything from the ML results?'),
  reasoning: z.string().describe('Brief explanation of corrections made'),
});

const VALIDATION_SYSTEM_PROMPT = `You are an ad creative analysis validator. You receive an ad image alongside ML model detection results. Your job is to verify and correct misclassifications.

Rules:
1. CTA: Identify the call-to-action — actionable text like "Sign Up", "Shop Now", "Learn More", "Buy Now", "Get Started". Navigation labels, brand names, and badges are NOT CTAs.
2. Headline: The main marketing copy — the largest/most prominent text that communicates the key message or value proposition.
3. Branding: Is a brand logo or brand name visible? The ML model may have detected the wrong region or missed it entirely.
4. Category: Classify by what is BEING SOLD/ADVERTISED, not by scene props. A perfume ad with wine glasses is Cosmetics, not Drinks.

You receive allTextRegions with 0-based indices. When identifying CTA or headline text, return bboxIndex pointing to the matching region in allTextRegions. If the text is not in allTextRegions (e.g. embedded in logo/image), set bboxIndex to null.

Only set corrected=true if you changed something from the ML output. Be conservative — only correct clear mistakes.`;

function buildValidationPrompt(mlResult: MlPipelineResult): string {
  const aois = mlResult.aois;
  const textRegions = mlResult.allTextRegions ?? [];

  const regionLines = textRegions.map((r, i) =>
    `  [${i}] "${r.text}" (confidence: ${r.confidence.toFixed(2)}, bbox: [${r.bbox.join(',')}])`
  ).join('\n');

  const mlDetections = [
    `ML CTA: ${aois?.cta?.found ? `"${(aois.cta as { text?: string }).text ?? 'no text'}"` : 'not found'}`,
    `ML Headline: ${aois?.headline?.found ? `"${(aois.headline as { text?: string }).text ?? 'no text'}"` : 'not found'}`,
    `ML Branding: ${aois?.branding?.found ? 'found' : 'not found'}`,
    `ML Category: ${mlResult.classification?.category?.levels.map(l => l.label).join(' → ') ?? 'unknown'}`,
  ].join('\n');

  return `ML Detection Results:\n${mlDetections}\n\nAll Detected Text Regions:\n${regionLines || '  (none detected)'}`;
}

function mergeValidation(
  mlResult: MlPipelineResult,
  validation: z.infer<typeof ValidationSchema>,
): { aois: PipelineResponse['aois']; classification: ClassificationResult | null } {
  const aois = { ...mlResult.aois! };
  const textRegions = mlResult.allTextRegions ?? [];

  // Merge CTA
  if (validation.cta.found) {
    if (validation.cta.bboxIndex != null && textRegions[validation.cta.bboxIndex]) {
      const region = textRegions[validation.cta.bboxIndex];
      aois.cta = { found: true, bbox: region.bbox, text: region.text, confidence: region.confidence };
    } else if (validation.cta.text) {
      aois.cta = { found: true, text: validation.cta.text, ...(aois.cta?.found ? { bbox: aois.cta.bbox, confidence: aois.cta.confidence } : {}) };
    }
  } else {
    aois.cta = { found: false };
  }

  // Merge headline
  if (validation.headline.found) {
    if (validation.headline.bboxIndex != null && textRegions[validation.headline.bboxIndex]) {
      const region = textRegions[validation.headline.bboxIndex];
      aois.headline = { found: true, bbox: region.bbox, text: region.text, confidence: region.confidence };
    } else if (validation.headline.text) {
      aois.headline = { found: true, text: validation.headline.text, ...(aois.headline?.found ? { bbox: aois.headline.bbox, confidence: aois.headline.confidence } : {}) };
    }
  } else {
    aois.headline = { found: false };
  }

  // Merge branding
  if (!validation.branding.found) {
    aois.branding = { found: false };
  }
  // If LLM says found and ML already found, keep ML bbox (LLM can't produce reliable coords)

  // Merge category
  let classification = mlResult.classification;
  if (validation.category) {
    const levels = [{ level: 1, label: validation.category.level1, confidence: 0.9 }];
    if (validation.category.level2) {
      levels.push({ level: 2, label: validation.category.level2, confidence: 0.85 });
    }
    classification = {
      sentiment: classification?.sentiment ?? null,
      category: { levels },
    };
  }

  return { aois, classification };
}

export async function validatePipelineResults(
  imageBase64: string,
  mlResult: MlPipelineResult,
  analysisId: string,
): Promise<{ aois: PipelineResponse['aois']; classification: ClassificationResult | null; corrected: boolean; reasoning: string }> {
  if (!process.env.OPENAI_API_KEY) {
    return { aois: mlResult.aois!, classification: mlResult.classification, corrected: false, reasoning: 'No API key' };
  }

  const { object } = await generateObject({
    model: getModel(),
    schema: ValidationSchema,
    system: VALIDATION_SYSTEM_PROMPT,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'image', image: imageBase64 },
          { type: 'text', text: buildValidationPrompt(mlResult) },
        ],
      },
    ],
  });

  logger.info('AOI validation completed', { analysisId, corrected: object.corrected, reasoning: object.reasoning });

  if (!object.corrected) {
    return { aois: mlResult.aois!, classification: mlResult.classification, corrected: false, reasoning: object.reasoning };
  }

  const merged = mergeValidation(mlResult, object);
  return { ...merged, corrected: true, reasoning: object.reasoning };
}

// ── Insights Generation ──

export async function generateInsights(
  scoringResult: ScoringResult,
  mlResult: MlPipelineResult,
  platform: string,
  analysisId: string,
  classification?: ClassificationResult | null,
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
      prompt: buildUserPrompt(scoringResult, mlResult, platform, classification),
    });

    logger.info('Insights generated', { analysisId });
    return { unavailable: false, ...object };
  } catch (error) {
    logger.warn('Insights generation failed, degrading gracefully', { analysisId, error: String(error) });
    return { unavailable: true, message: 'Insights temporarily unavailable' };
  }
}
