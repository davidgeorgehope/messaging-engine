import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockGenerateJSON } = vi.hoisted(() => ({
  mockGenerateJSON: vi.fn(),
}));

vi.mock('../../../src/services/ai/clients.js', () => ({
  generateJSON: mockGenerateJSON,
}));

vi.mock('../../../src/utils/logger.js', () => ({
  createLogger: () => ({
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

import { analyzeSpecificity } from '../../../src/services/quality/specificity.js';

describe('analyzeSpecificity product filtering', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGenerateJSON.mockResolvedValue({
      data: {
        score: 7,
        concreteClaims: ['Uses OpenTelemetry collectors'],
        vagueClaims: [],
        assessment: 'Content is specific.',
      },
    });
  });

  it('should accept content and productDocs parameters', async () => {
    const result = await analyzeSpecificity('Test content', ['Doc 1', 'Doc 2']);

    expect(result).toEqual({
      score: 7,
      concreteClaims: ['Uses OpenTelemetry collectors'],
      vagueClaims: [],
      assessment: 'Content is specific.',
    });
  });

  it('should include product docs context in the prompt when docs are provided', async () => {
    await analyzeSpecificity('My messaging content', ['Product feature A', 'Product feature B']);

    expect(mockGenerateJSON).toHaveBeenCalledOnce();
    const prompt = mockGenerateJSON.mock.calls[0][0] as string;

    expect(prompt).toContain('PRODUCT CONTEXT');
    expect(prompt).toContain('Product feature A');
    expect(prompt).toContain('Product feature B');
  });

  it('should NOT include product docs context when docs array is empty', async () => {
    await analyzeSpecificity('My messaging content', []);

    expect(mockGenerateJSON).toHaveBeenCalledOnce();
    const prompt = mockGenerateJSON.mock.calls[0][0] as string;

    expect(prompt).not.toContain('PRODUCT CONTEXT');
  });

  it('should include the content in the prompt', async () => {
    await analyzeSpecificity('Specific messaging about OpenTelemetry', ['doc']);

    const prompt = mockGenerateJSON.mock.calls[0][0] as string;
    expect(prompt).toContain('Specific messaging about OpenTelemetry');
  });

  it('should return fallback scores when AI call fails', async () => {
    mockGenerateJSON.mockRejectedValue(new Error('API failure'));

    const result = await analyzeSpecificity('Content', []);

    expect(result).toEqual({
      score: 5,
      concreteClaims: [],
      vagueClaims: [],
      assessment: 'Analysis unavailable',
    });
  });

  it('should pass retryOnParseError option to generateJSON', async () => {
    await analyzeSpecificity('Content', []);

    const options = mockGenerateJSON.mock.calls[0][1];
    expect(options).toEqual(
      expect.objectContaining({
        retryOnParseError: true,
        maxParseRetries: 2,
      })
    );
  });

  it('should truncate long product docs to 2000 chars', async () => {
    const longDoc = 'x'.repeat(3000);
    await analyzeSpecificity('Content', [longDoc]);

    const prompt = mockGenerateJSON.mock.calls[0][0] as string;
    // The docsContext uses substring(0, 2000), so the product context portion
    // should not contain the full 3000-char string
    const productContextMatch = prompt.match(/PRODUCT CONTEXT[^]*$/);
    expect(productContextMatch).not.toBeNull();
    // The joined docs portion is truncated to 2000 chars
    const docsSection = prompt.split('PRODUCT CONTEXT')[1];
    // The 'x' characters in the prompt should be at most 2000
    const xCount = (docsSection.match(/x/g) || []).length;
    expect(xCount).toBeLessThanOrEqual(2000);
  });
});
