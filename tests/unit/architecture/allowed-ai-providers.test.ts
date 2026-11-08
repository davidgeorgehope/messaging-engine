import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';

const ROOT = join(import.meta.dirname, '..', '..', '..');

const SCAN_ROOTS = ['src', 'tests', 'admin/src', 'docs', 'skills', 'templates'];
const SCAN_FILES = [
  'package.json',
  '.env.example',
  'README.md',
  'ARCHITECTURE.md',
  'PIPELINE.md',
  'DATABASE.md',
  'CLAUDE.md',
];

const FORBIDDEN = [
  ['ANTHROPIC', '_API_KEY'].join(''),
  ['GOOGLE_AI', '_API_KEY'].join(''),
  ['OPENAI', '_API_KEY'].join(''),
  ['@anthropic-ai', '/sdk'].join(''),
  ['@google', '/genai'].join(''),
  ['api.anthropic', '.com'].join(''),
  ['generativelanguage', '.googleapis.com'].join(''),
  ['api.openai', '.com'].join(''),
  ['claude', '-opus'].join(''),
  ['claude', '-sonnet'].join(''),
  ['gemini', '-'].join(''),
  ['google', 'Search'].join(''),
  ["from '", 'openai', "'"].join(''),
  ['from "', 'openai', '"'].join(''),
];

function walk(dir: string): string[] {
  const entries = readdirSync(dir);
  const files: string[] = [];
  for (const entry of entries) {
    if (entry === 'node_modules' || entry === 'dist' || entry === 'coverage') continue;
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) files.push(...walk(full));
    else if (/\.(ts|tsx|js|mjs|cjs|md|json|example)$/.test(entry)) files.push(full);
  }
  return files;
}

describe('allowed AI providers', () => {
  const files = [
    ...SCAN_ROOTS.flatMap((root) => walk(join(ROOT, root))),
    ...SCAN_FILES.map((file) => join(ROOT, file)),
  ];

  it('does not reference banned AI providers, SDKs, or keys', () => {
    const hits: string[] = [];
    for (const file of files) {
      const relative = file.replace(ROOT + '/', '');
      const source = readFileSync(file, 'utf-8');
      for (const token of FORBIDDEN) {
        if (source.includes(token)) hits.push(`${relative}: ${token}`);
      }
    }
    expect(hits, hits.join('\n')).toEqual([]);
  });

  it('keeps legacy research column renames inside the database migrator only', () => {
    const legacy = ['gemini', '_interaction_id'].join('');
    const hits = files.filter((file) => readFileSync(file, 'utf-8').includes(legacy))
      .map((file) => file.replace(ROOT + '/', ''));
    expect(hits).toEqual(['src/db/index.ts']);
  });
});
