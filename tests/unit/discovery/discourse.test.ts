import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

const ROOT = join(import.meta.dirname, '..', '..', '..');

describe('discourse discovery source', () => {
  const discoursePath = join(ROOT, 'src/services/discovery/sources/discourse.ts');
  const typesPath = join(ROOT, 'src/services/discovery/types.ts');
  const indexPath = join(ROOT, 'src/services/discovery/index.ts');

  it('discourse source file exists', () => {
    expect(existsSync(discoursePath)).toBe(true);
  });

  it('exports discoverFromDiscourse function', () => {
    const source = readFileSync(discoursePath, 'utf-8');
    expect(source).toMatch(/export\s+async\s+function\s+discoverFromDiscourse/);
  });

  it('exports stripDiscourseHtml function', () => {
    const source = readFileSync(discoursePath, 'utf-8');
    expect(source).toMatch(/export\s+function\s+stripDiscourseHtml/);
  });

  it('exports inferDiscourseForums function', () => {
    const source = readFileSync(discoursePath, 'utf-8');
    expect(source).toMatch(/export\s+function\s+inferDiscourseForums/);
  });

  it('types.ts includes discourse in SourceType', () => {
    const source = readFileSync(typesPath, 'utf-8');
    expect(source).toContain("'discourse'");
  });

  it('types.ts includes discourseForums in SourceConfig', () => {
    const source = readFileSync(typesPath, 'utf-8');
    expect(source).toContain('discourseForums');
  });

  it('index.ts registers discourse source', () => {
    const source = readFileSync(indexPath, 'utf-8');
    expect(source).toContain('discourse: discoverFromDiscourse');
  });

  it('uses default forums (Elastic + Grafana)', () => {
    const source = readFileSync(discoursePath, 'utf-8');
    expect(source).toContain('discuss.elastic.co');
    expect(source).toContain('community.grafana.com');
  });

  it('strips HTML tags and entities', () => {
    const source = readFileSync(discoursePath, 'utf-8');
    expect(source).toContain('search-highlight');
    expect(source).toContain('&amp;');
  });

  it('has rate limiting between requests', () => {
    const source = readFileSync(discoursePath, 'utf-8');
    expect(source).toMatch(/setTimeout.*5000/);
  });

  it('deduplicates by sourceId', () => {
    const source = readFileSync(discoursePath, 'utf-8');
    expect(source).toContain('sourceId');
    expect(source).toMatch(/seen\.has|Set.*sourceId/);
  });
});

describe('keyword inference helpers', () => {
  const actionsPath = join(ROOT, 'src/services/workspace/actions.ts');

  it('inferSubreddits is defined in actions', () => {
    const source = readFileSync(actionsPath, 'utf-8');
    expect(source).toMatch(/function\s+inferSubreddits/);
  });

  it('inferStackOverflowTags is defined in actions', () => {
    const source = readFileSync(actionsPath, 'utf-8');
    expect(source).toMatch(/function\s+inferStackOverflowTags/);
  });

  it('inferGitHubRepos is defined in actions', () => {
    const source = readFileSync(actionsPath, 'utf-8');
    expect(source).toMatch(/function\s+inferGitHubRepos/);
  });

  it('inferDiscourseForums is defined in actions', () => {
    const source = readFileSync(actionsPath, 'utf-8');
    expect(source).toMatch(/function\s+inferDiscourseForums/);
  });
});
