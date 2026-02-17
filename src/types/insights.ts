export interface InsightsResult {
  unavailable: false;
  working: string[];
  issues: string[];
  recommendations: string[];
  platformNotes: string;
}

export interface InsightsUnavailable {
  unavailable: true;
  message: string;
}

export type Insights = InsightsResult | InsightsUnavailable;
