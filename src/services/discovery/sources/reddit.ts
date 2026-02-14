import { createLogger } from '../../../utils/logger.js';
import type { RawDiscoveredPainPoint, SourceConfig } from '../types.js';

const logger = createLogger('discovery:reddit');

interface RedditPost {
  data: {
    id: string;
    title: string;
    selftext: string;
    author: string;
    permalink: string;
    subreddit: string;
    score: number;
    num_comments: number;
    created_utc: number;
    link_flair_text?: string;
    url: string;
  };
}

interface RedditListing {
  data: {
    children: RedditPost[];
    after: string | null;
  };
}

export async function discoverFromReddit(config: SourceConfig): Promise<RawDiscoveredPainPoint[]> {
  const subreddits = config.subreddits || [];
  const keywords = config.keywords;

  if (subreddits.length === 0) {
    logger.warn('No subreddits configured');
    return [];
  }

  const posts: RawDiscoveredPainPoint[] = [];
  const maxResults = config.maxResults || 25;

  for (const subreddit of subreddits) {
    for (const keyword of keywords) {
      try {
        const query = encodeURIComponent(keyword);
        const url = `https://www.reddit.com/r/${subreddit}/search.json?q=${query}&restrict_sr=1&sort=new&limit=${maxResults}&t=month`;

        const response = await fetch(url, {
          headers: {
            'User-Agent': 'messaging-engine:discovery:v1.0 (by /u/messaging-engine-bot)',
          },
        });

        if (!response.ok) {
          logger.error(`Reddit API error`, { status: response.status, subreddit, keyword });
          continue;
        }

        const data = (await response.json()) as RedditListing;

        for (const child of data.data.children) {
          const post = child.data;

          // Skip posts with no self text (link-only posts)
          if (!post.selftext && !post.title) continue;

          posts.push({
            sourceType: 'reddit',
            sourceUrl: `https://www.reddit.com${post.permalink}`,
            sourceId: post.id,
            title: post.title,
            content: post.selftext || post.title,
            author: post.author,
            metadata: {
              subreddit: post.subreddit,
              score: post.score,
              numComments: post.num_comments,
              flair: post.link_flair_text || null,
            },
            discoveredAt: new Date(post.created_utc * 1000).toISOString(),
          });
        }

        // Rate limiting — Reddit JSON API requires respectful delays
        await new Promise(resolve => setTimeout(resolve, 2000));
      } catch (error) {
        logger.error(`Failed to fetch Reddit posts`, { subreddit, keyword, error });
      }
    }
  }

  // Deduplicate by sourceId
  const seen = new Set<string>();
  const deduped = posts.filter(post => {
    if (seen.has(post.sourceId)) return false;
    seen.add(post.sourceId);
    return true;
  });

  logger.info(`Discovered ${deduped.length} Reddit posts (${posts.length - deduped.length} duplicates removed)`);
  return deduped;
}
