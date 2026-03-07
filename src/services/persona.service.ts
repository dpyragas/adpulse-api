import { generateObject } from 'ai';
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
