import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  extractKeywords,
  inferSubreddits,
  inferStackOverflowTags,
  inferGitHubRepos,
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

describe('extractKeywords', () => {
  it('extracts keywords from pain point title', () => {
    const keywords = extractKeywords(
      { manualPainPoint: '' },
      { title: 'Kubernetes monitoring is unreliable with Prometheus' },
      '',
    );
    expect(keywords.length).toBeGreaterThan(0);
    expect(keywords).toContain('kubernetes');
    expect(keywords).toContain('monitoring');
  });

  it('filters stopwords', () => {
    const keywords = extractKeywords(
      { manualPainPoint: 'the monitoring system is not working for our team' },
      null,
      '',
    );
    expect(keywords).not.toContain('the');
    expect(keywords).not.toContain('not');
    expect(keywords).not.toContain('for');
    expect(keywords).not.toContain('our');
  });

  it('caps at 8 keywords', () => {
    const keywords = extractKeywords(
      { manualPainPoint: '' },
      { title: 'Kubernetes monitoring Prometheus Grafana alerting dashboard metrics OpenTelemetry tracing logging observability' },
      '',
    );
    expect(keywords.length).toBeLessThanOrEqual(8);
  });

  it('returns empty array for empty input', () => {
    const keywords = extractKeywords({}, null, '');
    expect(keywords).toEqual([]);
  });

  it('deduplicates keywords', () => {
    const keywords = extractKeywords(
      { manualPainPoint: 'monitoring monitoring monitoring alerts alerts' },
      null,
      '',
    );
    const unique = new Set(keywords);
    expect(keywords.length).toBe(unique.size);
  });

  it('is synchronous (not async)', () => {
    const result = extractKeywords({ manualPainPoint: 'test' }, null, '');
    // If it were async, this would be a Promise
    expect(result).toBeInstanceOf(Array);
  });
});

describe('inferSubreddits', () => {
  it('caps at 6 subreddits', () => {
    // Trigger many matches
    const result = inferSubreddits(['observability', 'kubernetes', 'docker', 'aws', 'security', 'data']);
    expect(result.length).toBeLessThanOrEqual(6);
  });

  it('baseline includes sre (not sysadmin)', () => {
    const result = inferSubreddits([]);
    expect(result).toContain('sre');
    expect(result).not.toContain('sysadmin');
  });

  it('always includes devops', () => {
    const result = inferSubreddits([]);
    expect(result).toContain('devops');
  });

  it('adds observability subreddit for monitoring keywords', () => {
    const result = inferSubreddits(['monitoring']);
    expect(result).toContain('observability');
  });
});

describe('inferStackOverflowTags', () => {
  it('caps at 5 tags', () => {
    const result = inferStackOverflowTags(['observability', 'elasticsearch', 'grafana', 'kubernetes', 'docker', 'terraform', 'logging']);
    expect(result.length).toBeLessThanOrEqual(5);
  });

  it('returns empty for no matching keywords', () => {
    const result = inferStackOverflowTags(['blockchain', 'quantum']);
    expect(result).toEqual([]);
  });

  it('matches kubernetes keywords', () => {
    const result = inferStackOverflowTags(['kubernetes']);
    expect(result).toContain('kubernetes');
  });
});

describe('inferGitHubRepos', () => {
  it('caps at 4 repos', () => {
    const result = inferGitHubRepos(['elasticsearch', 'grafana', 'prometheus', 'kubernetes', 'opentelemetry']);
    expect(result.length).toBeLessThanOrEqual(4);
  });

  it('returns empty for no matching keywords', () => {
    const result = inferGitHubRepos(['blockchain']);
    expect(result).toEqual([]);
  });

  it('returns full repo paths', () => {
    const result = inferGitHubRepos(['grafana']);
    expect(result[0]).toBe('grafana/grafana');
  });
});

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
