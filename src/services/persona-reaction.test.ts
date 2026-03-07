import { describe, it, expect, beforeEach, vi } from 'vitest';

const mockGenerateObject = vi.fn();
vi.mock('ai', () => ({
  generateObject: mockGenerateObject,
}));

vi.mock('../lib/ai.js', () => ({
  getModel: vi.fn().mockReturnValue('mock-model'),
}));

const mockAgentGenerate = vi.fn();
vi.mock('@mastra/core/agent', () => {
  return {
    Agent: class MockAgent {
      id: string;
      name: string;
      instructions: string;
      model: unknown;
      constructor(config: Record<string, unknown>) {
        this.id = config.id as string;
        this.name = config.name as string;
        this.instructions = config.instructions as string;
        this.model = config.model;
        MockAgent._lastConfig = config;
        MockAgent._allConfigs.push(config);
      }
      generate = mockAgentGenerate;
      static _lastConfig: Record<string, unknown> | null = null;
      static _allConfigs: Record<string, unknown>[] = [];
    },
  };
});

vi.mock('nanoid', () => ({
  nanoid: vi.fn().mockReturnValue('abc12345'),
}));

const {
  reactionSchema,
  reactionSummarySchema,
  buildPersonaInstructions,
  buildReactionPrompt,
  buildPersonaAgent,
  generateReactions,
  generateReactionSummary,
  extractAnalysisData,
} = await import('./persona.service.js');

const { Agent: MockAgentClass } = await import('@mastra/core/agent') as unknown as {
  Agent: { _lastConfig: Record<string, unknown> | null; _allConfigs: Record<string, unknown>[] };
};

const mockPersonas = [
  {
    id: 'p1',
    name: 'Alex Chen',
    age: 22,
    gender: 'male',
    occupation: 'Software Developer',
    personality: 'Analytical and methodical',
    browsingBehaviour: 'Quick scroll, stops for bold visuals',
    purchaseDrivers: 'Data-backed reviews',
    attentionStyle: 'Scanner',
  },
  {
    id: 'p2',
    name: 'Maria Santos',
    age: 30,
    gender: 'female',
    occupation: 'Yoga Instructor',
    personality: 'Creative and empathetic',
    browsingBehaviour: 'Reads captions, saves posts',
    purchaseDrivers: 'Natural ingredients',
    attentionStyle: 'Reader',
  },
];

const mockAudience = {
  ageRange: [18, 35] as [number, number],
  gender: 'mixed' as const,
  interests: ['fitness', 'nutrition'],
  platform: 'instagram' as const,
  buyingIntent: 'medium' as const,
  context: 'Health supplement ad targeting gym-goers',
};

const mockAnalysisData = {
  overallScore: 7,
  subScores: { attention: 8, branding: 6, message: 7, aesthetic: 7 },
  elements: [
    { label: 'Product', attentionPercent: 45, position: 'center', size: 'large' },
    { label: 'Headline', attentionPercent: 25 },
    { label: 'CTA', attentionPercent: 5 },
  ],
  attentionSummary: '45% product, 25% headline, 5% CTA',
  sentiment: 'positive',
  category: 'Health & Fitness',
  verdict: 'Good',
  platform: 'instagram',
};

const mockReaction = {
  personaId: 'p1',
  initialReaction: 'This caught my eye briefly',
  attentionNarrative: 'The product image dominated my view',
  emotionalResponse: 'Mildly interested but skeptical',
  actionLikelihood: 'might_click' as const,
  reasoning: 'Product looks good but CTA is barely noticeable',
  suggestion: 'Make the CTA larger and more prominent',
};

beforeEach(() => {
  vi.clearAllMocks();
});

// ── Schema Validation Tests ──

describe('reactionSchema', () => {
  it('validates a correct reaction', () => {
    const result = reactionSchema.safeParse(mockReaction);
    expect(result.success).toBe(true);
  });

  it('rejects invalid actionLikelihood', () => {
    const result = reactionSchema.safeParse({
      ...mockReaction,
      actionLikelihood: 'would_buy',
    });
    expect(result.success).toBe(false);
  });

  it('accepts all valid actionLikelihood values', () => {
    for (const value of ['would_click', 'might_click', 'would_scroll_past']) {
      const result = reactionSchema.safeParse({ ...mockReaction, actionLikelihood: value });
      expect(result.success).toBe(true);
    }
  });
});

describe('reactionSummarySchema', () => {
  it('validates a correct summary', () => {
    const result = reactionSummarySchema.safeParse({
      sentimentSplit: { wouldClick: 2, mightClick: 1, wouldScrollPast: 0 },
      commonThemes: ['product visibility', 'weak CTA'],
      keyQuotes: [{ personaName: 'Alex', quote: 'CTA is tiny' }],
      actionabilityScore: 7,
      overallVerdict: 'Solid ad with room for CTA improvement',
    });
    expect(result.success).toBe(true);
  });

  it('rejects actionabilityScore out of bounds', () => {
    const below = reactionSummarySchema.safeParse({
      sentimentSplit: { wouldClick: 1, mightClick: 0, wouldScrollPast: 0 },
      commonThemes: ['test'],
      keyQuotes: [{ personaName: 'Alex', quote: 'test' }],
      actionabilityScore: 0,
      overallVerdict: 'Bad',
    });
    expect(below.success).toBe(false);

    const above = reactionSummarySchema.safeParse({
      sentimentSplit: { wouldClick: 1, mightClick: 0, wouldScrollPast: 0 },
      commonThemes: ['test'],
      keyQuotes: [{ personaName: 'Alex', quote: 'test' }],
      actionabilityScore: 11,
      overallVerdict: 'Great',
    });
    expect(above.success).toBe(false);
  });

  it('rejects empty keyQuotes and commonThemes arrays', () => {
    const emptyQuotes = reactionSummarySchema.safeParse({
      sentimentSplit: { wouldClick: 1, mightClick: 0, wouldScrollPast: 0 },
      commonThemes: ['test'],
      keyQuotes: [],
      actionabilityScore: 5,
      overallVerdict: 'OK',
    });
    expect(emptyQuotes.success).toBe(false);

    const emptyThemes = reactionSummarySchema.safeParse({
      sentimentSplit: { wouldClick: 1, mightClick: 0, wouldScrollPast: 0 },
      commonThemes: [],
      keyQuotes: [{ personaName: 'Alex', quote: 'test' }],
      actionabilityScore: 5,
      overallVerdict: 'OK',
    });
    expect(emptyThemes.success).toBe(false);
  });

  it('rejects negative sentimentSplit values', () => {
    const result = reactionSummarySchema.safeParse({
      sentimentSplit: { wouldClick: -1, mightClick: 0, wouldScrollPast: 0 },
      commonThemes: ['test'],
      keyQuotes: [{ personaName: 'Alex', quote: 'test' }],
      actionabilityScore: 5,
      overallVerdict: 'OK',
    });
    expect(result.success).toBe(false);
  });
});

// ── Prompt Building Tests ──

describe('buildPersonaInstructions', () => {
  it('includes persona personality traits', () => {
    const instructions = buildPersonaInstructions(mockPersonas[0], 'instagram', 'Scrolling feed');
    expect(instructions).toContain('Alex Chen');
    expect(instructions).toContain('22-year-old');
    expect(instructions).toContain('Software Developer');
    expect(instructions).toContain('Analytical and methodical');
    expect(instructions).toContain('Scanner');
    expect(instructions).toContain('instagram');
  });

  it('includes audience context', () => {
    const instructions = buildPersonaInstructions(mockPersonas[0], 'instagram', 'Health supplement ad');
    expect(instructions).toContain('Health supplement ad');
  });
});

describe('buildReactionPrompt', () => {
  it('includes attention data and scores', () => {
    const prompt = buildReactionPrompt(mockPersonas[0], mockAnalysisData);
    expect(prompt).toContain('7/10');
    expect(prompt).toContain('Good');
    expect(prompt).toContain('Product: 45% attention');
    expect(prompt).toContain('Headline: 25% attention');
    expect(prompt).toContain('attention: 8/10');
    expect(prompt).toContain('positive');
    expect(prompt).toContain('Health & Fitness');
  });

  it('includes instruction to not imagine image', () => {
    const prompt = buildReactionPrompt(mockPersonas[0], mockAnalysisData);
    expect(prompt).toContain('React ONLY to the data provided');
    expect(prompt).toContain('Do not imagine or describe the image');
  });

  it('addresses persona by name', () => {
    const prompt = buildReactionPrompt(mockPersonas[0], mockAnalysisData);
    expect(prompt).toContain('Alex Chen');
  });
});

// ── Agent Factory Tests ──

describe('buildPersonaAgent', () => {
  beforeEach(() => {
    MockAgentClass._allConfigs = [];
    MockAgentClass._lastConfig = null;
  });

  it('creates agent with correct config', () => {
    buildPersonaAgent(mockPersonas[0], 'instagram', 'Test context');
    const config = MockAgentClass._lastConfig!;
    expect(config.id).toBe('persona-p1');
    expect(config.name).toBe('Alex Chen');
    expect((config.model as Record<string, string>).id).toBe('anthropic/claude-sonnet-4-20250514');
  });

  it('generates correct agent ID format', () => {
    buildPersonaAgent(mockPersonas[1], 'facebook', 'Test');
    const config = MockAgentClass._lastConfig!;
    expect(config.id).toBe('persona-p2');
  });
});

// ── Pipeline Tests ──

describe('generateReactions', () => {
  it('returns reactions for all personas on success and overrides LLM personaId with persona.id', async () => {
    const { personaId: _, ...reactionWithoutId } = mockReaction;
    mockAgentGenerate
      .mockResolvedValueOnce({ object: reactionWithoutId })
      .mockResolvedValueOnce({ object: reactionWithoutId });

    const reactions = await generateReactions(mockPersonas, mockAnalysisData, mockAudience);
    expect(reactions).toHaveLength(2);
    expect(reactions[0].personaId).toBe('p1');
    expect(reactions[1].personaId).toBe('p2');
  });

  it('continues with remaining personas when one fails', async () => {
    mockAgentGenerate
      .mockRejectedValueOnce(new Error('Rate limit'))
      .mockResolvedValueOnce({ object: { ...mockReaction, personaId: 'p2' } });

    const reactions = await generateReactions(mockPersonas, mockAnalysisData, mockAudience);
    expect(reactions).toHaveLength(1);
    expect(reactions[0].personaId).toBe('p2');
  });

  it('throws REACTION_GENERATION_FAILED when all personas fail', async () => {
    mockAgentGenerate.mockRejectedValue(new Error('API down'));

    await expect(generateReactions(mockPersonas, mockAnalysisData, mockAudience))
      .rejects
      .toMatchObject({
        code: 'REACTION_GENERATION_FAILED',
        status: 502,
      });
  });

  it('handles empty personas array', async () => {
    await expect(generateReactions([], mockAnalysisData, mockAudience))
      .rejects
      .toMatchObject({
        code: 'REACTION_GENERATION_FAILED',
        status: 502,
      });
  });
});

// ── Summary Aggregation Tests ──

describe('generateReactionSummary', () => {
  const reactions = [
    { ...mockReaction, personaId: 'p1', actionLikelihood: 'would_click' as const },
    { ...mockReaction, personaId: 'p2', actionLikelihood: 'might_click' as const },
    { ...mockReaction, personaId: 'p3', actionLikelihood: 'would_scroll_past' as const },
  ];

  it('computes correct sentiment split', async () => {
    mockGenerateObject.mockResolvedValue({
      object: {
        commonThemes: ['test'],
        keyQuotes: [{ personaName: 'Alex', quote: 'Nice ad' }],
        actionabilityScore: 5,
        overallVerdict: 'Mixed',
      },
    });

    const summary = await generateReactionSummary(reactions, mockPersonas);
    expect(summary.sentimentSplit).toEqual({
      wouldClick: 1,
      mightClick: 1,
      wouldScrollPast: 1,
    });
  });

  it('calls generateObject with correct schema', async () => {
    mockGenerateObject.mockResolvedValue({
      object: {
        commonThemes: ['engagement'],
        keyQuotes: [{ personaName: 'Alex', quote: 'Nice' }],
        actionabilityScore: 7,
        overallVerdict: 'Good ad',
      },
    });

    await generateReactionSummary(reactions, mockPersonas);

    const call = mockGenerateObject.mock.calls[0][0];
    expect(call.model).toBe('mock-model');
    expect(call.schema).toBeDefined();
    expect(call.prompt).toContain('persona reactions');
  });
});

// ── Extract Analysis Data Tests ──

describe('extractAnalysisData', () => {
  it('extracts data from analysis results', () => {
    const results = {
      scoring: {
        overallScore: 7,
        verdict: 'Good',
        subScores: { attention: 8, branding: 6 },
        elements: [
          { type: 'Product', found: true, attentionPercent: 45 },
          { type: 'Logo', found: false },
        ],
      },
      heatmap: { summary: '45% product' },
      classification: {
        sentiment: { primary: 'positive' },
        category: { levels: [{ label: 'Health' }, { label: 'Fitness' }] },
      },
    };

    const data = extractAnalysisData(results, 'meta');
    expect(data.overallScore).toBe(7);
    expect(data.verdict).toBe('Good');
    expect(data.elements).toHaveLength(1); // only found elements
    expect(data.elements[0].label).toBe('Product');
    expect(data.sentiment).toBe('positive');
    expect(data.category).toBe('Health > Fitness');
    expect(data.platform).toBe('meta');
  });

  it('handles missing data gracefully', () => {
    const data = extractAnalysisData({}, 'instagram');
    expect(data.overallScore).toBe(0);
    expect(data.verdict).toBe('unknown');
    expect(data.elements).toHaveLength(0);
    expect(data.sentiment).toBe('unknown');
    expect(data.attentionSummary).toBe('No heatmap summary available');
  });
});
