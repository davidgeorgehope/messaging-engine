import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../src/services/ai/clients.js', () => ({
  generateJSON: vi.fn(),
}));

vi.mock('../../../src/config.js', () => ({
  getModelForTask: vi.fn().mockReturnValue('gemini-2.5-flash'),
}));

vi.mock('../../../src/utils/logger.js', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import { validateGrounding } from '../../../src/services/quality/grounding-validator.js';
import { generateJSON } from '../../../src/services/ai/clients.js';

describe('grounding-validator', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('early return for grounded content', () => {
    it('returns immediately for strong evidence (no LLM call)', async () => {
      const result = await validateGrounding('Content with community refs', 'strong');

      expect(result.hasFabricationPatterns).toBe(false);
      expect(result.fabricationCount).toBe(0);
      expect(result.matchedPatterns).toEqual([]);
      expect(result.fabricationStripped).toBe(false);
      expect(generateJSON).not.toHaveBeenCalled();
    });

    it('returns immediately for partial evidence (no LLM call)', async () => {
      const result = await validateGrounding('Content with some refs', 'partial');

      expect(result.hasFabricationPatterns).toBe(false);
      expect(result.fabricationStripped).toBe(false);
      expect(generateJSON).not.toHaveBeenCalled();
    });
  });

  describe('LLM-based detection for product-only', () => {
    it('detects and strips fabrications', async () => {
      vi.mocked(generateJSON).mockResolvedValue({
        data: {
          fabricatedReferences: [
            'Fake Reddit quote about monitoring tools',
            'Invented HN discussion about deployment',
          ],
          cleanedContent: 'Clean content without fabrications',
        },
        usage: { inputTokens: 500, outputTokens: 300 },
        model: 'gemini-2.5-flash',
      } as any);

      const result = await validateGrounding('Content with fake quotes from r/devops', 'product-only');

      expect(result.hasFabricationPatterns).toBe(true);
      expect(result.fabricationCount).toBe(2);
      expect(result.matchedPatterns).toEqual([
        'Fake Reddit quote about monitoring tools',
        'Invented HN discussion about deployment',
      ]);
      expect(result.strippedContent).toBe('Clean content without fabrications');
      expect(result.fabricationStripped).toBe(true);
      expect(generateJSON).toHaveBeenCalledTimes(1);
    });

    it('returns no fabrication when LLM finds none', async () => {
      vi.mocked(generateJSON).mockResolvedValue({
        data: {
          fabricatedReferences: [],
          cleanedContent: 'Original content unchanged',
        },
        usage: { inputTokens: 500, outputTokens: 300 },
        model: 'gemini-2.5-flash',
      } as any);

      const result = await validateGrounding('Clean product-only content', 'product-only');

      expect(result.hasFabricationPatterns).toBe(false);
      expect(result.fabricationCount).toBe(0);
      expect(result.strippedContent).toBeUndefined();
      expect(result.fabricationStripped).toBe(false);
    });
  });

  describe('fail-open behavior', () => {
    it('fails open when LLM call throws', async () => {
      vi.mocked(generateJSON).mockRejectedValue(new Error('API rate limit'));

      const result = await validateGrounding('Content to check', 'product-only');

      expect(result.hasFabricationPatterns).toBe(false);
      expect(result.fabricationCount).toBe(0);
      expect(result.matchedPatterns).toEqual([]);
      expect(result.fabricationStripped).toBe(false);
      expect(result.strippedContent).toBeUndefined();
    });
  });
});
