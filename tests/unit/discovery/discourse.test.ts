import { describe, it, expect } from 'vitest';
import { stripDiscourseHtml, inferDiscourseForums } from '../../../src/services/discovery/sources/discourse.js';

describe('stripDiscourseHtml', () => {
  it('removes search highlight spans', () => {
    const input = 'This has <span class="search-highlight">highlighted</span> text';
    expect(stripDiscourseHtml(input)).toBe('This has highlighted text');
  });

  it('converts blockquotes to bracketed text', () => {
    const input = '<blockquote>quoted text</blockquote>';
    expect(stripDiscourseHtml(input)).toBe('[quote] quoted text [/quote]');
  });

  it('replaces code blocks with placeholder', () => {
    const input = '<pre><code>const x = 1;</code></pre>';
    expect(stripDiscourseHtml(input)).toBe('[code block]');
  });

  it('preserves inline code content', () => {
    const input = 'Use <code>kubectl get pods</code> to list pods';
    expect(stripDiscourseHtml(input)).toBe('Use kubectl get pods to list pods');
  });

  it('decodes HTML entities', () => {
    const input = '5 &gt; 3 &amp; 2 &lt; 4 &quot;hello&quot; &#x27;world&#39;';
    expect(stripDiscourseHtml(input)).toBe('5 > 3 & 2 < 4 "hello" \'world\'');
  });

  it('strips remaining HTML tags', () => {
    const input = '<div class="post"><p>Hello <strong>world</strong></p></div>';
    const result = stripDiscourseHtml(input);
    expect(result).not.toContain('<');
    expect(result).not.toContain('>');
    expect(result).toContain('Hello');
    expect(result).toContain('world');
  });

  it('extracts link text', () => {
    const input = 'Visit <a href="https://example.com">this page</a> for details';
    expect(stripDiscourseHtml(input)).toBe('Visit this page for details');
  });

  it('collapses excessive newlines', () => {
    const input = '<p>First</p><p></p><p></p><p>Second</p>';
    const result = stripDiscourseHtml(input);
    expect(result).not.toMatch(/\n{3,}/);
  });

  it('trims whitespace', () => {
    const input = '  <p>content</p>  ';
    expect(stripDiscourseHtml(input)).toBe('content');
  });

  it('handles complex real-world blurb', () => {
    const input = '<span class="search-highlight">monitoring</span> is broken in <code>v2.1</code> &mdash; see <a href="/t/123">this thread</a>';
    const result = stripDiscourseHtml(input);
    expect(result).toContain('monitoring');
    expect(result).toContain('v2.1');
    expect(result).toContain('this thread');
    expect(result).not.toContain('search-highlight');
  });
});

describe('inferDiscourseForums', () => {
  it('always includes default forums (Elastic + Grafana)', () => {
    const forums = inferDiscourseForums([]);
    const hosts = forums.map(f => f.host);
    expect(hosts).toContain('discuss.elastic.co');
    expect(hosts).toContain('community.grafana.com');
  });

  it('adds kubernetes forum for k8s keywords', () => {
    const forums = inferDiscourseForums(['kubernetes']);
    const hosts = forums.map(f => f.host);
    expect(hosts).toContain('discuss.kubernetes.io');
  });

  it('adds docker forum for container keywords', () => {
    const forums = inferDiscourseForums(['docker']);
    const hosts = forums.map(f => f.host);
    expect(hosts).toContain('forums.docker.com');
  });

  it('adds hashicorp forum for terraform keywords', () => {
    const forums = inferDiscourseForums(['terraform']);
    const hosts = forums.map(f => f.host);
    expect(hosts).toContain('discuss.hashicorp.com');
  });

  it('returns no duplicate entries', () => {
    const forums = inferDiscourseForums(['kubernetes', 'k8s', 'kubectl', 'helm']);
    const hosts = forums.map(f => f.host);
    expect(hosts.length).toBe(new Set(hosts).size);
  });

  it('matches keywords case-insensitively', () => {
    const forums = inferDiscourseForums(['KUBERNETES']);
    const hosts = forums.map(f => f.host);
    expect(hosts).toContain('discuss.kubernetes.io');
  });

  it('includes all 10 conditional forum mappings', () => {
    // Trigger all possible mappings
    const forums = inferDiscourseForums([
      'kubernetes', 'docker', 'terraform', 'circleci',
      'ansible', 'puppet', 'newrelic', 'datadog', 'gitlab', 'ray',
    ]);
    // 2 defaults + 10 conditional = 12
    expect(forums.length).toBe(12);
  });
});
