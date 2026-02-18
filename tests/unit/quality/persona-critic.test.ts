import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../src/services/ai/clients.js', () => ({
  generateJSON: vi.fn().mockResolvedValue({
    data: [
      { name: 'Skeptical DBA', prompt: 'You are a skeptical DBA. Score this 0-10.' },
      { name: 'Budget Lead', prompt: 'You are a budget-conscious lead. Score this 0-10.' },
      { name: 'Busy Dev', prompt: 'You are a busy developer. Score this 0-10.' },
    ],
    usage: { inputTokens: 100, outputTokens: 200 },
    model: 'gemini-2.5-flash',
  }),
}));

vi.mock('../../../src/config.js', () => ({
  getModelForTask: vi.fn().mockReturnValue('gemini-2.5-flash'),
}));

vi.mock('../../../src/utils/logger.js', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import { runPersonaCritics, type PersonaScoringContext } from '../../../src/services/quality/persona-critic.js';
import { generateJSON } from '../../../src/services/ai/clients.js';

describe('persona-critic', () => {
  const mockContext: PersonaScoringContext = {
    domain: 'databases',
    category: 'time-series',
    targetPersonas: ['Database Administrator', 'Platform Engineer'],
    painPointsAddressed: ['Slow queries', 'High storage costs'],
    productName: 'TimeScaleDB',
  };

  beforeEach(() => {
    vi.clearAllMocks();
    // Reset generateJSON mock for persona generation
    vi.mocked(generateJSON).mockResolvedValue({
      data: [
        { name: 'Skeptical DBA', prompt: 'You are a skeptical DBA. Score this 0-10.' },
        { name: 'Budget Lead', prompt: 'You are a budget-conscious lead. Score this 0-10.' },
        { name: 'Busy Dev', prompt: 'You are a busy developer. Score this 0-10.' },
      ],
      usage: { inputTokens: 100, outputTokens: 200 },
      model: 'gemini-2.5-flash',
    } as any);
  });

  describe('with no context (generic fallback)', () => {
    it('uses generic fallback personas when no context provided', async () => {
      // Mock generateJSON for the single critic calls (3 personas)
      vi.mocked(generateJSON).mockResolvedValue({
        data: { score: 7, feedback: 'Decent', strengths: ['clear'], weaknesses: ['vague'] },
        usage: { inputTokens: 50, outputTokens: 100 },
        model: 'gemini-2.5-flash',
      } as any);

      const results = await runPersonaCritics('Test messaging content');

      expect(results).toHaveLength(3);
      // Generic personas — no LLM call for persona generation
      expect(results[0].personaName).toBe('Skeptical Senior Practitioner');
      expect(results[1].personaName).toBe('Cost-Conscious Technical Lead');
      expect(results[2].personaName).toBe('Busy Practitioner Who Hates Complexity');
    });

    it('generic fallback personas have no domain-specific references', async () => {
      vi.mocked(generateJSON).mockResolvedValue({
        data: { score: 5, feedback: 'ok', strengths: [], weaknesses: [] },
        usage: { inputTokens: 50, outputTokens: 100 },
        model: 'gemini-2.5-flash',
      } as any);

      const results = await runPersonaCritics('content');
      // Verify no SRE/observability/DevOps hardcoded references
      for (const r of results) {
        expect(r.personaName).not.toMatch(/SRE|DevOps|O11y|observability/i);
      }
    });
  });

  describe('with context (LLM-generated personas)', () => {
    it('generates personas from context on first call', async () => {
      // First call: generateJSON for persona generation
      // Then 3 calls for scoring each persona
      let callCount = 0;
      vi.mocked(generateJSON).mockImplementation(async () => {
        callCount++;
        if (callCount === 1) {
          // Persona generation call
          return {
            data: [
              { name: 'Skeptical DBA', prompt: 'Score 0-10.' },
              { name: 'Budget Eng', prompt: 'Score 0-10.' },
              { name: 'Busy Dev', prompt: 'Score 0-10.' },
            ],
            usage: { inputTokens: 100, outputTokens: 200 },
            model: 'gemini-2.5-flash',
          } as any;
        }
        // Scoring calls
        return {
          data: { score: 7, feedback: 'Good', strengths: ['solid'], weaknesses: ['could improve'] },
          usage: { inputTokens: 50, outputTokens: 100 },
          model: 'gemini-2.5-flash',
        } as any;
      });

      const results = await runPersonaCritics('Test content', mockContext);

      expect(results).toHaveLength(3);
      expect(results[0].personaName).toBe('Skeptical DBA');
      // 1 generation call + 3 scoring calls = 4 total
      expect(generateJSON).toHaveBeenCalledTimes(4);
    });

    it('caches generated personas for same domain:category', async () => {
      // Use a unique domain:category to avoid cache from other tests
      const cacheContext = { ...mockContext, domain: 'cache-test-domain', category: 'cache-test-category' };
      let genCalls = 0;
      vi.mocked(generateJSON).mockImplementation(async (prompt: string) => {
        if (typeof prompt === 'string' && prompt.includes('Generate 3 critic personas')) {
          genCalls++;
          return {
            data: [
              { name: 'Persona A', prompt: 'Score 0-10.' },
              { name: 'Persona B', prompt: 'Score 0-10.' },
              { name: 'Persona C', prompt: 'Score 0-10.' },
            ],
            usage: { inputTokens: 100, outputTokens: 200 },
            model: 'gemini-2.5-flash',
          } as any;
        }
        return {
          data: { score: 6, feedback: 'Ok', strengths: [], weaknesses: [] },
          usage: { inputTokens: 50, outputTokens: 100 },
          model: 'gemini-2.5-flash',
        } as any;
      });

      // Call twice with same context
      await runPersonaCritics('Content A', cacheContext);
      await runPersonaCritics('Content B', cacheContext);

      // Persona generation should only happen once (cached)
      expect(genCalls).toBe(1);
    });
  });

  describe('error handling', () => {
    it('falls back to generic personas when LLM generation fails', async () => {
      let callCount = 0;
      vi.mocked(generateJSON).mockImplementation(async (prompt: string) => {
        callCount++;
        if (callCount === 1 && typeof prompt === 'string' && prompt.includes('Generate 3 critic personas')) {
          throw new Error('API quota exceeded');
        }
        return {
          data: { score: 5, feedback: 'Fallback', strengths: [], weaknesses: [] },
          usage: { inputTokens: 50, outputTokens: 100 },
          model: 'gemini-2.5-flash',
        } as any;
      });

      // Use a unique domain:category to avoid cache from other tests
      const uniqueContext = { ...mockContext, domain: 'unique-error-test', category: 'unique' };
      const results = await runPersonaCritics('Content', uniqueContext);

      expect(results).toHaveLength(3);
      expect(results[0].personaName).toBe('Skeptical Senior Practitioner');
    });

    it('returns score 5 when individual critic fails', async () => {
      let callCount = 0;
      vi.mocked(generateJSON).mockImplementation(async () => {
        callCount++;
        if (callCount <= 1) {
          // Persona generation succeeds
          return {
            data: [
              { name: 'Good', prompt: 'Score 0-10.' },
              { name: 'Bad', prompt: 'Score 0-10.' },
              { name: 'Ugly', prompt: 'Score 0-10.' },
            ],
            usage: { inputTokens: 100, outputTokens: 200 },
            model: 'gemini-2.5-flash',
          } as any;
        }
        if (callCount === 3) {
          // Second critic fails
          throw new Error('Critic failed');
        }
        return {
          data: { score: 8, feedback: 'Great', strengths: ['a'], weaknesses: ['b'] },
          usage: { inputTokens: 50, outputTokens: 100 },
          model: 'gemini-2.5-flash',
        } as any;
      });

      const ctx = { ...mockContext, domain: 'error-single-test', category: 'single' };
      const results = await runPersonaCritics('Content', ctx);

      expect(results).toHaveLength(3);
      // The failed critic should get score 5
      const failedCritic = results.find(r => r.score === 5);
      expect(failedCritic).toBeDefined();
      expect(failedCritic!.feedback).toBe('Critic analysis failed');
    });
  });
});
