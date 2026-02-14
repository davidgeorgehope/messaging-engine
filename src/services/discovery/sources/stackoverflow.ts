import { createLogger } from '../../../utils/logger.js';
import type { RawDiscoveredPainPoint, SourceConfig } from '../types.js';

const logger = createLogger('discovery:stackoverflow');

interface StackExchangeQuestion {
  question_id: number;
  title: string;
  body: string;
  tags: string[];
  score: number;
  answer_count: number;
  view_count: number;
  is_answered: boolean;
  link: string;
  owner: {
    display_name: string;
    reputation?: number;
  };
  creation_date: number;
}

interface StackExchangeResponse {
  items: StackExchangeQuestion[];
  has_more: boolean;
  quota_remaining: number;
}

export async function discoverFromStackOverflow(config: SourceConfig): Promise<RawDiscoveredPainPoint[]> {
  const tags = config.tags || [];
  const keywords = config.keywords;

  if (tags.length === 0 && keywords.length === 0) {
    logger.warn('No tags or keywords configured for Stack Overflow');
    return [];
  }

  const posts: RawDiscoveredPainPoint[] = [];
  const maxResults = config.maxResults || 25;

  // Search by keyword with tag filtering
  for (const keyword of keywords) {
    try {
      const tagParam = tags.length > 0 ? `&tagged=${tags.join(';')}` : '';
      const query = encodeURIComponent(keyword);
      const url = `https://api.stackexchange.com/2.3/search/advanced?order=desc&sort=creation&q=${query}${tagParam}&site=stackoverflow&filter=withbody&pagesize=${maxResults}`;

      const response = await fetch(url);

      if (!response.ok) {
        logger.error(`Stack Exchange API error`, { status: response.status, keyword });
        continue;
      }

      const data = (await response.json()) as StackExchangeResponse;

      logger.debug('Stack Exchange quota', { remaining: data.quota_remaining });

      for (const question of data.items) {
        // Strip HTML tags from body for plain text content
        const plainContent = question.body
          .replace(/<pre><code>[\s\S]*?<\/code><\/pre>/g, '[code block]')
          .replace(/<[^>]+>/g, '')
          .replace(/&amp;/g, '&')
          .replace(/&lt;/g, '<')
          .replace(/&gt;/g, '>')
          .replace(/&quot;/g, '"')
          .replace(/&#39;/g, "'");

        posts.push({
          sourceType: 'stackoverflow',
          sourceUrl: question.link,
          sourceId: question.question_id.toString(),
          title: question.title,
          content: plainContent,
          author: question.owner.display_name,
          metadata: {
            tags: question.tags,
            score: question.score,
            answerCount: question.answer_count,
            viewCount: question.view_count,
            isAnswered: question.is_answered,
            authorReputation: question.owner.reputation || 0,
          },
          discoveredAt: new Date(question.creation_date * 1000).toISOString(),
        });
      }

      // Rate limiting — Stack Exchange API has strict limits
      await new Promise(resolve => setTimeout(resolve, 1000));
    } catch (error) {
      logger.error(`Failed to fetch Stack Overflow questions`, { keyword, error });
    }
  }

  // Deduplicate by sourceId
  const seen = new Set<string>();
  const deduped = posts.filter(post => {
    if (seen.has(post.sourceId)) return false;
    seen.add(post.sourceId);
    return true;
  });

  logger.info(`Discovered ${deduped.length} Stack Overflow questions (${posts.length - deduped.length} duplicates removed)`);
  return deduped;
}
