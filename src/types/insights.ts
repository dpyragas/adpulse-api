export interface Recommendation {
  text: string;
  impact: 'high' | 'medium' | 'low';
  element: string;
}

export interface InsightsResult {
  unavailable: false;
  summary: string;
  working: string[];
  issues: string[];
  recommendations: Recommendation[];
  platformTips: string[];
}

export interface InsightsUnavailable {
  unavailable: true;
  message: string;
}

export type Insights = InsightsResult | InsightsUnavailable;
