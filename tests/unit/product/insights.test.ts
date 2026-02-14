import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockGenerateWithGemini = vi.hoisted(() => vi.fn());

vi.mock('../../../src/services/ai/clients.js', () => ({
  generateWithGemini: mockGenerateWithGemini,
}));

vi.mock('../../../src/utils/logger.js', () => ({
  createLogger: () => ({ info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import {
  extractInsights,
  buildFallbackInsights,
  formatInsightsForPrompt,
  formatInsightsForDiscovery,
  formatInsightsForScoring,
  formatInsightsForResearch,
  type ExtractedInsights,
} from '../../../src/services/product/insights.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------
const fullInsights: ExtractedInsights = {
  productCapabilities: ['Log ingestion at 1TB/day', 'Real-time alerting'],
  keyDifferentiators: ['10x cheaper than Splunk', 'No vendor lock-in'],
  targetPersonas: ['SRE teams', 'Platform engineers'],
  painPointsAddressed: ['Alert fatigue from noisy dashboards', 'Slow query times on large datasets'],
  claimsAndMetrics: ['99.9% uptime SLA', '50ms p95 query latency'],
  technicalDetails: ['Built on ClickHouse', 'OpenTelemetry native'],
  summary: 'An observability platform that ingests logs, metrics, and traces at scale.',
  domain: 'observability',
  category: 'log management',
  productType: 'SaaS platform',
};

const emptyInsights: ExtractedInsights = {
  productCapabilities: [],
  keyDifferentiators: [],
  targetPersonas: [],
  painPointsAddressed: [],
  claimsAndMetrics: [],
  technicalDetails: [],
  summary: '',
  domain: 'unknown',
  category: 'unknown',
  productType: 'unknown',
};

// ---------------------------------------------------------------------------
// extractInsights
// ---------------------------------------------------------------------------
describe('extractInsights', () => {
  beforeEach(() => vi.clearAllMocks());

  it('parses valid JSON response', async () => {
    mockGenerateWithGemini.mockResolvedValue({
      text: JSON.stringify(fullInsights),
      usage: { inputTokens: 100, outputTokens: 200, totalTokens: 300 },
    });

    const result = await extractInsights('some product docs');

    expect(result).not.toBeNull();
    expect(result!.productCapabilities).toEqual(fullInsights.productCapabilities);
    expect(result!.domain).toBe('observability');
  });

  it('strips code-fence wrapping', async () => {
    mockGenerateWithGemini.mockResolvedValue({
      text: '```json\n' + JSON.stringify(fullInsights) + '\n```',
      usage: { inputTokens: 100, outputTokens: 200, totalTokens: 300 },
    });

    const result = await extractInsights('docs');

    expect(result).not.toBeNull();
    expect(result!.domain).toBe('observability');
  });

  it('returns null on AI failure', async () => {
    mockGenerateWithGemini.mockRejectedValue(new Error('API error'));

    const result = await extractInsights('docs');

    expect(result).toBeNull();
  });

  it('returns null on invalid JSON', async () => {
    mockGenerateWithGemini.mockResolvedValue({
      text: 'this is not json at all',
      usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 },
    });

    const result = await extractInsights('docs');

    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// buildFallbackInsights
// ---------------------------------------------------------------------------
describe('buildFallbackInsights', () => {
  it('extracts first 3 sentences as summary', () => {
    const docs = 'First sentence. Second sentence. Third sentence. Fourth sentence.';
    const result = buildFallbackInsights(docs);

    expect(result.summary).toContain('First sentence');
    expect(result.summary).toContain('Second sentence');
    expect(result.summary).toContain('Third sentence');
    expect(result.summary).not.toContain('Fourth sentence');
  });

  it('handles single sentence without crashing', () => {
    const result = buildFallbackInsights('Only one sentence here');

    expect(result.summary).toBeTruthy();
    expect(result.domain).toBe('unknown');
    expect(result.productCapabilities).toEqual([]);
  });

  it('handles empty input', () => {
    const result = buildFallbackInsights('');

    expect(result.summary).toBeDefined();
    expect(result.domain).toBe('unknown');
  });
});

// ---------------------------------------------------------------------------
// formatInsightsForPrompt
// ---------------------------------------------------------------------------
describe('formatInsightsForPrompt', () => {
  it('includes all non-empty sections', () => {
    const result = formatInsightsForPrompt(fullInsights);

    expect(result).toContain('### Product Summary');
    expect(result).toContain('### Pain Points Addressed');
    expect(result).toContain('### Capabilities');
    expect(result).toContain('### Key Differentiators');
    expect(result).toContain('### Claims & Metrics');
    expect(result).toContain('### Target Personas');
    expect(result).toContain('### Technical Details');
  });

  it('excludes empty arrays', () => {
    const sparse: ExtractedInsights = {
      ...emptyInsights,
      summary: 'A product summary.',
      productCapabilities: ['One capability'],
    };

    const result = formatInsightsForPrompt(sparse);

    expect(result).toContain('### Product Summary');
    expect(result).toContain('### Capabilities');
    expect(result).not.toContain('### Pain Points Addressed');
    expect(result).not.toContain('### Key Differentiators');
    expect(result).not.toContain('### Technical Details');
  });
});

// ---------------------------------------------------------------------------
// formatInsightsForDiscovery
// ---------------------------------------------------------------------------
describe('formatInsightsForDiscovery', () => {
  it('produces short output with domain/category/type', () => {
    const result = formatInsightsForDiscovery(fullInsights);

    expect(result).toContain('observability');
    expect(result).toContain('log management');
    expect(result).toContain('SaaS platform');
    expect(result.length).toBeLessThan(200);
  });

  it('returns empty string when all fields are unknown', () => {
    const result = formatInsightsForDiscovery(emptyInsights);
    expect(result).toBe('');
  });

  it('filters out unknown values', () => {
    const partial: ExtractedInsights = {
      ...emptyInsights,
      domain: 'security',
      category: 'unknown',
      productType: 'SaaS platform',
    };
    const result = formatInsightsForDiscovery(partial);

    expect(result).toContain('security');
    expect(result).toContain('SaaS platform');
    expect(result).not.toContain('unknown');
  });
});

// ---------------------------------------------------------------------------
// formatInsightsForScoring
// ---------------------------------------------------------------------------
describe('formatInsightsForScoring', () => {
  it('includes capabilities and claims', () => {
    const result = formatInsightsForScoring(fullInsights);

    expect(result).toContain('Capabilities:');
    expect(result).toContain('Log ingestion at 1TB/day');
    expect(result).toContain('Claims & Metrics:');
    expect(result).toContain('99.9% uptime SLA');
  });

  it('includes differentiators', () => {
    const result = formatInsightsForScoring(fullInsights);

    expect(result).toContain('Differentiators:');
    expect(result).toContain('10x cheaper than Splunk');
  });

  it('returns empty string when all arrays are empty', () => {
    const result = formatInsightsForScoring(emptyInsights);
    expect(result).toBe('');
  });
});

// ---------------------------------------------------------------------------
// formatInsightsForResearch
// ---------------------------------------------------------------------------
describe('formatInsightsForResearch', () => {
  it('includes summary, capabilities, differentiators, and personas', () => {
    const result = formatInsightsForResearch(fullInsights);

    expect(result).toContain('Product:');
    expect(result).toContain('Capabilities:');
    expect(result).toContain('Key Differentiators:');
    expect(result).toContain('Target Personas:');
  });

  it('returns empty string when no fields are populated', () => {
    const result = formatInsightsForResearch(emptyInsights);
    expect(result).toBe('');
  });
});
