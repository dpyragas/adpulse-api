import { describe, it, expect, beforeEach, vi } from 'vitest';

const mockGenerateObject = vi.fn();
vi.mock('ai', () => ({
  generateObject: mockGenerateObject,
}));

vi.mock('../lib/ai.js', () => ({
  getModel: vi.fn().mockReturnValue('mock-model'),
}));

vi.mock('nanoid', () => ({
  nanoid: vi.fn().mockReturnValue('abc12345'),
}));

const {
  audienceProfileSchema,
  personaRequestSchema,
  personaSchema,
  personaArraySchema,
  buildPersonaPrompt,
  generatePersonas,
} = await import('./persona.service.js');

const validAudience = {
  ageRange: [18, 35] as [number, number],
  gender: 'mixed' as const,
  interests: ['fitness', 'nutrition', 'wellness'],
  platform: 'instagram' as const,
  buyingIntent: 'medium' as const,
  context: 'Health supplement ad targeting gym-goers',
};

const mockPersonas = [
  {
    id: 'llm-id-1',
    name: 'Alex Chen',
    age: 22,
    gender: 'male',
    occupation: 'Software Developer',
    personality: 'Analytical and methodical',
    browsingBehaviour: 'Quick scroll, stops for bold visuals',
    purchaseDrivers: 'Data-backed reviews and peer recommendations',
    attentionStyle: 'Scanner',
  },
  {
    id: 'llm-id-2',
    name: 'Maria Santos',
    age: 30,
    gender: 'female',
    occupation: 'Yoga Instructor',
    personality: 'Creative and empathetic',
    browsingBehaviour: 'Reads captions, saves posts for later',
    purchaseDrivers: 'Natural ingredients, brand values alignment',
    attentionStyle: 'Reader',
  },
  {
    id: 'llm-id-3',
    name: 'Jordan Kim',
    age: 26,
    gender: 'female',
    occupation: 'Marketing Manager',
    personality: 'Extroverted and impulsive',
    browsingBehaviour: 'Likes and comments frequently, shares stories',
    purchaseDrivers: 'Social proof and influencer endorsements',
    attentionStyle: 'Visual-first',
  },
];

beforeEach(() => {
  vi.clearAllMocks();
});

// ── Schema Validation Tests ──

describe('audienceProfileSchema', () => {
  it('validates a correct audience profile', () => {
    const result = audienceProfileSchema.safeParse(validAudience);
    expect(result.success).toBe(true);
  });

  it('rejects invalid ageRange (below min)', () => {
    const result = audienceProfileSchema.safeParse({
      ...validAudience,
      ageRange: [10, 35],
    });
    expect(result.success).toBe(false);
  });

  it('rejects invalid ageRange (above max)', () => {
    const result = audienceProfileSchema.safeParse({
      ...validAudience,
      ageRange: [18, 100],
    });
    expect(result.success).toBe(false);
  });

  it('rejects ageRange where min > max', () => {
    const result = audienceProfileSchema.safeParse({
      ...validAudience,
      ageRange: [35, 18],
    });
    expect(result.success).toBe(false);
  });

  it('rejects invalid gender value', () => {
    const result = audienceProfileSchema.safeParse({
      ...validAudience,
      gender: 'other',
    });
    expect(result.success).toBe(false);
  });

  it('rejects empty interests array', () => {
    const result = audienceProfileSchema.safeParse({
      ...validAudience,
      interests: [],
    });
    expect(result.success).toBe(false);
  });
});

describe('personaRequestSchema', () => {
  it('validates with default personaCount', () => {
    const result = personaRequestSchema.safeParse({ audience: validAudience });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.personaCount).toBe(5);
    }
  });

  it('rejects personaCount below min (2)', () => {
    const result = personaRequestSchema.safeParse({
      audience: validAudience,
      personaCount: 1,
    });
    expect(result.success).toBe(false);
  });

  it('rejects personaCount above max (8)', () => {
    const result = personaRequestSchema.safeParse({
      audience: validAudience,
      personaCount: 9,
    });
    expect(result.success).toBe(false);
  });
});

// ── Prompt Building Tests ──

describe('buildPersonaPrompt', () => {
  it('includes diversity instructions', () => {
    const prompt = buildPersonaPrompt(validAudience, 3);
    expect(prompt).toContain('Diversity Requirements');
    expect(prompt).toContain('Scanner');
    expect(prompt).toContain('Reader');
    expect(prompt).toContain('Visual-first');
  });

  it('includes platform-specific context', () => {
    const prompt = buildPersonaPrompt(validAudience, 3);
    expect(prompt).toContain('instagram');
    expect(prompt).toContain('quick thumb-scroll');
  });

  it('includes persona count and audience details', () => {
    const prompt = buildPersonaPrompt(validAudience, 4);
    expect(prompt).toContain('Generate 4 diverse personas');
    expect(prompt).toContain('18-35');
    expect(prompt).toContain('fitness');
    expect(prompt).toContain('medium');
  });

  it('includes gender mixing instruction for mixed', () => {
    const prompt = buildPersonaPrompt(validAudience, 3);
    expect(prompt).toContain('approximately equal mix of male and female');
  });

  it('specifies single gender when not mixed', () => {
    const prompt = buildPersonaPrompt({ ...validAudience, gender: 'female' as const }, 3);
    expect(prompt).toContain('All personas should be female');
  });
});

// ── Generation Tests ──

describe('generatePersonas', () => {
  it('returns personas with reassigned IDs on success', async () => {
    mockGenerateObject.mockResolvedValue({ object: { personas: mockPersonas } });

    const result = await generatePersonas(validAudience, 3);

    expect(result).toHaveLength(3);
    // IDs should be reassigned by nanoid, not LLM-generated
    result.forEach((p) => {
      expect(p.id).toBe('abc12345');
    });
    expect(result[0].name).toBe('Alex Chen');
    expect(result[1].occupation).toBe('Yoga Instructor');
  });

  it('calls generateObject with model and schema', async () => {
    mockGenerateObject.mockResolvedValue({ object: { personas: mockPersonas } });

    await generatePersonas(validAudience, 3);

    const call = mockGenerateObject.mock.calls[0][0];
    expect(call.model).toBe('mock-model');
    expect(call.schema).toBeDefined();
    expect(call.system).toContain('consumer psychologist');
    expect(call.prompt).toContain('Generate 3 diverse personas');
  });

  it('throws AppError with PERSONA_GENERATION_FAILED on API error', async () => {
    mockGenerateObject.mockRejectedValue(new Error('API error'));

    await expect(generatePersonas(validAudience, 3))
      .rejects
      .toMatchObject({
        code: 'PERSONA_GENERATION_FAILED',
        status: 502,
      });
  });
});

// ── Persona Schema Tests ──

describe('personaSchema', () => {
  it('validates a correct persona object', () => {
    const result = personaSchema.safeParse(mockPersonas[0]);
    expect(result.success).toBe(true);
  });

  it('rejects persona missing required fields', () => {
    const { name, ...rest } = mockPersonas[0];
    const result = personaSchema.safeParse(rest);
    expect(result.success).toBe(false);
  });
});

describe('personaArraySchema', () => {
  it('validates array of personas', () => {
    const result = personaArraySchema.safeParse({ personas: mockPersonas });
    expect(result.success).toBe(true);
  });
});
