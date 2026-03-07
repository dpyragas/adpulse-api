export const MAX_VIDEO_DURATION = 60; // seconds

export const ANALYSIS_TIMEOUT_MS = 60_000;

export const RATING_DB_MAP = { up: 'UP', down: 'DOWN' } as const;

export const TIER_CREDITS = {
  trial: 3,
  solo: 40,
  team: 120,
  business: 400,
  agency: 1000,
} as const;
