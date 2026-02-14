import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  engagementScore,
} from '../../../src/services/workspace/actions.js';
import type { RawDiscoveredPainPoint } from '../../../src/services/discovery/types.js';

const ROOT = join(import.meta.dirname, '..', '..', '..');

function makePost(sourceType: string, metadata: Record<string, unknown>): RawDiscoveredPainPoint {
  return {
    sourceType: sourceType as any,
    sourceUrl: 'https://example.com',
    sourceId: `test-${sourceType}`,
    title: 'Test post',
    content: 'Test content',
    author: 'testuser',
    metadata,
    discoveredAt: new Date().toISOString(),
  };
}

describe('engagementScore', () => {
  it('scores Reddit posts using score + numComments * 2', () => {
    const post = makePost('reddit', { score: 100, numComments: 25 });
    expect(engagementScore(post)).toBe(150);
  });

  it('scores HackerNews posts using points', () => {
    const post = makePost('hackernews', { points: 200 });
    expect(engagementScore(post)).toBe(200);
  });

  it('scores GitHub posts using reactions * 3', () => {
    const post = makePost('github', { reactions: 50 });
    expect(engagementScore(post)).toBe(150);
  });

  it('scores Discourse posts with blended metric', () => {
    const post = makePost('discourse', { topicViews: 3000, topicLikes: 10, topicReplies: 5, postLikes: 3 });
    // 3000/20 + 10*2 + 5*2 + 3*3 = 150 + 20 + 10 + 9 = 189
    expect(engagementScore(post)).toBe(189);
  });

  it('scores StackOverflow posts using score + viewCount / 50', () => {
    const post = makePost('stackoverflow', { score: 10, viewCount: 5000 });
    // 10 + 5000/50 = 110
    expect(engagementScore(post)).toBe(110);
  });

  it('normalizes across sources (Reddit 150 upvotes ≈ Discourse 3000 views)', () => {
    const redditPost = makePost('reddit', { score: 150, numComments: 0 });
    const discoursePost = makePost('discourse', { topicViews: 3000, topicLikes: 0, topicReplies: 0, postLikes: 0 });
    // Reddit: 150, Discourse: 3000/20 = 150
    expect(engagementScore(redditPost)).toBe(engagementScore(discoursePost));
  });

  it('returns 0 for unknown source type', () => {
    const post = makePost('unknown', { score: 100 });
    expect(engagementScore(post)).toBe(0);
  });
});

describe('go-outside source presence', () => {
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

  it('actions.ts exports extractKeywordsAndSources (AI-powered)', () => {
    const source = readFileSync(actionsPath, 'utf-8');
    expect(source).toMatch(/export\s+async\s+function\s+extractKeywordsAndSources/);
  });

  it('actions.ts does NOT contain naive regex keyword splitting', () => {
    const source = readFileSync(actionsPath, 'utf-8');
    // The old naive approach split on regex and filtered stopwords
    expect(source).not.toMatch(/\.split\(\/\[\\s,\./);
  });

  it('actions.ts does NOT contain hardcoded inferSubreddits function', () => {
    const source = readFileSync(actionsPath, 'utf-8');
    // No local function definition for inferSubreddits
    expect(source).not.toMatch(/function\s+inferSubreddits/);
  });

  it('API routes exist for both actions', () => {
    const source = readFileSync(routesPath, 'utf-8');
    expect(source).toContain('actions/competitive-dive');
    expect(source).toContain('actions/community-check');
  });

  it('only one inferDiscourseForums exists (imported from discourse.ts)', () => {
    const source = readFileSync(actionsPath, 'utf-8');
    // Should import it, not define it locally
    expect(source).toMatch(/import\s*\{[^}]*inferDiscourseForums[^}]*\}\s*from/);
    // Should NOT have a local function definition
    expect(source).not.toMatch(/function\s+inferDiscourseForums/);
  });
});

describe('evidence grounding in generate.ts', () => {
  const generatePath = join(ROOT, 'src/api/generate.ts');

  it('defines EvidenceBundle type', () => {
    const source = readFileSync(generatePath, 'utf-8');
    expect(source).toContain('interface EvidenceBundle');
  });

  it('runInlineDiscovery returns EvidenceBundle (not string)', () => {
    const source = readFileSync(generatePath, 'utf-8');
    expect(source).toMatch(/async function runInlineDiscovery.*Promise<EvidenceBundle>/);
  });

  it('storeVariant accepts evidence bundle parameter', () => {
    const source = readFileSync(generatePath, 'utf-8');
    expect(source).toMatch(/async function storeVariant[\s\S]*?evidence\?: EvidenceBundle/);
  });

  it('storeVariant uses real practitioner quotes from evidence bundle', () => {
    const source = readFileSync(generatePath, 'utf-8');
    // Should NOT have hardcoded empty quotes
    expect(source).not.toMatch(/practitionerQuotes:\s*JSON\.stringify\(\[\]\)/);
    // Should use evidence bundle quotes
    expect(source).toMatch(/evidence\?\.practitionerQuotes/);
  });

  it('buildSystemPrompt includes anti-fabrication rules for product-only evidence', () => {
    const source = readFileSync(generatePath, 'utf-8');
    expect(source).toContain('You have NO community evidence');
    expect(source).toContain('Do NOT fabricate practitioner quotes');
  });

  it('buildSystemPrompt constrains use of real evidence when available', () => {
    const source = readFileSync(generatePath, 'utf-8');
    expect(source).toContain('ONLY reference practitioners and quotes from the "Verified Community Evidence" section');
  });

  it('outside-in pipeline falls back to standard when no evidence', () => {
    const source = readFileSync(generatePath, 'utf-8');
    expect(source).toContain("Outside-in pipeline requires community evidence but none was found");
    expect(source).toMatch(/return runStandardPipeline\(jobId, inputs\)/);
  });

  it('default generation model is Gemini (not Claude)', () => {
    const source = readFileSync(generatePath, 'utf-8');
    // The generateContent function should default to Gemini
    expect(source).toMatch(/Default.*Gemini/i);
    expect(source).toContain("model.includes('claude')");
  });

  it('competitive research uses extracted insights, not naive truncation', () => {
    const source = readFileSync(generatePath, 'utf-8');
    // Should NOT have productDocs.substring(0, 10000)
    expect(source).not.toMatch(/productDocs\.substring\(0,\s*10000\)/);
    // Should call extractInsights
    expect(source).toMatch(/buildResearchPromptFromDocs[\s\S]*?extractInsights/);
  });

  it('storeVariant calls validateGrounding before storage', () => {
    const source = readFileSync(generatePath, 'utf-8');
    expect(source).toContain('validateGrounding');
  });

  it('writes evidence_level to messaging_assets', () => {
    const source = readFileSync(generatePath, 'utf-8');
    expect(source).toMatch(/evidenceLevel:\s*evidence\?\.evidenceLevel/);
  });
});

describe('grounding-validator.ts', () => {
  const validatorPath = join(ROOT, 'src/services/quality/grounding-validator.ts');

  it('exists and exports validateGrounding', () => {
    const source = readFileSync(validatorPath, 'utf-8');
    expect(source).toMatch(/export\s+async\s+function\s+validateGrounding/);
  });

  it('detects common fabrication patterns', () => {
    const source = readFileSync(validatorPath, 'utf-8');
    expect(source).toContain('FABRICATION_PATTERNS');
    expect(source).toContain('as one');
    expect(source).toContain('practitioners');
    expect(source).toContain('community sentiment');
  });

  it('only strips fabrications when evidence level is product-only', () => {
    const source = readFileSync(validatorPath, 'utf-8');
    expect(source).toContain("evidenceLevel !== 'product-only'");
  });
});
