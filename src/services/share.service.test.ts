import { describe, it, expect, beforeEach, vi } from 'vitest';

const mockFindFirst = vi.fn();
const mockFindUnique = vi.fn();
const mockUpdate = vi.fn();

vi.mock('../lib/prisma.js', () => ({
  prisma: {
    analysis: {
      findFirst: (...args: unknown[]) => mockFindFirst(...args),
      findUnique: (...args: unknown[]) => mockFindUnique(...args),
      update: (...args: unknown[]) => mockUpdate(...args),
    },
  },
}));

vi.mock('./s3.service.js', () => ({
  getSignedImageUrl: vi.fn().mockResolvedValue('https://signed-url.example.com/image'),
}));

vi.mock('nanoid', () => ({
  nanoid: vi.fn().mockReturnValue('abc123def456'),
}));

const { generateShareToken, revokeShareToken, getSharedAnalysis } = await import('./share.service.js');

beforeEach(() => {
  vi.clearAllMocks();
});

describe('generateShareToken', () => {
  it('generates token for completed analysis', async () => {
    mockFindFirst.mockResolvedValue({ id: 'a1', status: 'COMPLETED', shareToken: null });
    mockUpdate.mockResolvedValue({});

    const result = await generateShareToken('a1', 'u1');

    expect(result.shareUrl).toContain('/share/abc123def456');
    expect(mockUpdate).toHaveBeenCalledWith({
      where: { id: 'a1' },
      data: { shareToken: 'abc123def456' },
    });
  });

  it('returns existing token on repeat call (idempotent)', async () => {
    mockFindFirst.mockResolvedValue({ id: 'a1', status: 'COMPLETED', shareToken: 'existing12tk' });

    const result = await generateShareToken('a1', 'u1');

    expect(result.shareUrl).toContain('/share/existing12tk');
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it('throws ANALYSIS_NOT_FOUND for non-existent analysis', async () => {
    mockFindFirst.mockResolvedValue(null);

    await expect(generateShareToken('a1', 'u1')).rejects.toMatchObject({
      code: 'ANALYSIS_NOT_FOUND',
      status: 404,
    });
  });

  it('throws ANALYSIS_NOT_COMPLETE for non-completed analysis', async () => {
    mockFindFirst.mockResolvedValue({ id: 'a1', status: 'PROCESSING', shareToken: null });

    await expect(generateShareToken('a1', 'u1')).rejects.toMatchObject({
      code: 'ANALYSIS_NOT_COMPLETE',
      status: 400,
    });
  });
});

describe('revokeShareToken', () => {
  it('nullifies shareToken', async () => {
    mockFindFirst.mockResolvedValue({ id: 'a1' });
    mockUpdate.mockResolvedValue({});

    await revokeShareToken('a1', 'u1');

    expect(mockUpdate).toHaveBeenCalledWith({
      where: { id: 'a1' },
      data: { shareToken: null },
    });
  });

  it('throws ANALYSIS_NOT_FOUND for non-owner', async () => {
    mockFindFirst.mockResolvedValue(null);

    await expect(revokeShareToken('a1', 'u1')).rejects.toMatchObject({
      code: 'ANALYSIS_NOT_FOUND',
      status: 404,
    });
  });
});

describe('getSharedAnalysis', () => {
  it('returns full analysis data with branding', async () => {
    mockFindUnique.mockResolvedValue({
      id: 'a1',
      platform: 'META',
      imageUrl: 's3://bucket/key.png',
      results: { scoring: { overallScore: 8 }, heatmaps: { heatmap: 's3://bucket/hm.png' } },
      createdAt: new Date('2026-01-01'),
      status: 'COMPLETED',
    });

    const result = await getSharedAnalysis('abc123def456');

    expect(result.analysis.id).toBe('a1');
    expect(result.analysis.platform).toBe('META');
    expect(result.analysis.imageUrl).toBe('https://signed-url.example.com/image');
    expect(result.branding.ctaText).toBe('Try AdPulse Free');
    expect(result.branding.ctaUrl).toBe('/signup');
  });

  it('throws SHARE_NOT_FOUND for invalid token', async () => {
    mockFindUnique.mockResolvedValue(null);

    await expect(getSharedAnalysis('invalid12345')).rejects.toMatchObject({
      code: 'SHARE_NOT_FOUND',
      status: 404,
    });
  });

  it('throws SHARE_NOT_FOUND for non-completed analysis', async () => {
    mockFindUnique.mockResolvedValue({
      id: 'a1',
      status: 'PROCESSING',
    });

    await expect(getSharedAnalysis('abc123def456')).rejects.toMatchObject({
      code: 'SHARE_NOT_FOUND',
      status: 404,
    });
  });
});
