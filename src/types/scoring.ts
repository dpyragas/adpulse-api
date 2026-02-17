export type Verdict = 'Strong' | 'Good' | 'Needs Work';

export type Platform = 'GENERAL' | 'META' | 'TIKTOK' | 'LINKEDIN';

export interface PlatformWeights {
  attention: number;
  branding: number;
  message: number;
  aesthetic: number;
}

export interface SubScores {
  attention: number;
  branding: number;
  message: number;
  aesthetic: number;
}

export interface ElementScore {
  type: string;
  found: boolean;
  attentionPercent: number;
  bbox?: [number, number, number, number];
  confidence?: number;
}

export interface ScoringIssue {
  severity: 'critical' | 'warning';
  element: string;
  message: string;
  attentionPercent?: number;
}

export interface ScoringResult {
  overallScore: number;
  verdict: Verdict;
  subScores: SubScores;
  elements: ElementScore[];
  issues: ScoringIssue[];
  platformModifiers: PlatformWeights;
}
