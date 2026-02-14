// Single source of truth for content scoring
// Replaces duplicated scoreContent() in actions.ts and generate.ts
// Calls all 5 real scorers — never fakes authenticity as vendor-speak inversion

import { analyzeSlop } from './slop-detector.js';
import { analyzeVendorSpeak } from './vendor-speak.js';
import { analyzeSpecificity } from './specificity.js';
import { analyzeAuthenticity } from './authenticity.js';
import { runPersonaCritics } from './persona-critic.js';
import { createLogger } from '../../utils/logger.js';

const logger = createLogger('quality:score-content');

export interface ScoreResults {
  slopScore: number;
  vendorSpeakScore: number;
  authenticityScore: number;
  specificityScore: number;
  personaAvgScore: number;
  slopAnalysis: any;
}

export const DEFAULT_THRESHOLDS = {
  slopMax: 5,
  vendorSpeakMax: 5,
  authenticityMin: 6,
  specificityMin: 6,
  personaMin: 6,
};

export async function scoreContent(content: string, productDocs: string[] = []): Promise<ScoreResults> {
  const [slopAnalysis, vendorAnalysis, specificityAnalysis, authenticityAnalysis, personaResults] = await Promise.all([
    analyzeSlop(content).catch((err) => { logger.warn('Slop analysis failed, using fallback', { error: String(err) }); return { score: 5 }; }),
    analyzeVendorSpeak(content).catch((err) => { logger.warn('Vendor-speak analysis failed, using fallback', { error: String(err) }); return { score: 5 }; }),
    analyzeSpecificity(content, productDocs).catch((err) => { logger.warn('Specificity analysis failed, using fallback', { error: String(err) }); return { score: 5 }; }),
    analyzeAuthenticity(content).catch((err) => { logger.warn('Authenticity analysis failed, using fallback', { error: String(err) }); return { score: 5 }; }),
    runPersonaCritics(content).catch((err) => { logger.warn('Persona critics failed, using fallback', { error: String(err) }); return []; }),
  ]);

  const personaAvg = personaResults.length > 0
    ? personaResults.reduce((sum: number, r: any) => sum + r.score, 0) / personaResults.length
    : 5;

  return {
    slopScore: (slopAnalysis as any).score,
    vendorSpeakScore: (vendorAnalysis as any).score,
    authenticityScore: (authenticityAnalysis as any).score,
    specificityScore: (specificityAnalysis as any).score,
    personaAvgScore: Math.round(personaAvg * 10) / 10,
    slopAnalysis,
  };
}

export function checkQualityGates(scores: ScoreResults, thresholds: any): boolean {
  return (
    scores.slopScore <= (thresholds.slopMax ?? DEFAULT_THRESHOLDS.slopMax) &&
    scores.vendorSpeakScore <= (thresholds.vendorSpeakMax ?? DEFAULT_THRESHOLDS.vendorSpeakMax) &&
    scores.authenticityScore >= (thresholds.authenticityMin ?? DEFAULT_THRESHOLDS.authenticityMin) &&
    scores.specificityScore >= (thresholds.specificityMin ?? DEFAULT_THRESHOLDS.specificityMin) &&
    scores.personaAvgScore >= (thresholds.personaMin ?? DEFAULT_THRESHOLDS.personaMin)
  );
}

export function totalQualityScore(scores: ScoreResults): number {
  // Higher is better: invert slop and vendor (where lower is better)
  return (10 - scores.slopScore) + (10 - scores.vendorSpeakScore) +
    scores.authenticityScore + scores.specificityScore + scores.personaAvgScore;
}
