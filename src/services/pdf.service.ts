import PDFDocument from 'pdfkit';
import { PassThrough } from 'stream';
import { logger } from '../lib/logger.js';

// Local types used instead of generated/api.d.ts because:
// - Generated Insights discriminator uses string literals ("InsightsResult"/"InsightsUnavailable")
//   while runtime data uses boolean (true/false) for `unavailable`
// - AnalysisForReport adds `overlayBuffer: Buffer` not in any API schema
interface SubScores {
  attention: number;
  branding: number;
  message: number;
  aesthetic: number;
}

interface ElementScore {
  type: string;
  found: boolean;
  attentionPercent: number;
}

interface ScoringIssue {
  severity: 'critical' | 'warning';
  element: string;
  message: string;
  attentionPercent?: number;
}

interface ScoringResult {
  overallScore: number;
  verdict: string;
  subScores: SubScores;
  elements: ElementScore[];
  issues: ScoringIssue[];
}

interface Recommendation {
  text: string;
  impact: 'high' | 'medium' | 'low';
  element: string;
}

interface InsightsAvailable {
  unavailable: false;
  working: string[];
  issues: string[];
  recommendations: Recommendation[];
  platformTips: string[];
}

interface InsightsUnavailable {
  unavailable: true;
  message: string;
}

type Insights = InsightsAvailable | InsightsUnavailable;

interface SentimentResult {
  primary: string;
  secondary: string;
}

interface CategoryLevel {
  level: number;
  label: string;
  confidence: number;
}

interface ClassificationResult {
  sentiment: SentimentResult | null;
  category: { levels: CategoryLevel[] } | null;
}

export interface AnalysisForReport {
  id: string;
  platform: string;
  createdAt: Date;
  scoring: ScoringResult;
  insights: Insights | null;
  classification: ClassificationResult | null;
  overlayBuffer: Buffer;
}

const SCORE_COLORS = {
  excellent: '#22C55E',
  good: '#EAB308',
  poor: '#EF4444',
} as const;

function scoreColor(score: number): string {
  if (score >= 8) return SCORE_COLORS.excellent;
  if (score >= 5) return SCORE_COLORS.good;
  return SCORE_COLORS.poor;
}

function formatDate(date: Date): string {
  return date.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
}

const PLATFORM_LABELS: Record<string, string> = {
  META: 'Meta',
  TIKTOK: 'TikTok',
  LINKEDIN: 'LinkedIn',
  GENERAL: 'General',
};

function formatPlatform(platform: string): string {
  return PLATFORM_LABELS[platform] ?? platform;
}

const ELEMENT_LABELS: Record<string, string> = {
  body_text: 'Body Text',
  cta: 'CTA',
};

function formatElementType(type: string): string {
  if (ELEMENT_LABELS[type]) return ELEMENT_LABELS[type];
  return type.charAt(0).toUpperCase() + type.slice(1);
}

function formatImpact(impact: string): string {
  return impact.charAt(0).toUpperCase() + impact.slice(1);
}

function stampFooters(doc: PDFKit.PDFDocument, footerText: string): void {
  const range = doc.bufferedPageRange();
  for (let i = 0; i < range.count; i++) {
    doc.switchToPage(range.start + i);
    doc.fontSize(8).font('Helvetica').fillColor('#A1A1AA')
      .text(footerText, 50, doc.page.height - 30, {
        align: 'center',
        width: doc.page.width - 100,
        lineBreak: false,
      });
  }
}

function pdfToBuffer(doc: PDFKit.PDFDocument, footerText: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const stream = new PassThrough();
    doc.pipe(stream);
    stream.on('data', (chunk) => chunks.push(chunk));
    stream.on('end', () => resolve(Buffer.concat(chunks)));
    stream.on('error', reject);
    stampFooters(doc, footerText);
    doc.end();
  });
}

export async function generateAnalysisReport(analysis: AnalysisForReport): Promise<Buffer> {
  const doc = new PDFDocument({ layout: 'portrait', size: 'A4', margin: 50 });
  const { scoring, insights, classification } = analysis;
  const dateStr = formatDate(analysis.createdAt);
  // --- Header ---
  doc.fontSize(22).font('Helvetica-Bold').fillColor('#18181B')
    .text('AdPulse Analysis Report', { align: 'center' });
  doc.moveDown(0.3);
  doc.fontSize(10).font('Helvetica').fillColor('#71717A')
    .text(`Generated: ${dateStr}  |  Platform: ${formatPlatform(analysis.platform)}`, { align: 'center' });
  doc.moveDown(1);

  // --- Heatmap image ---
  try {
    doc.image(analysis.overlayBuffer, {
      fit: [495, 350],
      align: 'center',
    });
  } catch (error) {
    logger.warn('Failed to embed image in PDF report', { analysisId: analysis.id, error: String(error) });
    doc.fontSize(10).fillColor('#71717A').text('[Image could not be embedded]', { align: 'center' });
  }
  doc.moveDown(1);

  // --- Overall Score + Verdict ---
  doc.fontSize(36).font('Helvetica-Bold').fillColor(scoreColor(scoring.overallScore))
    .text(scoring.overallScore.toFixed(1), { align: 'center' });
  doc.fontSize(14).font('Helvetica').fillColor('#18181B')
    .text(scoring.verdict, { align: 'center' });
  doc.moveDown(1);

  // --- Sub-scores table ---
  doc.fontSize(14).font('Helvetica-Bold').fillColor('#18181B')
    .text('Sub-Scores');
  doc.moveDown(0.3);

  doc.table({
    columnStyles: ['*', 80],
    defaultStyle: { border: [0, 0, 1, 0], borderColor: '#E4E4E7', padding: 6 },
    rowStyles: (i: number) => {
      if (i === 0) return { backgroundColor: '#F4F4F5', font: { family: 'Helvetica-Bold', size: 10 }, padding: 8 };
      return { font: { size: 10 } };
    },
    data: [
      ['Category', 'Score'],
      ['Attention', scoring.subScores.attention.toFixed(1)],
      ['Branding', scoring.subScores.branding.toFixed(1)],
      ['Message', scoring.subScores.message.toFixed(1)],
      ['Aesthetic', scoring.subScores.aesthetic.toFixed(1)],
    ],
  });
  doc.moveDown(1);

  // --- Elements table ---
  if (scoring.elements.length > 0) {
    doc.fontSize(14).font('Helvetica-Bold').fillColor('#18181B')
      .text('Detected Elements');
    doc.moveDown(0.3);

    doc.table({
      columnStyles: ['*', 80, 100],
      defaultStyle: { border: [0, 0, 1, 0], borderColor: '#E4E4E7', padding: 6 },
      rowStyles: (i: number) => {
        if (i === 0) return { backgroundColor: '#F4F4F5', font: { family: 'Helvetica-Bold', size: 10 }, padding: 8 };
        return { font: { size: 10 } };
      },
      data: [
        ['Element', 'Found', 'Attention %'],
        ...scoring.elements.map((el) => [
          formatElementType(el.type),
          el.found ? 'Yes' : 'No',
          `${el.attentionPercent.toFixed(1)}%`,
        ]),
      ],
    });
    doc.moveDown(1);
  }

  // --- Issues section ---
  if (scoring.issues.length > 0) {
    doc.fontSize(14).font('Helvetica-Bold').fillColor('#18181B')
      .text('Issues');
    doc.moveDown(0.3);

    for (const issue of scoring.issues) {
      const isCritical = issue.severity === 'critical';
      const severityColor = isCritical ? '#EF4444' : '#EAB308';
      const severityLabel = isCritical ? 'CRITICAL' : 'WARNING';
      doc.fontSize(10).font('Helvetica-Bold').fillColor(severityColor)
        .text(`[${severityLabel}] `, { continued: true })
        .fillColor('#18181B').text(formatElementType(issue.element), { continued: true })
        .font('Helvetica').text(` - ${issue.message}`);
    }
    doc.moveDown(1);
  }

  // --- Insights section ---
  if (insights && !insights.unavailable) {
    const ins = insights as InsightsAvailable;

    doc.fontSize(14).font('Helvetica-Bold').fillColor('#18181B')
      .text('AI Insights');
    doc.moveDown(0.3);

    if (ins.working.length > 0) {
      doc.fontSize(11).font('Helvetica-Bold').fillColor('#22C55E')
        .text("What's Working");
      doc.fontSize(10).font('Helvetica').fillColor('#18181B');
      for (const item of ins.working) {
        doc.text(`  • ${item}`);
      }
      doc.moveDown(0.5);
    }

    if (ins.issues.length > 0) {
      doc.fontSize(11).font('Helvetica-Bold').fillColor('#EF4444')
        .text('Issues');
      doc.fontSize(10).font('Helvetica').fillColor('#18181B');
      for (const item of ins.issues) {
        doc.text(`  • ${item}`);
      }
      doc.moveDown(0.5);
    }

    if (ins.recommendations.length > 0) {
      doc.fontSize(11).font('Helvetica-Bold').fillColor('#3B82F6')
        .text('Recommendations');
      doc.fontSize(10).font('Helvetica').fillColor('#18181B');
      for (const rec of ins.recommendations) {
        doc.font('Helvetica').text(`  [${formatImpact(rec.impact)}] `, { continued: true })
          .font('Helvetica-Bold').text(rec.text);
      }
      doc.moveDown(0.5);
    }

    if (ins.platformTips && ins.platformTips.length > 0) {
      doc.fontSize(11).font('Helvetica-Bold').fillColor('#71717A')
        .text('Platform Tips');
      doc.fontSize(10).font('Helvetica').fillColor('#18181B');
      for (const tip of ins.platformTips) {
        doc.text(`  - ${tip}`);
      }
      doc.moveDown(0.5);
    }

    doc.moveDown(0.5);
  }

  // --- Classification section ---
  if (classification) {
    const { sentiment, category } = classification;

    if (sentiment || category) {
      doc.fontSize(14).font('Helvetica-Bold').fillColor('#18181B')
        .text('Classification');
      doc.moveDown(0.3);

      if (sentiment) {
        doc.fontSize(10).font('Helvetica').fillColor('#18181B')
          .text(`Sentiment: ${sentiment.primary} (secondary: ${sentiment.secondary})`);
      }

      if (category && category.levels.length > 0) {
        const categoryStr = category.levels.map((l) => l.label).join(' > ');
        doc.fontSize(10).font('Helvetica').fillColor('#18181B')
          .text(`Category: ${categoryStr}`);
      }

      doc.moveDown(1);
    }
  }

  const footerText = `Generated by AdPulse | ${dateStr}`;
  return pdfToBuffer(doc, footerText);
}

