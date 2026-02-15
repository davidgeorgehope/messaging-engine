// Single source of truth for content scoring
// Replaces duplicated scoreContent() in actions.ts and generate.ts
// Calls all 5 real scorers — never fakes authenticity as vendor-speak inversion

import { analyzeSlop, type SlopAnalysis } from './slop-detector.js';
import { analyzeVendorSpeak } from './vendor-speak.js';
import { analyzeSpecificity } from './specificity.js';
import { analyzeAuthenticity } from './authenticity.js';
import { runPersonaCritics } from './persona-critic.js';
import { createLogger } from '../../utils/logger.js';

const logger = createLogger('quality:score-content');

export interface ScorerHealth {
  succeeded: number;
  failed: string[];
  total: number;
}

export interface ScoreResults {
  slopScore: number;
  vendorSpeakScore: number;
  authenticityScore: number;
  specificityScore: number;
  personaAvgScore: number;
  slopAnalysis: SlopAnalysis;
  scorerHealth: ScorerHealth;
}

export const DEFAULT_THRESHOLDS = {
  slopMax: 5,
  vendorSpeakMax: 5,
  authenticityMin: 6,
  specificityMin: 6,
  personaMin: 6,
};

export async function scoreContent(content: string, productDocs: string[] = []): Promise<ScoreResults> {
  const failed: string[] = [];

  const [slopAnalysis, vendorAnalysis, specificityAnalysis, authenticityAnalysis, personaResults] = await Promise.all([
    analyzeSlop(content).catch((err) => { logger.warn('Slop analysis failed, using fallback', { error: String(err) }); failed.push('slop'); return { score: 5, matches: [], matchCount: 0, categoryCounts: {} }; }),
    analyzeVendorSpeak(content).catch((err) => { logger.warn('Vendor-speak analysis failed, using fallback', { error: String(err) }); failed.push('vendorSpeak'); return { score: 5 }; }),
    analyzeSpecificity(content, productDocs).catch((err) => { logger.warn('Specificity analysis failed, using fallback', { error: String(err) }); failed.push('specificity'); return { score: 5 }; }),
    analyzeAuthenticity(content).catch((err) => { logger.warn('Authenticity analysis failed, using fallback', { error: String(err) }); failed.push('authenticity'); return { score: 5 }; }),
    runPersonaCritics(content).catch((err) => { logger.warn('Persona critics failed, using fallback', { error: String(err) }); failed.push('persona'); return []; }),
  ]);

  const personaAvg = personaResults.length > 0
    ? personaResults.reduce((sum: number, r: { score: number }) => sum + r.score, 0) / personaResults.length
    : 5;

  const scorerHealth: ScorerHealth = {
    succeeded: 5 - failed.length,
    failed,
    total: 5,
  };

  if (failed.length > 0) {
    logger.warn('Scorer health degraded', { scorerHealth });
  }

  return {
    slopScore: slopAnalysis.score,
    vendorSpeakScore: vendorAnalysis.score,
    authenticityScore: authenticityAnalysis.score,
    specificityScore: specificityAnalysis.score,
    personaAvgScore: Math.round(personaAvg * 10) / 10,
    slopAnalysis,
    scorerHealth,
  };
}

import type { ScoringThresholds } from '../../types/index.js';

export function checkQualityGates(scores: ScoreResults, thresholds: ScoringThresholds): boolean {
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
