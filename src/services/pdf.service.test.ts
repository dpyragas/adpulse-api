import { describe, it, expect } from 'vitest';
import { generateAnalysisReport, type AnalysisForReport } from './pdf.service.js';

// 1x1 PNG buffer
const PNG_BUFFER = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64'
);

function makeAnalysis(overrides: Partial<AnalysisForReport> = {}): AnalysisForReport {
  return {
    id: 'test-analysis-id',
    platform: 'META',
    createdAt: new Date('2026-01-15'),
    scoring: {
      overallScore: 7.5,
      verdict: 'Good',
      subScores: { attention: 8.0, branding: 7.0, message: 7.5, aesthetic: 7.0 },
      elements: [
        { type: 'branding', found: true, attentionPercent: 25.0 },
        { type: 'headline', found: true, attentionPercent: 35.0 },
      ],
      issues: [
        { severity: 'warning', element: 'cta', message: 'CTA not found' },
      ],
    },
    insights: {
      unavailable: false,
      working: ['Strong branding'],
      issues: ['Missing CTA'],
      recommendations: ['Add CTA button'],
      platformNotes: 'Meta requires strong CTA.',
    },
    classification: {
      sentiment: { primary: 'joy', secondary: 'trust' },
      category: { levels: [{ level: 1, label: 'Technology', confidence: 0.9 }] },
    },
    overlayBuffer: PNG_BUFFER,
    ...overrides,
  };
}

describe('generateAnalysisReport', () => {
  it('returns Buffer with valid PDF header', async () => {
    const buffer = await generateAnalysisReport(makeAnalysis());

    expect(Buffer.isBuffer(buffer)).toBe(true);
    expect(buffer.length).toBeGreaterThan(0);
    const header = buffer.subarray(0, 5).toString('ascii');
    expect(header).toBe('%PDF-');
  });

  it('handles missing insights (unavailable: true) gracefully', async () => {
    const buffer = await generateAnalysisReport(makeAnalysis({
      insights: { unavailable: true, message: 'LLM unavailable' },
    }));

    expect(Buffer.isBuffer(buffer)).toBe(true);
    const header = buffer.subarray(0, 5).toString('ascii');
    expect(header).toBe('%PDF-');
  });

  it('handles null classification (sentiment/category) gracefully', async () => {
    const buffer = await generateAnalysisReport(makeAnalysis({
      classification: null,
    }));

    expect(Buffer.isBuffer(buffer)).toBe(true);
    const header = buffer.subarray(0, 5).toString('ascii');
    expect(header).toBe('%PDF-');
  });

  it('handles null insights gracefully', async () => {
    const buffer = await generateAnalysisReport(makeAnalysis({
      insights: null,
    }));

    expect(Buffer.isBuffer(buffer)).toBe(true);
    const header = buffer.subarray(0, 5).toString('ascii');
    expect(header).toBe('%PDF-');
  });

  it('handles classification with null sentiment and null category', async () => {
    const buffer = await generateAnalysisReport(makeAnalysis({
      classification: { sentiment: null, category: null },
    }));

    expect(Buffer.isBuffer(buffer)).toBe(true);
    const header = buffer.subarray(0, 5).toString('ascii');
    expect(header).toBe('%PDF-');
  });

  it('handles empty elements and empty issues arrays', async () => {
    const buffer = await generateAnalysisReport(makeAnalysis({
      scoring: {
        overallScore: 5.0,
        verdict: 'Needs Work',
        subScores: { attention: 5.0, branding: 5.0, message: 5.0, aesthetic: 5.0 },
        elements: [],
        issues: [],
      },
    }));

    expect(Buffer.isBuffer(buffer)).toBe(true);
    const header = buffer.subarray(0, 5).toString('ascii');
    expect(header).toBe('%PDF-');
  });
});
