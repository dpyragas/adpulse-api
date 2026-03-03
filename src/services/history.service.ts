import { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { getSignedImageUrl } from './s3.service.js';

interface ListAnalysesFilters {
  page: number;
  pageSize: number;
  platform?: string;
  scoreMin?: number;
  scoreMax?: number;
  search?: string;
  sortBy: string;
  order: string;
  workspace?: boolean;
  status?: string;
}

export interface AnalysisSummary {
  id: string;
  status: string;
  platform: string;
  overallScore: number | null;
  verdict: string | null;
  imageUrl: string;
  createdAt: Date;
}

const PLATFORM_MAP: Record<string, string> = {
  meta: 'META',
  tiktok: 'TIKTOK',
  linkedin: 'LINKEDIN',
  general: 'GENERAL',
};

export async function listAnalyses(
  userId: string,
  workspaceId: string | null,
  filters: ListAnalysesFilters
) {
  const { page, pageSize, platform, scoreMin, scoreMax, search, sortBy, order, status } = filters;

  // Build where clause
  const where: Prisma.AnalysisWhereInput = {};

  // Ownership: user's own or workspace
  if (filters.workspace && workspaceId) {
    where.workspaceId = workspaceId;
  } else {
    where.userId = userId;
  }

  // Status filter — default: only COMPLETED/FAILED (excludes PENDING, PROCESSING, DELETED)
  if (status) {
    where.status = status as Prisma.EnumAnalysisStatusFilter;
  } else {
    where.status = { in: ['COMPLETED', 'FAILED'] };
  }

  // Platform filter
  if (platform) {
    where.platform = PLATFORM_MAP[platform] as Prisma.EnumPlatformFilter;
  }

  const needsScoreFilter = scoreMin !== undefined || scoreMax !== undefined;
  const needsScoreSort = sortBy === 'score';
  const needsPostQuery = needsScoreFilter || needsScoreSort || !!search;

  // Sorting — only apply DB sort for non-score fields
  const orderBy: Prisma.AnalysisOrderByWithRelationInput = {};
  if (!needsScoreSort) {
    const sortField = sortBy === 'updatedAt' ? 'updatedAt' : 'createdAt';
    orderBy[sortField] = order as Prisma.SortOrder;
  } else {
    orderBy.createdAt = 'desc';
  }

  // Post-query path: fetch all matching, then filter/sort/paginate in-memory
  if (needsPostQuery) {
    const allAnalyses = await prisma.analysis.findMany({
      where,
      orderBy,
      select: {
        id: true,
        status: true,
        platform: true,
        imageUrl: true,
        results: true,
        createdAt: true,
      },
    });

    let filtered = allAnalyses.map((a) => {
      const results = a.results as Record<string, unknown> | null;
      const scoring = results?.scoring as Record<string, unknown> | null;
      const overallScore = (scoring?.overallScore as number) ?? null;
      const verdict = (scoring?.verdict as string) ?? null;
      return { ...a, overallScore, verdict };
    });

    // Text search: case-insensitive match on stringified results
    if (search) {
      const term = search.toLowerCase();
      filtered = filtered.filter((a) => {
        if (!a.results) return false;
        return JSON.stringify(a.results).toLowerCase().includes(term);
      });
    }

    if (scoreMin !== undefined) {
      filtered = filtered.filter((a) => a.overallScore !== null && a.overallScore >= scoreMin);
    }
    if (scoreMax !== undefined) {
      filtered = filtered.filter((a) => a.overallScore !== null && a.overallScore <= scoreMax);
    }

    if (needsScoreSort) {
      filtered.sort((a, b) => {
        const aScore = a.overallScore ?? 0;
        const bScore = b.overallScore ?? 0;
        return order === 'asc' ? aScore - bScore : bScore - aScore;
      });
    }

    const total = filtered.length;
    const skip = (page - 1) * pageSize;
    const paginated = filtered.slice(skip, skip + pageSize);

    const data: AnalysisSummary[] = await Promise.all(
      paginated.map(async (a) => ({
        id: a.id,
        status: a.status,
        platform: a.platform,
        overallScore: a.overallScore,
        verdict: a.verdict,
        imageUrl: await getSignedImageUrl(a.imageUrl),
        createdAt: a.createdAt,
      }))
    );

    return { data, pagination: { page, pageSize, total } };
  }

  // Standard DB-level pagination (no search/score filtering)
  const [analyses, total] = await Promise.all([
    prisma.analysis.findMany({
      where,
      orderBy,
      skip: (page - 1) * pageSize,
      take: pageSize,
      select: {
        id: true,
        status: true,
        platform: true,
        imageUrl: true,
        results: true,
        createdAt: true,
      },
    }),
    prisma.analysis.count({ where }),
  ]);

  const data: AnalysisSummary[] = await Promise.all(
    analyses.map(async (a) => {
      const results = a.results as Record<string, unknown> | null;
      const scoring = results?.scoring as Record<string, unknown> | null;
      return {
        id: a.id,
        status: a.status,
        platform: a.platform,
        overallScore: (scoring?.overallScore as number) ?? null,
        verdict: (scoring?.verdict as string) ?? null,
        imageUrl: await getSignedImageUrl(a.imageUrl),
        createdAt: a.createdAt,
      };
    })
  );

  return { data, pagination: { page, pageSize, total } };
}
