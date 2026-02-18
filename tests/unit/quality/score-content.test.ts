import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock all 5 scorer modules before importing the module under test
vi.mock('../../../src/services/quality/slop-detector.js', () => ({
  analyzeSlop: vi.fn().mockResolvedValue({ score: 3, patterns: [] }),
}));
vi.mock('../../../src/services/quality/vendor-speak.js', () => ({
  analyzeVendorSpeak: vi.fn().mockResolvedValue({ score: 4 }),
}));
vi.mock('../../../src/services/quality/specificity.js', () => ({
  analyzeSpecificity: vi.fn().mockResolvedValue({ score: 7 }),
}));
vi.mock('../../../src/services/quality/authenticity.js', () => ({
  analyzeAuthenticity: vi.fn().mockResolvedValue({ score: 8 }),
}));
vi.mock('../../../src/services/quality/narrative-arc.js', () => ({
  analyzeNarrativeArc: vi.fn().mockResolvedValue({ score: 6 }),
}));
vi.mock('../../../src/services/quality/persona-critic.js', () => ({
  runPersonaCritics: vi.fn().mockResolvedValue([{ score: 7 }, { score: 9 }]),
}));
vi.mock('../../../src/utils/logger.js', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import { scoreContent, checkQualityGates, totalQualityScore, DEFAULT_THRESHOLDS } from '../../../src/services/quality/score-content.js';
import { analyzeSlop } from '../../../src/services/quality/slop-detector.js';
import { analyzeVendorSpeak } from '../../../src/services/quality/vendor-speak.js';
import { analyzeSpecificity } from '../../../src/services/quality/specificity.js';
import { analyzeAuthenticity } from '../../../src/services/quality/authenticity.js';
import { analyzeNarrativeArc } from '../../../src/services/quality/narrative-arc.js';
import { runPersonaCritics } from '../../../src/services/quality/persona-critic.js';

describe('score-content', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset to default mock values
    vi.mocked(analyzeSlop).mockResolvedValue({ score: 3, patterns: [] } as any);
    vi.mocked(analyzeVendorSpeak).mockResolvedValue({ score: 4 } as any);
    vi.mocked(analyzeSpecificity).mockResolvedValue({ score: 7 } as any);
    vi.mocked(analyzeAuthenticity).mockResolvedValue({ score: 8 } as any);
    vi.mocked(analyzeNarrativeArc).mockResolvedValue({ score: 6 } as any);
    vi.mocked(runPersonaCritics).mockResolvedValue([{ score: 7 }, { score: 9 }] as any);
  });

  describe('DEFAULT_THRESHOLDS', () => {
    it('has the expected values', () => {
      expect(DEFAULT_THRESHOLDS).toEqual({
        slopMax: 5,
        vendorSpeakMax: 5,
        authenticityMin: 6,
        specificityMin: 6,
        personaMin: 6,
        narrativeArcMin: 5,
      });
    });
  });

  describe('scoreContent', () => {
    it('calls all 6 scorers', async () => {
      await scoreContent('test content');

      expect(analyzeSlop).toHaveBeenCalledWith('test content');
      expect(analyzeVendorSpeak).toHaveBeenCalledWith('test content');
      expect(analyzeSpecificity).toHaveBeenCalledWith('test content', []);
      expect(analyzeAuthenticity).toHaveBeenCalledWith('test content');
      expect(analyzeNarrativeArc).toHaveBeenCalledWith('test content');
      expect(runPersonaCritics).toHaveBeenCalledWith('test content', undefined);
    });

    it('calls analyzeAuthenticity (not faked from vendor-speak)', async () => {
      // Set vendor-speak to 3 so a fake inversion would produce authenticity = 7
      vi.mocked(analyzeVendorSpeak).mockResolvedValue({ score: 3 } as any);
      // Set real authenticity to 2 (something clearly different from 10-3=7)
      vi.mocked(analyzeAuthenticity).mockResolvedValue({ score: 2 } as any);

      const result = await scoreContent('test content');

      expect(analyzeAuthenticity).toHaveBeenCalledTimes(1);
      // The real authenticity score (2) must be used, NOT 10 - vendorSpeak (7)
      expect(result.authenticityScore).toBe(2);
      expect(result.authenticityScore).not.toBe(10 - result.vendorSpeakScore);
    });

    it('authenticity is NOT 10 - vendorSpeakScore (regression test)', async () => {
      // Use values where 10 - vendor = 7 but real authenticity = 4
      vi.mocked(analyzeVendorSpeak).mockResolvedValue({ score: 3 } as any);
      vi.mocked(analyzeAuthenticity).mockResolvedValue({ score: 4 } as any);

      const result = await scoreContent('some content');

      expect(result.vendorSpeakScore).toBe(3);
      expect(result.authenticityScore).toBe(4);
      // If authenticity were faked, it would be Math.max(0, 10 - 3) = 7
      expect(result.authenticityScore).not.toBe(7);
    });

    it('returns correct score structure', async () => {
      const result = await scoreContent('test content');

      expect(result).toHaveProperty('slopScore');
      expect(result).toHaveProperty('vendorSpeakScore');
      expect(result).toHaveProperty('authenticityScore');
      expect(result).toHaveProperty('specificityScore');
      expect(result).toHaveProperty('personaAvgScore');
      expect(result).toHaveProperty('slopAnalysis');
    });

    it('returns scores from each scorer', async () => {
      const result = await scoreContent('test content');

      expect(result.slopScore).toBe(3);
      expect(result.vendorSpeakScore).toBe(4);
      expect(result.authenticityScore).toBe(8);
      expect(result.specificityScore).toBe(7);
      expect(result.personaAvgScore).toBe(8); // (7 + 9) / 2 = 8
    });

    it('passes productDocs to analyzeSpecificity', async () => {
      await scoreContent('content', ['doc1', 'doc2']);
      expect(analyzeSpecificity).toHaveBeenCalledWith('content', ['doc1', 'doc2']);
    });

    it('computes persona average correctly', async () => {
      vi.mocked(runPersonaCritics).mockResolvedValue([
        { score: 6 },
        { score: 8 },
        { score: 4 },
      ] as any);

      const result = await scoreContent('content');
      expect(result.personaAvgScore).toBe(6); // (6 + 8 + 4) / 3 = 6.0
    });

    it('defaults persona average to 5 when no critics return', async () => {
      vi.mocked(runPersonaCritics).mockResolvedValue([] as any);

      const result = await scoreContent('content');
      expect(result.personaAvgScore).toBe(5);
    });

    // .catch() fallback tests
    it('defaults slop score to 5 when analyzeSlop throws', async () => {
      vi.mocked(analyzeSlop).mockRejectedValue(new Error('API error'));

      const result = await scoreContent('content');
      expect(result.slopScore).toBe(5);
    });

    it('defaults vendor-speak score to 5 when analyzeVendorSpeak throws', async () => {
      vi.mocked(analyzeVendorSpeak).mockRejectedValue(new Error('API error'));

      const result = await scoreContent('content');
      expect(result.vendorSpeakScore).toBe(5);
    });

    it('defaults specificity score to 5 when analyzeSpecificity throws', async () => {
      vi.mocked(analyzeSpecificity).mockRejectedValue(new Error('API error'));

      const result = await scoreContent('content');
      expect(result.specificityScore).toBe(5);
    });

    it('defaults authenticity score to 5 when analyzeAuthenticity throws', async () => {
      vi.mocked(analyzeAuthenticity).mockRejectedValue(new Error('API error'));

      const result = await scoreContent('content');
      expect(result.authenticityScore).toBe(5);
    });

    it('defaults persona average to 5 when runPersonaCritics throws', async () => {
      vi.mocked(runPersonaCritics).mockRejectedValue(new Error('API error'));

      const result = await scoreContent('content');
      expect(result.personaAvgScore).toBe(5);
    });

    it('forwards personaContext to runPersonaCritics when provided', async () => {
      const personaContext = {
        domain: 'security',
        category: 'SIEM',
        targetPersonas: ['Security Analyst'],
        painPointsAddressed: ['Alert fatigue'],
        productName: 'TestProduct',
      };
      await scoreContent('test content', [], personaContext);
      expect(runPersonaCritics).toHaveBeenCalledWith('test content', personaContext);
    });
  });

  describe('checkQualityGates', () => {
    const passingScores = {
      slopScore: 3,
      vendorSpeakScore: 4,
      authenticityScore: 8,
      specificityScore: 7,
      personaAvgScore: 7,
      narrativeArcScore: 7,
      slopAnalysis: {},
    };

    it('returns true when all dimensions pass', () => {
      const result = checkQualityGates(passingScores, DEFAULT_THRESHOLDS);
      expect(result).toBe(true);
    });

    it('returns false when slop exceeds max', () => {
      const result = checkQualityGates(
        { ...passingScores, slopScore: 6 },
        DEFAULT_THRESHOLDS,
      );
      expect(result).toBe(false);
    });

    it('returns false when vendor-speak exceeds max', () => {
      const result = checkQualityGates(
        { ...passingScores, vendorSpeakScore: 6 },
        DEFAULT_THRESHOLDS,
      );
      expect(result).toBe(false);
    });

    it('returns false when authenticity is below min', () => {
      const result = checkQualityGates(
        { ...passingScores, authenticityScore: 5 },
        DEFAULT_THRESHOLDS,
      );
      expect(result).toBe(false);
    });

    it('returns false when specificity is below min', () => {
      const result = checkQualityGates(
        { ...passingScores, specificityScore: 5 },
        DEFAULT_THRESHOLDS,
      );
      expect(result).toBe(false);
    });

    it('returns false when persona average is below min', () => {
      const result = checkQualityGates(
        { ...passingScores, personaAvgScore: 5 },
        DEFAULT_THRESHOLDS,
      );
      expect(result).toBe(false);
    });

    it('returns true at exact threshold boundaries', () => {
      const boundaryScores = {
        slopScore: 5,         // exactly at slopMax
        vendorSpeakScore: 5,  // exactly at vendorSpeakMax
        authenticityScore: 6, // exactly at authenticityMin
        specificityScore: 6,  // exactly at specificityMin
        personaAvgScore: 6,   // exactly at personaMin
        narrativeArcScore: 5, // exactly at narrativeArcMin
        slopAnalysis: {},
      };
      expect(checkQualityGates(boundaryScores, DEFAULT_THRESHOLDS)).toBe(true);
    });

    it('uses custom thresholds when provided', () => {
      const strictThresholds = {
        slopMax: 2,
        vendorSpeakMax: 2,
        authenticityMin: 9,
        specificityMin: 9,
        personaMin: 9,
        narrativeArcMin: 9,
      };
      expect(checkQualityGates(passingScores, strictThresholds)).toBe(false);
    });

    it('falls back to DEFAULT_THRESHOLDS for missing threshold keys', () => {
      // Partial thresholds -- missing keys should fall back to defaults
      const result = checkQualityGates(passingScores, {});
      expect(result).toBe(true);
    });
  });

  describe('totalQualityScore', () => {
    it('calculates correctly: (10-slop) + (10-vendor) + auth + spec + persona + arc', () => {
      const scores = {
        slopScore: 3,
        vendorSpeakScore: 4,
        authenticityScore: 8,
        specificityScore: 7,
        personaAvgScore: 7,
        narrativeArcScore: 6,
        slopAnalysis: {},
      };
      // (10-3) + (10-4) + 8 + 7 + 7 + 6 = 7 + 6 + 8 + 7 + 7 + 6 = 41
      expect(totalQualityScore(scores)).toBe(41);
    });

    it('returns higher score for better content', () => {
      const good = {
        slopScore: 1,
        vendorSpeakScore: 1,
        authenticityScore: 9,
        specificityScore: 9,
        personaAvgScore: 9,
        narrativeArcScore: 9,
        slopAnalysis: {},
      };
      const bad = {
        slopScore: 8,
        vendorSpeakScore: 8,
        authenticityScore: 2,
        specificityScore: 2,
        personaAvgScore: 2,
        narrativeArcScore: 2,
        slopAnalysis: {},
      };
      expect(totalQualityScore(good)).toBeGreaterThan(totalQualityScore(bad));
    });

    it('returns 60 for perfect scores', () => {
      const perfect = {
        slopScore: 0,
        vendorSpeakScore: 0,
        authenticityScore: 10,
        specificityScore: 10,
        personaAvgScore: 10,
        narrativeArcScore: 10,
        slopAnalysis: {},
      };
      // (10-0) + (10-0) + 10 + 10 + 10 + 10 = 60
      expect(totalQualityScore(perfect)).toBe(60);
    });

    it('returns 0 for worst scores', () => {
      const worst = {
        slopScore: 10,
        vendorSpeakScore: 10,
        authenticityScore: 0,
        specificityScore: 0,
        personaAvgScore: 0,
        narrativeArcScore: 0,
        slopAnalysis: {},
      };
      // (10-10) + (10-10) + 0 + 0 + 0 + 0 = 0
      expect(totalQualityScore(worst)).toBe(0);
    });
  });
});
