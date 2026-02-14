import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync, readdirSync, statSync } from 'fs';
import { join } from 'path';

const ROOT = join(import.meta.dirname, '..', '..', '..');
const SRC_DIR = join(ROOT, 'src');

/**
 * Dynamically discover all .ts files under src/ for scanning.
 * This catches vendor-inversion hacks in new files, not just the original 5.
 */
function getAllTsFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir)) {
    const fullPath = join(dir, entry);
    const stat = statSync(fullPath);
    if (stat.isDirectory()) {
      files.push(...getAllTsFiles(fullPath));
    } else if (entry.endsWith('.ts') && !entry.endsWith('.d.ts')) {
      files.push(fullPath);
    }
  }
  return files;
}

/**
 * Source-level integrity tests.
 * These scan ALL .ts files under src/ to ensure the vendor-speak inversion hack
 * (faking authenticity as `10 - vendorSpeakScore`) is not present anywhere.
 */
describe('source-level integrity', () => {
  const allTsFiles = getAllTsFiles(SRC_DIR);
  // Exclude score-content.ts since its totalQualityScore legitimately uses 10 - vendor
  const filesToScan = allTsFiles.filter(f => !f.endsWith('score-content.ts'));

  describe('vendor-speak inversion hack must not exist in any source file', () => {
    for (const fullPath of filesToScan) {
      const relativePath = fullPath.replace(ROOT + '/', '');

      it(`${relativePath} does not contain Math.max(0, 10 - pattern`, () => {
        const source = readFileSync(fullPath, 'utf-8');
        expect(source).not.toMatch(/Math\.max\(0,\s*10\s*-/);
      });

      it(`${relativePath} does not fake authenticity as vendor inversion`, () => {
        const source = readFileSync(fullPath, 'utf-8');
        const lines = source.split('\n');
        for (let i = 0; i < lines.length; i++) {
          const trimmed = lines[i].trim();

          // Skip comments
          if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) {
            continue;
          }

          // The hack: authenticity = 10 - vendorSpeakScore
          if (/authenticity.*10\s*-\s*.*vendor/i.test(trimmed)) {
            expect.fail(
              `${relativePath}:${i + 1} contains vendor-speak inversion hack for authenticity: "${trimmed}"`
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

  describe('scan coverage', () => {
    it('scans more than just the original 5 files', () => {
      // Ensures the dynamic scan is actually finding files
      expect(filesToScan.length).toBeGreaterThan(5);
    });

    it('includes the known problem files', () => {
      const relativePaths = filesToScan.map(f => f.replace(ROOT + '/', ''));
      expect(relativePaths).toContain('src/services/workspace/actions.ts');
      expect(relativePaths).toContain('src/api/generate.ts');
      expect(relativePaths).toContain('src/services/workspace/sessions.ts');
      expect(relativePaths).toContain('src/services/workspace/versions.ts');
      expect(relativePaths).toContain('src/api/workspace/chat.ts');
    });
  });
});
