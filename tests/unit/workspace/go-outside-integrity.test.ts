import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

const ROOT = join(import.meta.dirname, '..', '..', '..');

describe('go-outside actions integrity', () => {
  const actionsPath = join(ROOT, 'src/services/workspace/actions.ts');
  const routesPath = join(ROOT, 'src/api/workspace/sessions.ts');

  it('actions.ts exports runCompetitiveDeepDiveAction', () => {
    const source = readFileSync(actionsPath, 'utf-8');
    expect(source).toMatch(/export\s+async\s+function\s+runCompetitiveDeepDiveAction/);
  });

  it('actions.ts exports runCommunityCheckAction', () => {
    const source = readFileSync(actionsPath, 'utf-8');
    expect(source).toMatch(/export\s+async\s+function\s+runCommunityCheckAction/);
  });

  it('both actions call scoreContent', () => {
    const source = readFileSync(actionsPath, 'utf-8');
    // Find the competitive dive function and check it calls scoreContent
    const compSection = source.split('runCompetitiveDeepDiveAction')[1]?.split('export')[0] || '';
    expect(compSection).toContain('scoreContent');

    const commSection = source.split('runCommunityCheckAction')[1]?.split('export')[0] || source.split('runCommunityCheckAction')[1] || '';
    expect(commSection).toContain('scoreContent');
  });

  it('community check uses multiple discovery sources', () => {
    const source = readFileSync(actionsPath, 'utf-8');
    expect(source).toContain('discoverFromReddit');
    expect(source).toContain('discoverFromHackerNews');
    expect(source).toContain('discoverFromStackOverflow');
    expect(source).toContain('discoverFromGitHub');
    expect(source).toContain('discoverFromDiscourse');
  });

  it('competitive dive uses deep research with grounded search fallback', () => {
    const source = readFileSync(actionsPath, 'utf-8');
    expect(source).toContain('createDeepResearchInteraction');
    expect(source).toContain('pollInteractionUntilComplete');
    expect(source).toContain('generateWithGeminiGroundedSearch');
  });

  it('API routes exist for both actions', () => {
    const source = readFileSync(routesPath, 'utf-8');
    expect(source).toContain("actions/competitive-dive");
    expect(source).toContain("actions/community-check");
  });

  it('API routes import both action functions', () => {
    const source = readFileSync(routesPath, 'utf-8');
    expect(source).toContain('runCompetitiveDeepDiveAction');
    expect(source).toContain('runCommunityCheckAction');
  });
});
