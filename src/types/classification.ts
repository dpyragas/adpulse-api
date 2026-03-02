export interface CategoryLevel {
  level: number;
  label: string;
  confidence: number;
}

export interface CategoryResult {
  levels: CategoryLevel[];
}

export interface SentimentResult {
  primary: string;
  secondary: string;
  scores: Record<string, number>;
}

export interface ClassificationResult {
  sentiment: SentimentResult | null;
  category: CategoryResult | null;
}
