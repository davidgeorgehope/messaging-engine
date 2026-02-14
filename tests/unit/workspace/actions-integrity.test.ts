import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

const ROOT = join(import.meta.dirname, '..', '..', '..');

/**
 * Source-level integrity tests.
 * These scan actual source files to ensure the vendor-speak inversion hack
 * (faking authenticity as `10 - vendorSpeakScore`) is not present.
 */
describe('source-level integrity', () => {
  const filesToScan = [
    'src/services/workspace/actions.ts',
    'src/api/generate.ts',
    'src/services/workspace/sessions.ts',
    'src/services/workspace/versions.ts',
    'src/api/workspace/chat.ts',
  ];

  describe('vendor-speak inversion hack must not exist', () => {
    for (const filePath of filesToScan) {
      const fullPath = join(ROOT, filePath);

      it(`${filePath} does not contain Math.max(0, 10 - pattern`, () => {
        if (!existsSync(fullPath)) {
          // File may not exist yet; that's fine -- no hack possible
          return;
        }
        const source = readFileSync(fullPath, 'utf-8');
        expect(source).not.toMatch(/Math\.max\(0,\s*10\s*-/);
      });

      it(`${filePath} does not contain 10 - vendor inversion in scoring`, () => {
        if (!existsSync(fullPath)) {
          return;
        }
        const source = readFileSync(fullPath, 'utf-8');

        // Check each line for the vendor inversion pattern, but skip
        // comments and lines that are in the totalQualityScore formula
        // (which legitimately uses 10 - slop and 10 - vendor for the total).
        const lines = source.split('\n');
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i];
          const trimmed = line.trim();

          // Skip comment lines
          if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) {
            continue;
          }

          // The patterns we're looking for are scoring authenticity as
          // an inversion of vendor-speak. This is distinct from the
          // totalQualityScore formula which uses (10 - scores.slopScore)
          // and (10 - scores.vendorSpeakScore) for aggregation.
          //
          // The hack looks like:
          //   authenticity: Math.max(0, 10 - asset.vendorSpeakScore)
          //   authenticityScore: 10 - vendorSpeakScore
          if (/authenticity.*10\s*-\s*.*vendor/i.test(trimmed)) {
            expect.fail(
              `${filePath}:${i + 1} contains vendor-speak inversion hack for authenticity: "${trimmed}"`
            );
          }
        }
      });
    }
  });

  describe('shared scorer module exists', () => {
    const sharedScorerPath = join(ROOT, 'src/services/quality/score-content.ts');

    it('src/services/quality/score-content.ts exists', () => {
      expect(existsSync(sharedScorerPath)).toBe(true);
    });

    it('exports scoreContent function', () => {
      const source = readFileSync(sharedScorerPath, 'utf-8');
      expect(source).toMatch(/export\s+(async\s+)?function\s+scoreContent/);
    });

    it('exports checkQualityGates function', () => {
      const source = readFileSync(sharedScorerPath, 'utf-8');
      expect(source).toMatch(/export\s+function\s+checkQualityGates/);
    });

    it('exports totalQualityScore function', () => {
      const source = readFileSync(sharedScorerPath, 'utf-8');
      expect(source).toMatch(/export\s+function\s+totalQualityScore/);
    });

    it('exports DEFAULT_THRESHOLDS', () => {
      const source = readFileSync(sharedScorerPath, 'utf-8');
      expect(source).toMatch(/export\s+const\s+DEFAULT_THRESHOLDS/);
    });

    it('imports analyzeAuthenticity (not faked)', () => {
      const source = readFileSync(sharedScorerPath, 'utf-8');
      expect(source).toMatch(/import\s+.*analyzeAuthenticity.*from/);
    });
  });
});
