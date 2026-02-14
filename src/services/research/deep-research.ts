import { GoogleGenAI } from '@google/genai';
import { config } from '../../config.js';
import { createLogger } from '../../utils/logger.js';
import type { SearchResult } from '../ai/types.js';

const logger = createLogger('research:deep-research');

const DEEP_RESEARCH_AGENT = config.ai.gemini.deepResearchAgent;
const POLL_INTERVAL_MS = config.deepResearch.pollIntervalMs;
const MAX_DURATION_MS = config.deepResearch.timeoutMs;

function getClient(): GoogleGenAI {
  return new GoogleGenAI({ apiKey: config.apiKeys.googleAi });
}

export async function createDeepResearchInteraction(prompt: string): Promise<string> {
  const client = getClient();
  logger.info('Creating Deep Research interaction');

  const interaction = await (client as any).interactions.create({
    input: prompt,
    agent: DEEP_RESEARCH_AGENT,
    background: true,
    store: true,
  });

  logger.info('Deep Research interaction created', { id: interaction.id });
  return interaction.id;
}

export async function pollInteractionUntilComplete(
  interactionId: string,
  onProgress?: (status: string) => void,
): Promise<{ text: string; sources: SearchResult[] }> {
  const client = getClient();
  const startTime = Date.now();

  logger.info('Polling Deep Research interaction', { interactionId });

  while (true) {
    const elapsed = Date.now() - startTime;
    if (elapsed > MAX_DURATION_MS) {
      throw new Error(`Deep Research timed out after ${MAX_DURATION_MS / 1000}s`);
    }

    const interaction = await (client as any).interactions.get(interactionId);
    const status = interaction.status;

    logger.debug('Poll status', { interactionId, status, elapsed: `${Math.round(elapsed / 1000)}s` });
    onProgress?.(status);

    if (status === 'completed') {
      const text = extractTextFromOutputs(interaction.outputs);
      const sources = extractSourcesFromResponse(interaction, text);
      logger.info('Deep Research completed', { textLength: text.length, sourceCount: sources.length });
      return { text, sources };
    }

    if (status === 'failed') {
      throw new Error(`Deep Research failed: ${interaction.error || 'Unknown error'}`);
    }

    await sleep(POLL_INTERVAL_MS);
  }
}

function extractTextFromOutputs(outputs: any[]): string {
  if (!outputs || outputs.length === 0) return '';

  return outputs
    .map((output: any) => {
      if (typeof output === 'string') return output;
      if (output.text) return output.text;
      if (output.content) return typeof output.content === 'string' ? output.content : JSON.stringify(output.content);
      return '';
    })
    .filter(Boolean)
    .join('\n\n');
}

function extractSourcesFromResponse(interaction: any, text: string): SearchResult[] {
  const sources: SearchResult[] = [];
  const seenUrls = new Set<string>();

  // Extract from markdown links in text
  const linkRegex = /\[([^\]]+)\]\(([^)]+)\)/g;
  let match;
  while ((match = linkRegex.exec(text)) !== null) {
    const [, title, url] = match;
    if (url.startsWith('http') && !seenUrls.has(url)) {
      seenUrls.add(url);
      sources.push({ title, url, snippet: '' });
    }
  }

  // Extract from grounding metadata
  const groundingPaths = [
    interaction?.groundingMetadata?.groundingChunks,
    interaction?.candidates?.[0]?.groundingMetadata?.groundingChunks,
  ];

  for (const chunks of groundingPaths) {
    if (!chunks) continue;
    for (const chunk of chunks) {
      if (chunk?.web?.uri && !seenUrls.has(chunk.web.uri)) {
        seenUrls.add(chunk.web.uri);
        sources.push({
          title: chunk.web.title || '',
          url: chunk.web.uri,
          snippet: '',
        });
      }
    }
  }

  return sources;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
