import { generateObject } from 'ai';
import { Agent } from '@mastra/core/agent';
import { z } from 'zod';
import { nanoid } from 'nanoid';
import { getModel } from '../lib/ai.js';
import { AppError } from '../lib/app-error.js';
import { logger } from '../lib/logger.js';

// ── Audience & Persona Schemas (AC #1, #3) ──

export const audienceProfileSchema = z.object({
  ageRange: z.tuple([z.number().min(13).max(99), z.number().min(13).max(99)]).refine(
    ([min, max]) => min <= max,
    'Min age must be ≤ max age',
  ),
  gender: z.enum(['male', 'female', 'mixed']),
  interests: z.array(z.string().min(1).max(50)).min(1).max(10),
  platform: z.enum(['instagram', 'facebook', 'tiktok', 'linkedin', 'youtube', 'x']),
  buyingIntent: z.enum(['low', 'medium', 'high']),
  context: z.string().min(3).max(200),
});

export const personaRequestSchema = z.object({
  audience: audienceProfileSchema,
  personaCount: z.number().int().min(2).max(8).default(5),
});

export const personaSchema = z.object({
  id: z.string(),
  name: z.string(),
  age: z.number(),
  gender: z.string(),
  occupation: z.string(),
  personality: z.string(),
  browsingBehaviour: z.string(),
  purchaseDrivers: z.string(),
  attentionStyle: z.string(),
});

export const personaArraySchema = z.object({
  personas: z.array(personaSchema),
});

export type AudienceProfile = z.infer<typeof audienceProfileSchema>;
export type PersonaRequest = z.infer<typeof personaRequestSchema>;
export type Persona = z.infer<typeof personaSchema>;

// ── Prompt Building ──

const PERSONA_SYSTEM_PROMPT = `You are a consumer psychologist and market researcher. Generate realistic, diverse audience personas for ad creative testing.

Rules:
- Each persona must feel like a real individual, not a stereotype
- Vary attention styles across: "Scanner" (glances quickly), "Reader" (reads text carefully), "Visual-first" (drawn to images/colors)
- Make personas genuinely different from each other in personality, occupation, and browsing behavior
- Generate the id field as a placeholder — it will be replaced post-generation
- Keep all text fields concise but specific`;

const PLATFORM_BEHAVIORS: Record<string, string> = {
  instagram: 'Instagram: quick thumb-scroll, story taps, visual-first feed browsing',
  facebook: 'Facebook: mixed feed with text posts, longer dwell time, comment-reading',
  tiktok: 'TikTok: rapid vertical swipe, sound-on, short attention bursts',
  linkedin: 'LinkedIn: deliberate professional reading, longer content engagement',
  youtube: 'YouTube: pre-roll skip decisions, thumbnail scanning, sidebar browsing',
  x: 'X/Twitter: rapid timeline scroll, text-heavy scanning, thread reading',
};

export function buildPersonaPrompt(audience: AudienceProfile, personaCount: number): string {
  const genderInstruction = audience.gender === 'mixed'
    ? 'Generate an approximately equal mix of male and female personas.'
    : `All personas should be ${audience.gender}.`;

  return `Generate ${personaCount} diverse personas for ad testing.

Target Audience:
- Age Range: ${audience.ageRange[0]}-${audience.ageRange[1]} years old
- Gender: ${audience.gender} — ${genderInstruction}
- Interests: ${audience.interests.join(', ')}
- Platform: ${audience.platform} — ${PLATFORM_BEHAVIORS[audience.platform]}
- Buying Intent: ${audience.buyingIntent}
- Context: ${audience.context}

Diversity Requirements:
- Distribute ages across the full ${audience.ageRange[0]}-${audience.ageRange[1]} range, not clustered at the midpoint
- Each persona should emphasize a different subset of interests: ${audience.interests.join(', ')}
- Vary occupations widely — avoid repeating similar job types
- Mix personality types (introvert/extrovert, analytical/creative, impulsive/deliberate)
- Vary attention styles: include Scanner, Reader, and Visual-first types
- Buying intent baseline is "${audience.buyingIntent}" but vary individual purchase drivers
- Browsing behavior should reflect the ${audience.platform} platform context`;
}

// ── Diversity Validation ──

function validateDiversity(personas: Persona[]): void {
  const signatures = personas.map((p) => `${p.age}-${p.occupation}-${p.attentionStyle}`);
  const unique = new Set(signatures);
  if (unique.size < personas.length) {
    logger.warn('Persona diversity warning: duplicate (age+occupation+attentionStyle) detected', {
      total: personas.length,
      unique: unique.size,
    });
  }
}

// ── Generation Service (AC #2, #4) ──

export async function generatePersonas(audience: AudienceProfile, personaCount: number): Promise<Persona[]> {
  try {
    const { object } = await generateObject({
      model: getModel(),
      schema: personaArraySchema,
      system: PERSONA_SYSTEM_PROMPT,
      prompt: buildPersonaPrompt(audience, personaCount),
    });

    const personas = object.personas.map((p) => ({
      ...p,
      id: nanoid(8),
    }));

    validateDiversity(personas);

    logger.info('Personas generated', { count: personas.length });
    return personas;
  } catch (error) {
    logger.error('Persona generation failed', { error: String(error) });
    throw new AppError('PERSONA_GENERATION_FAILED', 502, 'Persona generation failed. Please try again.');
  }
}

// ── Reaction Schemas (AC #3, #4) ──

export const reactionSchema = z.object({
  personaId: z.string(),
  initialReaction: z.string(),
  attentionNarrative: z.string(),
  emotionalResponse: z.string(),
  actionLikelihood: z.enum(['would_click', 'might_click', 'would_scroll_past']),
  reasoning: z.string(),
  suggestion: z.string(),
});

export const reactionSummarySchema = z.object({
  sentimentSplit: z.object({
    wouldClick: z.number().int().min(0),
    mightClick: z.number().int().min(0),
    wouldScrollPast: z.number().int().min(0),
  }),
  commonThemes: z.array(z.string()).min(1).max(10),
  keyQuotes: z.array(z.object({
    personaName: z.string(),
    quote: z.string(),
  })).min(1).max(5),
  actionabilityScore: z.number().min(1).max(10),
  overallVerdict: z.string(),
});

export type PersonaReaction = z.infer<typeof reactionSchema>;
export type ReactionSummary = z.infer<typeof reactionSummarySchema>;

// ── Analysis Data for Prompts ──

export interface AnalysisDataForReaction {
  overallScore: number;
  subScores: Record<string, number>;
  elements: Array<{ label: string; attentionPercent: number; position?: string; size?: string }>;
  attentionSummary: string;
  sentiment: string;
  category: string;
  verdict: string;
  platform: string;
}

// ── Persona Agent Factory (AC #1, #2) ──

export function buildPersonaInstructions(persona: Persona, platform: string, context: string): string {
  return `You are ${persona.name}, a ${persona.age}-year-old ${persona.occupation} (${persona.gender}).
Personality: ${persona.personality}
How you browse ${platform}: ${persona.browsingBehaviour}
What makes you buy: ${persona.purchaseDrivers}
Your attention style: ${persona.attentionStyle}

You are scrolling your ${platform} feed. ${context}.
React to an ad based ONLY on the objective data provided.
Do not describe or imagine the image — use only the attention and element data given to you.
Stay in character. Your reaction should reflect YOUR personality and browsing habits.`;
}

export function buildReactionPrompt(persona: Persona, data: AnalysisDataForReaction): string {
  const elementsBlock = data.elements
    .map((el) => `  - ${el.label}: ${el.attentionPercent}% attention${el.position ? `, position: ${el.position}` : ''}${el.size ? `, size: ${el.size}` : ''}`)
    .join('\n');

  const subScoreBlock = Object.entries(data.subScores)
    .map(([name, score]) => `  - ${name}: ${score}/10`)
    .join('\n');

  return `You are viewing an ad on ${data.platform}. Here is the objective analysis data:

Overall Score: ${data.overallScore}/10 (${data.verdict})

Sub-Scores:
${subScoreBlock}

Attention Heatmap Summary: ${data.attentionSummary}

Detected Elements (with attention share):
${elementsBlock}

Sentiment: ${data.sentiment}
Category: ${data.category}

React ONLY to the data provided. Do not imagine or describe the image.
Respond as ${persona.name} — stay fully in character.`;
}

export function buildPersonaAgent(persona: Persona, platform: string, context: string): Agent {
  return new Agent({
    id: `persona-${persona.id}`,
    name: persona.name,
    instructions: buildPersonaInstructions(persona, platform, context),
    model: {
      id: 'anthropic/claude-sonnet-4-20250514',
      apiKey: process.env.ANTHROPIC_API_KEY,
    },
  });
}

// ── Reaction Pipeline (AC #1, #2, #3) ──

const reactionOutputSchema = reactionSchema.omit({ personaId: true });

export async function generateReactions(
  personas: Persona[],
  analysisData: AnalysisDataForReaction,
  audience: AudienceProfile,
  analysisId?: string,
): Promise<PersonaReaction[]> {
  const reactions: (PersonaReaction | null)[] = [];

  // Sequential execution to avoid Anthropic rate limits
  for (const persona of personas) {
    try {
      const agent = buildPersonaAgent(persona, audience.platform, audience.context);
      const result = await agent.generate(buildReactionPrompt(persona, analysisData), {
        structuredOutput: { schema: reactionOutputSchema },
      });
      reactions.push({ ...result.object, personaId: persona.id });
      logger.info('Persona reaction generated', { analysisId, personaId: persona.id, personaName: persona.name });
    } catch (error) {
      logger.error('Persona reaction failed', { analysisId, personaId: persona.id, personaName: persona.name, error: String(error) });
      reactions.push(null);
    }
  }

  const validReactions = reactions.filter((r): r is PersonaReaction => r !== null);

  if (validReactions.length === 0) {
    throw new AppError('REACTION_GENERATION_FAILED', 502, 'Persona reaction pipeline failed. Please try again.');
  }

  logger.info('Reactions generated', { total: personas.length, successful: validReactions.length });
  return validReactions;
}

// ── Reaction Summary Aggregation (AC #4) ──

function buildSummaryPrompt(reactions: PersonaReaction[], personas: Persona[]): string {
  const personaMap = new Map(personas.map((p) => [p.id, p.name]));

  const reactionBlocks = reactions
    .map((r) => {
      const name = personaMap.get(r.personaId) ?? 'Unknown';
      return `${name} (${r.actionLikelihood}):
  Initial Reaction: ${r.initialReaction}
  Emotional Response: ${r.emotionalResponse}
  Reasoning: ${r.reasoning}
  Suggestion: ${r.suggestion}`;
    })
    .join('\n\n');

  return `Analyze these ${reactions.length} persona reactions to an ad and generate a summary.

${reactionBlocks}

Provide:
- Common themes across all reactions
- 2-3 most impactful direct quotes from the personas (use their exact words from initialReaction or emotionalResponse)
- An overall actionability score (1-10) reflecting how likely this ad is to drive action
- A one-sentence verdict summarizing the overall audience reception`;
}

export async function generateReactionSummary(
  reactions: PersonaReaction[],
  personas: Persona[],
): Promise<ReactionSummary> {
  // Compute sentiment split from actionLikelihood counts (no LLM needed)
  const wouldClick = reactions.filter((r) => r.actionLikelihood === 'would_click').length;
  const mightClick = reactions.filter((r) => r.actionLikelihood === 'might_click').length;
  const wouldScrollPast = reactions.filter((r) => r.actionLikelihood === 'would_scroll_past').length;

  try {
    const { object } = await generateObject({
      model: getModel(),
      schema: reactionSummarySchema.omit({ sentimentSplit: true }),
      prompt: buildSummaryPrompt(reactions, personas),
    });

    const summary: ReactionSummary = {
      sentimentSplit: { wouldClick, mightClick, wouldScrollPast },
      commonThemes: object.commonThemes,
      keyQuotes: object.keyQuotes,
      actionabilityScore: object.actionabilityScore,
      overallVerdict: object.overallVerdict,
    };

    logger.info('Reaction summary generated', { actionabilityScore: summary.actionabilityScore });
    return summary;
  } catch (error) {
    logger.error('Reaction summary generation failed', { error: String(error) });
    throw new AppError('REACTION_GENERATION_FAILED', 502, 'Reaction summary generation failed. Please try again.');
  }
}

// ── Extract Analysis Data for Reaction Prompts ──

export function extractAnalysisData(results: Record<string, unknown>, platform: string): AnalysisDataForReaction {
  const scoring = results.scoring as Record<string, unknown> | undefined;
  const classification = results.classification as Record<string, unknown> | undefined;
  const heatmap = results.heatmap as Record<string, unknown> | undefined;

  const subScoresRaw = (scoring?.subScores ?? {}) as Record<string, number>;
  const elementsRaw = (scoring?.elements ?? []) as Array<{
    type: string;
    found: boolean;
    attentionPercent?: number;
    position?: string;
    size?: string;
  }>;

  const elements = elementsRaw
    .filter((el) => el.found)
    .map((el) => ({
      label: el.type,
      attentionPercent: el.attentionPercent ?? 0,
      position: el.position,
      size: el.size,
    }));

  const sentimentObj = classification?.sentiment as Record<string, unknown> | undefined;
  const categoryObj = classification?.category as Record<string, unknown> | undefined;
  const categoryLevels = (categoryObj?.levels ?? []) as Array<{ label: string }>;

  return {
    overallScore: (scoring?.overallScore as number) ?? 0,
    subScores: subScoresRaw,
    elements,
    attentionSummary: (heatmap?.summary as string) ?? 'No heatmap summary available',
    sentiment: (sentimentObj?.primary as string) ?? 'unknown',
    category: categoryLevels.map((l) => l.label).join(' > ') || 'unknown',
    verdict: (scoring?.verdict as string) ?? 'unknown',
    platform,
  };
}
