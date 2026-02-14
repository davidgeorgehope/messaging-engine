import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync, readdirSync, statSync } from 'fs';
import { join } from 'path';

const ROOT = join(import.meta.dirname, '..', '..', '..');
const SRC_DIR = join(ROOT, 'src');

function getAllTsFiles(dir: string): string[] {
  const files: string[] = [];
  if (!existsSync(dir)) return files;
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

describe('no-cron architectural constraint', () => {
  const allTsFiles = getAllTsFiles(SRC_DIR);

  it('no file imports node-cron', () => {
    for (const fullPath of allTsFiles) {
      const source = readFileSync(fullPath, 'utf-8');
      const relativePath = fullPath.replace(ROOT + '/', '');
      if (/import.*from\s+['"]node-cron['"]/.test(source) || /require\s*\(\s*['"]node-cron['"]\s*\)/.test(source)) {
        expect.fail(`${relativePath} imports node-cron`);
      }
    }
  });

  it('no file references cron.schedule', () => {
    for (const fullPath of allTsFiles) {
      const source = readFileSync(fullPath, 'utf-8');
      const relativePath = fullPath.replace(ROOT + '/', '');
      if (/cron\.schedule\s*\(/.test(source)) {
        expect.fail(`${relativePath} calls cron.schedule()`);
      }
    }
  });

  it('src/jobs/scheduler.ts does not exist', () => {
    expect(existsSync(join(ROOT, 'src/jobs/scheduler.ts'))).toBe(false);
  });

  it('src/jobs/discover.ts does not exist', () => {
    expect(existsSync(join(ROOT, 'src/jobs/discover.ts'))).toBe(false);
  });

  it('src/jobs/generate.ts does not exist', () => {
    expect(existsSync(join(ROOT, 'src/jobs/generate.ts'))).toBe(false);
  });

  it('no file references startScheduler or stopScheduler', () => {
    for (const fullPath of allTsFiles) {
      const source = readFileSync(fullPath, 'utf-8');
      const relativePath = fullPath.replace(ROOT + '/', '');
      if (/\bstartScheduler\b/.test(source) || /\bstopScheduler\b/.test(source)) {
        expect.fail(`${relativePath} references startScheduler or stopScheduler`);
      }
    }
  });

  it('no file uses setInterval for recurring jobs', () => {
    for (const fullPath of allTsFiles) {
      const source = readFileSync(fullPath, 'utf-8');
      const relativePath = fullPath.replace(ROOT + '/', '');
      // Allow pollInteractionUntilComplete (legitimate Gemini Deep Research polling)
      if (/\bsetInterval\s*\(/.test(source) && !/pollInteractionUntilComplete/.test(source)) {
        expect.fail(`${relativePath} uses setInterval for recurring jobs`);
      }
    }
  });

  it('package.json does not list node-cron as a dependency', () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf-8'));
    expect(pkg.dependencies?.['node-cron']).toBeUndefined();
    expect(pkg.devDependencies?.['node-cron']).toBeUndefined();
    expect(pkg.devDependencies?.['@types/node-cron']).toBeUndefined();
  });
});
