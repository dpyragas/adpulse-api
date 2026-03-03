import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { listAnalyses } from './history.service.js';

// Mock S3 signed URLs
vi.mock('./s3.service.js', () => ({
  getSignedImageUrl: vi.fn().mockImplementation((key: string) =>
    Promise.resolve(`https://signed.example.com/${key}`)
  ),
}));

const USER_A_ID = 'history-test-user-a';
const USER_B_ID = 'history-test-user-b';
const WORKSPACE_ID = 'history-test-workspace';

async function seedTestData() {
  // Create users
  for (const id of [USER_A_ID, USER_B_ID]) {
    await prisma.user.upsert({
      where: { id },
      update: {},
      create: {
        id,
        name: `Test ${id}`,
        email: `${id}@example.com`,
        emailVerified: true,
      },
    });
  }

  // Create analyses for User A
  const analyses = [
    { id: 'hist-1', userId: USER_A_ID, platform: 'META' as const, status: 'COMPLETED' as const, imageUrl: 's3://bucket/img1.png', results: { scoring: { overallScore: 8.5, verdict: 'Strong' }, insights: { working: ['Good contrast'], issues: ['No CTA'], recommendations: ['Add CTA'] } } },
    { id: 'hist-2', userId: USER_A_ID, platform: 'TIKTOK' as const, status: 'COMPLETED' as const, imageUrl: 's3://bucket/img2.png', results: { scoring: { overallScore: 4.2, verdict: 'Needs Work' }, insights: { working: ['Bright colors'], issues: ['Text too small'], recommendations: ['Enlarge text'] } } },
    { id: 'hist-3', userId: USER_A_ID, platform: 'META' as const, status: 'COMPLETED' as const, imageUrl: 's3://bucket/img3.png', results: { scoring: { overallScore: 6.0, verdict: 'Good' }, insights: { working: ['Summer vibes'], issues: [], recommendations: [] } } },
    { id: 'hist-4', userId: USER_A_ID, platform: 'LINKEDIN' as const, status: 'FAILED' as const, imageUrl: 's3://bucket/img4.png', results: Prisma.JsonNull },
    { id: 'hist-5', userId: USER_A_ID, platform: 'META' as const, status: 'PENDING' as const, imageUrl: 's3://bucket/img5.png', results: Prisma.JsonNull },
    { id: 'hist-6', userId: USER_A_ID, platform: 'GENERAL' as const, status: 'PROCESSING' as const, imageUrl: 's3://bucket/img6.png', results: Prisma.JsonNull },
    // Workspace analysis by user B
    { id: 'hist-7', userId: USER_B_ID, workspaceId: WORKSPACE_ID, platform: 'META' as const, status: 'COMPLETED' as const, imageUrl: 's3://bucket/img7.png', results: { scoring: { overallScore: 7.0, verdict: 'Good' } } },
    // User B's personal analysis
    { id: 'hist-8', userId: USER_B_ID, platform: 'TIKTOK' as const, status: 'COMPLETED' as const, imageUrl: 's3://bucket/img8.png', results: { scoring: { overallScore: 9.0, verdict: 'Strong' } } },
  ];

  for (const a of analyses) {
    await prisma.analysis.upsert({
      where: { id: a.id },
      update: {},
      create: a,
    });
  }
}

async function cleanupTestData() {
  await prisma.analysis.deleteMany({
    where: { id: { startsWith: 'hist-' } },
  });
  await prisma.user.deleteMany({
    where: { id: { in: [USER_A_ID, USER_B_ID] } },
  });
}

beforeAll(async () => {
  await cleanupTestData();
  await seedTestData();
});

afterAll(async () => {
  await cleanupTestData();
});

describe('listAnalyses', () => {
  const defaultFilters = { page: 1, pageSize: 10, sortBy: 'createdAt', order: 'desc' as const };

  it('returns default pagination (page 1, size 10) (AC #5)', async () => {
    const result = await listAnalyses(USER_A_ID, null, defaultFilters);

    expect(result.pagination.page).toBe(1);
    expect(result.pagination.pageSize).toBe(10);
    expect(result.pagination.total).toBeGreaterThan(0);
    expect(result.data.length).toBeLessThanOrEqual(10);
  });

  it('excludes PENDING/PROCESSING by default (AC #6)', async () => {
    const result = await listAnalyses(USER_A_ID, null, defaultFilters);

    const statuses = result.data.map((a) => a.status);
    expect(statuses).not.toContain('PENDING');
    expect(statuses).not.toContain('PROCESSING');
  });

  it('filters by platform (AC #2)', async () => {
    const result = await listAnalyses(USER_A_ID, null, {
      ...defaultFilters,
      platform: 'meta',
    });

    expect(result.data.length).toBeGreaterThan(0);
    result.data.forEach((a) => expect(a.platform).toBe('META'));
  });

  it('filters by score range (AC #2)', async () => {
    const result = await listAnalyses(USER_A_ID, null, {
      ...defaultFilters,
      scoreMin: 5,
      scoreMax: 10,
    });

    expect(result.data.length).toBeGreaterThan(0);
    result.data.forEach((a) => {
      expect(a.overallScore).not.toBeNull();
      expect(a.overallScore!).toBeGreaterThanOrEqual(5);
      expect(a.overallScore!).toBeLessThanOrEqual(10);
    });
  });

  it('searches text in results (AC #3)', async () => {
    const result = await listAnalyses(USER_A_ID, null, {
      ...defaultFilters,
      search: 'summer',
    });

    // hist-3 has "Summer vibes" in insights.working
    expect(result.data.length).toBeGreaterThan(0);
  });

  it('sorts by createdAt desc (default) (AC #2)', async () => {
    const result = await listAnalyses(USER_A_ID, null, defaultFilters);

    for (let i = 1; i < result.data.length; i++) {
      const prev = new Date(result.data[i - 1].createdAt).getTime();
      const curr = new Date(result.data[i].createdAt).getTime();
      expect(prev).toBeGreaterThanOrEqual(curr);
    }
  });

  it('sorts by createdAt asc (AC #2)', async () => {
    const result = await listAnalyses(USER_A_ID, null, {
      ...defaultFilters,
      order: 'asc',
    });

    for (let i = 1; i < result.data.length; i++) {
      const prev = new Date(result.data[i - 1].createdAt).getTime();
      const curr = new Date(result.data[i].createdAt).getTime();
      expect(prev).toBeLessThanOrEqual(curr);
    }
  });

  it('sorts by score (AC #2)', async () => {
    const result = await listAnalyses(USER_A_ID, null, {
      ...defaultFilters,
      sortBy: 'score',
      order: 'desc',
    });

    const scores = result.data.map((a) => a.overallScore ?? 0);
    for (let i = 1; i < scores.length; i++) {
      expect(scores[i - 1]).toBeGreaterThanOrEqual(scores[i]);
    }
  });

  it('returns workspace analyses when workspace=true (AC #4)', async () => {
    const result = await listAnalyses(USER_A_ID, WORKSPACE_ID, {
      ...defaultFilters,
      workspace: true,
    });

    // hist-7 is workspace analysis
    expect(result.data.some((a) => a.id === 'hist-7')).toBe(true);
  });

  it('isolates ownership — user A cannot see user B personal analyses (AC #1)', async () => {
    const result = await listAnalyses(USER_A_ID, null, defaultFilters);

    const ids = result.data.map((a) => a.id);
    // hist-8 belongs to user B (personal, not workspace)
    expect(ids).not.toContain('hist-8');
  });

  it('returns signed S3 URLs for imageUrl', async () => {
    const result = await listAnalyses(USER_A_ID, null, defaultFilters);

    result.data.forEach((a) => {
      expect(a.imageUrl).toContain('https://signed.example.com/');
    });
  });

  it('returns only summary fields — no full results blob', async () => {
    const result = await listAnalyses(USER_A_ID, null, defaultFilters);

    result.data.forEach((a) => {
      expect(a).toHaveProperty('id');
      expect(a).toHaveProperty('status');
      expect(a).toHaveProperty('platform');
      expect(a).toHaveProperty('imageUrl');
      expect(a).toHaveProperty('createdAt');
      expect(a).not.toHaveProperty('results');
    });
  });

  it('filters by status=COMPLETED (AC #6)', async () => {
    const result = await listAnalyses(USER_A_ID, null, {
      ...defaultFilters,
      status: 'COMPLETED',
    });

    result.data.forEach((a) => expect(a.status).toBe('COMPLETED'));
    // hist-4 is FAILED, should not appear
    expect(result.data.every((a) => a.id !== 'hist-4')).toBe(true);
  });

  it('excludes DELETED analyses from default listing', async () => {
    // Create a DELETED analysis
    await prisma.analysis.upsert({
      where: { id: 'hist-deleted' },
      update: {},
      create: {
        id: 'hist-deleted',
        userId: USER_A_ID,
        platform: 'META',
        status: 'DELETED',
        imageUrl: 's3://bucket/deleted.png',
        results: { scoring: { overallScore: 5.0, verdict: 'Good' } },
      },
    });

    const result = await listAnalyses(USER_A_ID, null, defaultFilters);

    const ids = result.data.map((a) => a.id);
    expect(ids).not.toContain('hist-deleted');
    const statuses = result.data.map((a) => a.status);
    expect(statuses).not.toContain('DELETED');

    // Cleanup
    await prisma.analysis.delete({ where: { id: 'hist-deleted' } });
  });
});
