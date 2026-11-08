/**
 * Community and competitive research via xAI web search on grok-4.7.
 * Research is one grok-4.7 web_search call, returned through the existing interaction id.
 */
import { generateWithWebSearch } from '../ai/clients.js';
import { createLogger } from '../../utils/logger.js';
import type { SearchResult } from '../ai/types.js';

const logger = createLogger('research:web-search');

const results = new Map<string, { text: string; sources: SearchResult[] }>();

export async function createDeepResearchInteraction(prompt: string): Promise<string> {
  logger.info('Running xAI web research', { promptLength: prompt.length });
  const result = await generateWithWebSearch(prompt);
  const id = `xai-search-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  results.set(id, { text: result.text, sources: result.sources });
  return id;
}

export async function pollInteractionUntilComplete(
  interactionId: string,
  onProgress?: (status: string) => void,
): Promise<{ text: string; sources: SearchResult[] }> {
  const cached = results.get(interactionId);
  if (!cached) {
    throw new Error(`Unknown research interaction: ${interactionId}`);
  }
  results.delete(interactionId);
  onProgress?.('completed');
  logger.info('xAI web research ready', {
    interactionId,
    textLength: cached.text.length,
    sourceCount: cached.sources.length,
  });
  return cached;
}
