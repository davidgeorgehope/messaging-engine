import { GoogleGenAI } from '@google/genai';
import { config as appConfig } from '../../../config.js';
import { createLogger } from '../../../utils/logger.js';
import type { RawDiscoveredPainPoint, SourceConfig } from '../types.js';

const logger = createLogger('discovery:grounded-search');

function getClient(): GoogleGenAI {
  return new GoogleGenAI({ apiKey: appConfig.apiKeys.googleAi });
}

export async function discoverFromGroundedSearch(config: SourceConfig): Promise<RawDiscoveredPainPoint[]> {
  if (!appConfig.apiKeys.googleAi) {
    logger.warn('GOOGLE_AI_API_KEY not configured, skipping grounded search');
    return [];
  }

  const searchQueries = config.searchQueries || config.keywords;
  const maxResults = config.maxResults || 10;
  const posts: RawDiscoveredPainPoint[] = [];

  for (const query of searchQueries) {
    try {
      const client = getClient();

      const searchPrompt = `Search for recent community discussions, forum posts, and practitioner complaints about: "${query}"

Focus on finding:
- Reddit threads where practitioners describe pain points
- Stack Overflow questions showing frustration
- Hacker News discussions with strong opinions
- GitHub issues with many thumbs-up reactions
- Blog posts from practitioners (not vendors)

For each result found, provide:
1. The title or summary
2. The source URL
3. Key quotes expressing pain or frustration
4. The author or community context

Return as JSON array:
[
  {
    "title": "...",
    "url": "...",
    "content": "summary of the discussion and key pain points",
    "quotes": ["exact quote 1", "exact quote 2"],
    "source": "reddit|stackoverflow|hackernews|blog|github",
    "author": "username or community name"
  }
]

Find up to ${maxResults} highly relevant results. Only include results that express genuine practitioner pain, not vendor content.`;

      const response = await client.models.generateContent({
        model: appConfig.ai.gemini.flashModel,
        contents: searchPrompt,
        config: {
          temperature: 0.3,
          tools: [{ googleSearch: {} }],
        },
      });

      const text = response.text || '';

      // Extract grounding metadata for source attribution
      const groundingChunks = (response as any).candidates?.[0]?.groundingMetadata?.groundingChunks || [];

      // Parse the JSON response
      let results: any[] = [];
      try {
        const jsonMatch = text.match(/\[[\s\S]*\]/);
        if (jsonMatch) {
          results = JSON.parse(jsonMatch[0]);
        }
      } catch {
        logger.debug('Could not parse grounded search JSON, extracting from text');
        // If JSON parsing fails, create a single post from the text
        if (text.length > 50) {
          results = [{
            title: query,
            url: '',
            content: text,
            quotes: [],
            source: 'grounded_search',
            author: 'grounded_search',
          }];
        }
      }

      // Also create posts from grounding chunks directly
      for (const chunk of groundingChunks) {
        if (chunk?.web?.uri) {
          const existingResult = results.find((r: any) => r.url === chunk.web.uri);
          if (!existingResult) {
            results.push({
              title: chunk.web.title || query,
              url: chunk.web.uri,
              content: chunk.web.title || '',
              quotes: [],
              source: 'grounded_search',
              author: 'grounded_search',
            });
          }
        }
      }

      for (const result of results) {
        const sourceUrl = result.url || `grounded-search://${encodeURIComponent(query)}/${Date.now()}`;
        const content = [
          result.content || '',
          ...(result.quotes || []).map((q: string) => `> ${q}`),
        ].join('\n\n');

        if (content.length < 20) continue;

        posts.push({
          sourceType: 'grounded_search',
          sourceUrl,
          sourceId: `gs-${hashSimple(sourceUrl + query)}`,
          title: result.title || query,
          content,
          author: result.author || 'grounded_search',
          metadata: {
            searchQuery: query,
            originalSource: result.source || 'unknown',
            groundingChunkCount: groundingChunks.length,
          },
          discoveredAt: new Date().toISOString(),
        });
      }

      // Rate limiting for Gemini API
      await new Promise(resolve => setTimeout(resolve, 2000));
    } catch (error) {
      logger.error(`Failed grounded search`, { query, error });
    }
  }

  // Deduplicate by sourceUrl
  const seen = new Set<string>();
  const deduped = posts.filter(post => {
    if (seen.has(post.sourceUrl)) return false;
    seen.add(post.sourceUrl);
    return true;
  });

  logger.info(`Discovered ${deduped.length} items via grounded search (${posts.length - deduped.length} duplicates removed)`);
  return deduped;
}

function hashSimple(input: string): string {
  let hash = 0;
  for (let i = 0; i < input.length; i++) {
    const char = input.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash; // Convert to 32-bit integer
  }
  return Math.abs(hash).toString(36);
}
