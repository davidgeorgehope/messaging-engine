import { describe, it, expect } from 'vitest';

// We only need the pattern-based exports (no AI calls), so mock the AI clients
import { vi } from 'vitest';

vi.mock('../../../src/services/ai/clients.js', () => ({
  generateJSON: vi.fn(),
  generateWithClaude: vi.fn(),
}));

vi.mock('../../../src/utils/logger.js', () => ({
  createLogger: () => ({
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

import { SLOP_PATTERNS, calculateBaseScore, type SlopMatch } from '../../../src/services/quality/slop-detector.js';

describe('SLOP_PATTERNS', () => {
  const expectedCategories = ['hedging', 'transitions', 'fillers', 'overused', 'enthusiasm', 'cliches'];

  it('should export SLOP_PATTERNS as a Record<string, string[]>', () => {
    expect(SLOP_PATTERNS).toBeDefined();
    expect(typeof SLOP_PATTERNS).toBe('object');
  });

  it('should contain all expected categories', () => {
    for (const category of expectedCategories) {
      expect(SLOP_PATTERNS).toHaveProperty(category);
      expect(Array.isArray(SLOP_PATTERNS[category])).toBe(true);
    }
  });

  it('should have non-empty arrays for each category', () => {
    for (const category of expectedCategories) {
      expect(SLOP_PATTERNS[category].length).toBeGreaterThan(0);
    }
  });

  it('should contain known hedging patterns', () => {
    expect(SLOP_PATTERNS.hedging).toContain("it's worth noting");
    expect(SLOP_PATTERNS.hedging).toContain('arguably');
  });

  it('should contain known transition patterns', () => {
    expect(SLOP_PATTERNS.transitions).toContain("let's dive in");
    expect(SLOP_PATTERNS.transitions).toContain('without further ado');
  });

  it('should contain known filler patterns', () => {
    expect(SLOP_PATTERNS.fillers).toContain("in today's world");
    expect(SLOP_PATTERNS.fillers).toContain('when it comes to');
  });

  it('should contain known overused patterns', () => {
    expect(SLOP_PATTERNS.overused).toContain('game-changer');
    expect(SLOP_PATTERNS.overused).toContain('paradigm shift');
    expect(SLOP_PATTERNS.overused).toContain('deep dive');
  });

  it('should contain known enthusiasm patterns', () => {
    expect(SLOP_PATTERNS.enthusiasm).toContain('exciting');
    expect(SLOP_PATTERNS.enthusiasm).toContain('mind-blowing');
  });

  it('should contain known cliche patterns', () => {
    expect(SLOP_PATTERNS.cliches).toContain('imagine a world');
    expect(SLOP_PATTERNS.cliches).toContain('the secret sauce');
  });

  it('should have all entries as lowercase strings', () => {
    for (const [category, patterns] of Object.entries(SLOP_PATTERNS)) {
      for (const pattern of patterns) {
        expect(typeof pattern).toBe('string');
        expect(pattern).toBe(pattern.toLowerCase());
      }
    }
  });
});

describe('calculateBaseScore', () => {
  it('should return 0 when there are no matches', () => {
    expect(calculateBaseScore([], 1000)).toBe(0);
  });

  it('should return a score proportional to match density', () => {
    const matches: SlopMatch[] = [
      { pattern: 'game-changer', category: 'overused', index: 0, context: '' },
      { pattern: 'exciting', category: 'enthusiasm', index: 50, context: '' },
    ];
    const score = calculateBaseScore(matches, 1000);
    expect(score).toBeGreaterThan(0);
    expect(score).toBeLessThanOrEqual(10);
  });

  it('should weight categories differently', () => {
    // 'overused' has weight 1.2, 'transitions' has weight 0.6
    const overusedMatch: SlopMatch[] = [
      { pattern: 'game-changer', category: 'overused', index: 0, context: '' },
    ];
    const transitionMatch: SlopMatch[] = [
      { pattern: "let's dive in", category: 'transitions', index: 0, context: '' },
    ];

    const overusedScore = calculateBaseScore(overusedMatch, 1000);
    const transitionScore = calculateBaseScore(transitionMatch, 1000);

    // Overused should produce a higher score due to higher weight
    expect(overusedScore).toBeGreaterThan(transitionScore);
  });

  it('should cap the score at 10', () => {
    // Create many matches in short content to exceed the cap
    const matches: SlopMatch[] = Array.from({ length: 50 }, (_, i) => ({
      pattern: 'game-changer',
      category: 'overused',
      index: i * 20,
      context: '',
    }));
    const score = calculateBaseScore(matches, 200);
    expect(score).toBe(10);
  });

  it('should normalize by content length', () => {
    const matches: SlopMatch[] = [
      { pattern: 'exciting', category: 'enthusiasm', index: 0, context: '' },
    ];

    const shortScore = calculateBaseScore(matches, 200);
    const longScore = calculateBaseScore(matches, 5000);

    // Same match in shorter content should score higher (denser slop)
    expect(shortScore).toBeGreaterThan(longScore);
  });

  it('should handle very short content with minimum length floor', () => {
    const matches: SlopMatch[] = [
      { pattern: 'exciting', category: 'enthusiasm', index: 0, context: '' },
    ];
    // Content length < 100 should use 100 as floor
    const score = calculateBaseScore(matches, 10);
    const floorScore = calculateBaseScore(matches, 100);
    expect(score).toBe(floorScore);
  });
});
