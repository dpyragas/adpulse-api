import { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { getSignedImageUrl } from './s3.service.js';
import { PLATFORM_DB_MAP } from '../lib/constants.js';

interface ListAnalysesFilters {
  page: number;
  pageSize: number;
  platform?: 'meta' | 'tiktok' | 'linkedin' | 'general';
  scoreMin?: number;
  scoreMax?: number;
  search?: string;
  sortBy: 'createdAt' | 'updatedAt' | 'score';
  order: 'asc' | 'desc';
  workspace?: boolean;
  status?: 'COMPLETED' | 'FAILED';
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

// Safety cap for in-memory post-query filtering to prevent OOM
const POST_QUERY_MAX_ROWS = 5000;

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

  // Status filter — default: exclude PENDING/PROCESSING
  if (status) {
    where.status = status as Prisma.EnumAnalysisStatusFilter;
  } else {
    where.status = { in: ['COMPLETED', 'FAILED'] };
  }

  // Platform filter
  if (platform) {
    where.platform = PLATFORM_DB_MAP[platform] as unknown as Prisma.EnumPlatformFilter;
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
      take: POST_QUERY_MAX_ROWS,
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

    // Text search: case-insensitive match on insights text fields only (AC3)
    if (search) {
      const term = search.toLowerCase();
      filtered = filtered.filter((a) => {
        const results = a.results as Record<string, unknown> | null;
        if (!results) return false;
        const insights = results.insights as Record<string, unknown> | null;
        if (!insights) return false;
        const fields = [
          ...(Array.isArray(insights.working) ? insights.working : []),
          ...(Array.isArray(insights.issues) ? insights.issues : []),
          ...(Array.isArray(insights.recommendations) ? insights.recommendations : []),
        ];
        return fields.some((f) => String(f).toLowerCase().includes(term));
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
