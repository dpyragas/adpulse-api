import { nanoid } from 'nanoid';
import { prisma } from '../lib/prisma.js';
import { AppError } from '../lib/app-error.js';
import { getSignedImageUrl } from './s3.service.js';

const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:3000';

export async function generateShareToken(
  analysisId: string,
  userId: string
): Promise<{ shareUrl: string }> {
  const analysis = await prisma.analysis.findFirst({
    where: { id: analysisId, userId },
    select: { id: true, status: true, shareToken: true },
  });

  if (!analysis) {
    throw new AppError('ANALYSIS_NOT_FOUND', 404, 'Analysis not found');
  }

  if (analysis.status !== 'COMPLETED') {
    throw new AppError('ANALYSIS_NOT_COMPLETE', 400, 'Analysis must be completed before sharing');
  }

  // Idempotent: return existing token if present
  if (analysis.shareToken) {
    return { shareUrl: `${FRONTEND_URL}/share/${analysis.shareToken}` };
  }

  const shareToken = nanoid(12);

  await prisma.analysis.update({
    where: { id: analysisId },
    data: { shareToken },
  });

  return { shareUrl: `${FRONTEND_URL}/share/${shareToken}` };
}

export async function revokeShareToken(
  analysisId: string,
  userId: string
): Promise<void> {
  const analysis = await prisma.analysis.findFirst({
    where: { id: analysisId, userId },
    select: { id: true },
  });

  if (!analysis) {
    throw new AppError('ANALYSIS_NOT_FOUND', 404, 'Analysis not found');
  }

  await prisma.analysis.update({
    where: { id: analysisId },
    data: { shareToken: null },
  });
}

export async function signResultUrls(results: Record<string, unknown>): Promise<Record<string, unknown>> {
  const signed = structuredClone(results);
  const heatmaps = typeof signed.heatmaps === 'object' && signed.heatmaps
    ? (signed.heatmaps as Record<string, string>)
    : null;

  if (heatmaps) {
    const [signedHeatmap, signedOverlay] = await Promise.all([
      heatmaps.heatmap ? getSignedImageUrl(heatmaps.heatmap) : null,
      heatmaps.overlay ? getSignedImageUrl(heatmaps.overlay) : null,
    ]);
    if (signedHeatmap) heatmaps.heatmap = signedHeatmap;
    if (signedOverlay) heatmaps.overlay = signedOverlay;
    delete heatmaps.grayscale;
  }

  return signed;
}

export async function getSharedAnalysis(shareToken: string) {
  const analysis = await prisma.analysis.findUnique({
    where: { shareToken },
    select: {
      id: true,
      platform: true,
      imageUrl: true,
      results: true,
      createdAt: true,
      status: true,
    },
  });

  if (!analysis || analysis.status !== 'COMPLETED') {
    throw new AppError('SHARE_NOT_FOUND', 404, 'Shared analysis not found');
  }

  const imageUrl = await getSignedImageUrl(analysis.imageUrl);

  let results: Record<string, unknown> | null = null;
  if (analysis.results && typeof analysis.results === 'object') {
    results = await signResultUrls(analysis.results as Record<string, unknown>);
  }

  return {
    analysis: {
      id: analysis.id,
      platform: analysis.platform,
      imageUrl,
      results,
      createdAt: analysis.createdAt,
    },
    branding: {
      ctaText: 'Try AdPulse Free',
      ctaUrl: '/signup',
    },
  };
}
