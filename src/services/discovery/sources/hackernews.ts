import { createLogger } from '../../../utils/logger.js';
import type { RawDiscoveredPainPoint, SourceConfig } from '../types.js';

const logger = createLogger('discovery:hackernews');

interface HNSearchResult {
  hits: HNHit[];
  nbHits: number;
  nbPages: number;
}

interface HNHit {
  objectID: string;
  title: string;
  story_text: string | null;
  comment_text: string | null;
  url: string | null;
  author: string;
  points: number | null;
  num_comments: number | null;
  created_at: string;
  created_at_i: number;
  _tags: string[];
}

export async function discoverFromHackerNews(config: SourceConfig): Promise<RawDiscoveredPainPoint[]> {
  const keywords = config.keywords;

  if (keywords.length === 0) {
    logger.warn('No keywords configured for Hacker News');
    return [];
  }

  const posts: RawDiscoveredPainPoint[] = [];
  const maxResults = config.maxResults || 25;

  for (const keyword of keywords) {
    try {
      // Use HN Algolia API to search stories and comments
      const query = encodeURIComponent(keyword);

      // Search stories
      const storiesUrl = `https://hn.algolia.com/api/v1/search_by_date?query=${query}&tags=story&hitsPerPage=${maxResults}`;
      const storiesResponse = await fetch(storiesUrl);

      if (!storiesResponse.ok) {
        logger.error(`HN Algolia API error (stories)`, { status: storiesResponse.status, keyword });
        continue;
      }

      const storiesData = (await storiesResponse.json()) as HNSearchResult;

      for (const hit of storiesData.hits) {
        const content = hit.story_text || hit.title;
        if (!content) continue;

        posts.push({
          sourceType: 'hackernews',
          sourceUrl: `https://news.ycombinator.com/item?id=${hit.objectID}`,
          sourceId: hit.objectID,
          title: hit.title || content.substring(0, 150),
          content: stripHtml(content),
          author: hit.author,
          metadata: {
            points: hit.points || 0,
            numComments: hit.num_comments || 0,
            externalUrl: hit.url || null,
            tags: hit._tags,
          },
          discoveredAt: hit.created_at,
        });
      }

      // Also search comments — these often have richer pain signals
      const commentsUrl = `https://hn.algolia.com/api/v1/search_by_date?query=${query}&tags=comment&hitsPerPage=${maxResults}`;
      const commentsResponse = await fetch(commentsUrl);

      if (commentsResponse.ok) {
        const commentsData = (await commentsResponse.json()) as HNSearchResult;

        for (const hit of commentsData.hits) {
          const content = hit.comment_text;
          if (!content) continue;

          // Only include substantial comments (not one-liners)
          const plainContent = stripHtml(content);
          if (plainContent.length < 100) continue;

          posts.push({
            sourceType: 'hackernews',
            sourceUrl: `https://news.ycombinator.com/item?id=${hit.objectID}`,
            sourceId: hit.objectID,
            title: plainContent.substring(0, 150),
            content: plainContent,
            author: hit.author,
            metadata: {
              points: hit.points || 0,
              isComment: true,
              tags: hit._tags,
            },
            discoveredAt: hit.created_at,
          });
        }
      }

      // Rate limiting
      await new Promise(resolve => setTimeout(resolve, 1000));
    } catch (error) {
      logger.error(`Failed to fetch Hacker News posts`, { keyword, error });
    }
  }

  // Deduplicate by sourceId
  const seen = new Set<string>();
  const deduped = posts.filter(post => {
    if (seen.has(post.sourceId)) return false;
    seen.add(post.sourceId);
    return true;
  });

  logger.info(`Discovered ${deduped.length} Hacker News items (${posts.length - deduped.length} duplicates removed)`);
  return deduped;
}

function stripHtml(html: string): string {
  return html
    .replace(/<p>/g, '\n\n')
    .replace(/<br\s*\/?>/g, '\n')
    .replace(/<pre><code>[\s\S]*?<\/code><\/pre>/g, '[code block]')
    .replace(/<a[^>]*href="([^"]*)"[^>]*>[^<]*<\/a>/g, '$1')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&#39;/g, "'")
    .trim();
}
