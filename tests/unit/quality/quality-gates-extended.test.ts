import { describe, it, expect, vi } from 'vitest';

// Mock all 5 scorer modules + logger (required by import chain)
vi.mock('../../../src/services/quality/slop-detector.js', () => ({
  analyzeSlop: vi.fn().mockResolvedValue({ score: 3 }),
}));
vi.mock('../../../src/services/quality/vendor-speak.js', () => ({
  analyzeVendorSpeak: vi.fn().mockResolvedValue({ score: 3 }),
}));
vi.mock('../../../src/services/quality/specificity.js', () => ({
  analyzeSpecificity: vi.fn().mockResolvedValue({ score: 7 }),
}));
vi.mock('../../../src/services/quality/authenticity.js', () => ({
  analyzeAuthenticity: vi.fn().mockResolvedValue({ score: 8 }),
}));
vi.mock('../../../src/services/quality/persona-critic.js', () => ({
  runPersonaCritics: vi.fn().mockResolvedValue([{ score: 8 }]),
}));
vi.mock('../../../src/utils/logger.js', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import { checkQualityGates, totalQualityScore, DEFAULT_THRESHOLDS, type ScoreResults } from '../../../src/services/quality/score-content.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function makeScores(overrides: Partial<ScoreResults> = {}): ScoreResults {
  return {
    slopScore: 2,
    vendorSpeakScore: 2,
    authenticityScore: 8,
    specificityScore: 8,
    personaAvgScore: 8,
    narrativeArcScore: 7,
    slopAnalysis: {},
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// checkQualityGates — each dimension independent
// ---------------------------------------------------------------------------
describe('checkQualityGates — dimension independence', () => {
  it('fails when only slop exceeds threshold', () => {
    const scores = makeScores({ slopScore: 6 });
    expect(checkQualityGates(scores, DEFAULT_THRESHOLDS)).toBe(false);
  });

  it('fails when only vendor-speak exceeds threshold', () => {
    const scores = makeScores({ vendorSpeakScore: 6 });
    expect(checkQualityGates(scores, DEFAULT_THRESHOLDS)).toBe(false);
  });

  it('fails when only authenticity is below threshold', () => {
    const scores = makeScores({ authenticityScore: 5 });
    expect(checkQualityGates(scores, DEFAULT_THRESHOLDS)).toBe(false);
  });

  it('fails when only specificity is below threshold', () => {
    const scores = makeScores({ specificityScore: 5 });
    expect(checkQualityGates(scores, DEFAULT_THRESHOLDS)).toBe(false);
  });

  it('fails when only persona-fit is below threshold', () => {
    const scores = makeScores({ personaAvgScore: 5 });
    expect(checkQualityGates(scores, DEFAULT_THRESHOLDS)).toBe(false);
  });

  it('fails when only narrative arc is below threshold', () => {
    const scores = makeScores({ narrativeArcScore: 4 });
    expect(checkQualityGates(scores, DEFAULT_THRESHOLDS)).toBe(false);
  });

  it('passes when every dimension is exactly at threshold', () => {
    const scores = makeScores({
      slopScore: 5,
      vendorSpeakScore: 5,
      authenticityScore: 6,
      specificityScore: 6,
      personaAvgScore: 6,
      narrativeArcScore: 5,
    });
    expect(checkQualityGates(scores, DEFAULT_THRESHOLDS)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// checkQualityGates — zero thresholds
// ---------------------------------------------------------------------------
describe('checkQualityGates — zero thresholds', () => {
  const zeroThresholds = {
    slopMax: 0,
    vendorSpeakMax: 0,
    authenticityMin: 0,
    specificityMin: 0,
    personaMin: 0,
    narrativeArcMin: 0,
  };

  it('passes when all scores are 0 and thresholds are 0', () => {
    const scores = makeScores({
      slopScore: 0,
      vendorSpeakScore: 0,
      authenticityScore: 0,
      specificityScore: 0,
      personaAvgScore: 0,
      narrativeArcScore: 0,
    });
    expect(checkQualityGates(scores, zeroThresholds)).toBe(true);
  });

  it('fails when slop is 1 against 0 threshold', () => {
    const scores = makeScores({
      slopScore: 1,
      vendorSpeakScore: 0,
      authenticityScore: 0,
      specificityScore: 0,
      personaAvgScore: 0,
      narrativeArcScore: 0,
    });
    expect(checkQualityGates(scores, zeroThresholds)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// totalQualityScore — fractional scores
// ---------------------------------------------------------------------------
describe('totalQualityScore — fractional scores', () => {
  it('handles decimal scores correctly', () => {
    const scores = makeScores({
      slopScore: 2.5,
      vendorSpeakScore: 3.3,
      authenticityScore: 7.7,
      specificityScore: 6.1,
      personaAvgScore: 8.2,
      narrativeArcScore: 6.5,
    });
    // (10-2.5) + (10-3.3) + 7.7 + 6.1 + 8.2 + 6.5 = 7.5 + 6.7 + 7.7 + 6.1 + 8.2 + 6.5 = 42.7
    const result = totalQualityScore(scores);
    expect(result).toBeCloseTo(42.7, 5);
  });

  it('returns 60 for perfect scores', () => {
    const scores = makeScores({
      slopScore: 0,
      vendorSpeakScore: 0,
      authenticityScore: 10,
      specificityScore: 10,
      personaAvgScore: 10,
      narrativeArcScore: 10,
    });
    expect(totalQualityScore(scores)).toBe(60);
  });

  it('returns 0 for worst scores', () => {
    const scores = makeScores({
      slopScore: 10,
      vendorSpeakScore: 10,
      authenticityScore: 0,
      specificityScore: 0,
      personaAvgScore: 0,
      narrativeArcScore: 0,
    });
    expect(totalQualityScore(scores)).toBe(0);
  });
});
