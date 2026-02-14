import { createLogger } from '../../../utils/logger.js';
import type { RawDiscoveredPainPoint, SourceConfig } from '../types.js';

const logger = createLogger('discovery:discourse');

interface DiscourseSearchResponse {
  posts: DiscourseSearchPost[];
  topics: DiscourseSearchTopic[];
}

interface DiscourseSearchPost {
  id: number;
  topic_id: number;
  blurb: string;
  username: string;
  like_count: number;
  created_at: string;
}

interface DiscourseSearchTopic {
  id: number;
  title: string;
  views: number;
  like_count: number;
  posts_count: number;
  slug: string;
}

interface DiscourseTopicPostsResponse {
  post_stream: {
    posts: DiscourseTopicPost[];
  };
}

interface DiscourseTopicPost {
  id: number;
  cooked: string;
  username: string;
  like_count: number;
  created_at: string;
  post_number: number;
}

const DEFAULT_FORUMS: Array<{ host: string; name: string }> = [
  { host: 'discuss.elastic.co', name: 'Elastic Discuss' },
  { host: 'community.grafana.com', name: 'Grafana Community' },
];

/**
 * Infer relevant Discourse forums based on keywords.
 * Always includes the default observability forums, plus any keyword-matched forums.
 */
export function inferDiscourseForums(keywords: string[]): Array<{ host: string; name: string }> {
  const forums = [...DEFAULT_FORUMS];
  const seen = new Set(forums.map(f => f.host));
  const lowerKeywords = keywords.map(k => k.toLowerCase());

  const keywordForumMap: Array<{ patterns: string[]; host: string; name: string }> = [
    { patterns: ['kubernetes', 'k8s', 'kubectl', 'helm'], host: 'discuss.kubernetes.io', name: 'Kubernetes Forum' },
    { patterns: ['docker', 'container', 'dockerfile'], host: 'forums.docker.com', name: 'Docker Forums' },
    { patterns: ['hashicorp', 'terraform', 'vault', 'consul', 'nomad'], host: 'discuss.hashicorp.com', name: 'HashiCorp Discuss' },
    { patterns: ['circleci'], host: 'discuss.circleci.com', name: 'CircleCI Discuss' },
    { patterns: ['ansible', 'red hat', 'redhat'], host: 'forum.ansible.com', name: 'Ansible Forum' },
    { patterns: ['puppet'], host: 'community.puppet.com', name: 'Puppet Community' },
    { patterns: ['newrelic', 'new relic'], host: 'forum.newrelic.com', name: 'New Relic Forum' },
    { patterns: ['datadog'], host: 'community.datadoghq.com', name: 'Datadog Community' },
    { patterns: ['gitlab'], host: 'forum.gitlab.com', name: 'GitLab Forum' },
    { patterns: ['ray', 'anyscale'], host: 'discuss.ray.io', name: 'Ray Discuss' },
  ];

  for (const mapping of keywordForumMap) {
    if (seen.has(mapping.host)) continue;
    const matched = lowerKeywords.some(kw =>
      mapping.patterns.some(p => kw.includes(p)),
    );
    if (matched) {
      forums.push({ host: mapping.host, name: mapping.name });
      seen.add(mapping.host);
    }
  }

  return forums;
}

/**
 * Strip Discourse HTML from search blurbs and post content.
 * Handles search highlights, blockquotes, code blocks, HTML tags, and entity references.
 */
export function stripDiscourseHtml(html: string): string {
  return html
    // Remove search highlight spans
    .replace(/<span class="search-highlight">([\s\S]*?)<\/span>/g, '$1')
    // Replace blockquotes with bracketed text
    .replace(/<blockquote[^>]*>([\s\S]*?)<\/blockquote>/g, '[quote] $1 [/quote]')
    // Replace code blocks with placeholder
    .replace(/<pre[^>]*><code[^>]*>[\s\S]*?<\/code><\/pre>/g, '[code block]')
    .replace(/<code[^>]*>([\s\S]*?)<\/code>/g, '$1')
    // Replace paragraph and line break tags
    .replace(/<p>/g, '\n\n')
    .replace(/<br\s*\/?>/g, '\n')
    // Extract link text
    .replace(/<a[^>]*>([^<]*)<\/a>/g, '$1')
    // Remove all remaining HTML tags
    .replace(/<[^>]+>/g, '')
    // Decode HTML entities
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#\d+;/g, '')
    // Clean up whitespace
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export async function discoverFromDiscourse(config: SourceConfig): Promise<RawDiscoveredPainPoint[]> {
  const keywords = config.keywords;

  if (keywords.length === 0) {
    logger.warn('No keywords configured for Discourse');
    return [];
  }

  const forums = config.discourseForums && config.discourseForums.length > 0
    ? config.discourseForums
    : inferDiscourseForums(keywords);

  const posts: RawDiscoveredPainPoint[] = [];
  const maxResults = config.maxResults || 25;

  for (const forum of forums) {
    for (const keyword of keywords) {
      try {
        const query = encodeURIComponent(keyword);
        const searchUrl = `https://${forum.host}/search.json?q=${query}`;

        logger.debug('Searching Discourse forum', { host: forum.host, keyword });

        const searchResponse = await fetch(searchUrl, {
          headers: {
            'Accept': 'application/json',
            'User-Agent': 'messaging-engine:discovery:v1.0',
          },
        });

        if (!searchResponse.ok) {
          logger.error('Discourse search API error', {
            status: searchResponse.status,
            host: forum.host,
            keyword,
          });
          continue;
        }

        const searchData = (await searchResponse.json()) as DiscourseSearchResponse;

        if (!searchData.topics || searchData.topics.length === 0) {
          logger.debug('No topics found', { host: forum.host, keyword });
          continue;
        }

        // Build a map of topics for easy lookup
        const topicMap = new Map<number, DiscourseSearchTopic>();
        for (const topic of searchData.topics) {
          topicMap.set(topic.id, topic);
        }

        // Build a map of search posts by topic_id for blurb context
        const postsByTopic = new Map<number, DiscourseSearchPost[]>();
        if (searchData.posts) {
          for (const post of searchData.posts) {
            const existing = postsByTopic.get(post.topic_id) || [];
            existing.push(post);
            postsByTopic.set(post.topic_id, existing);
          }
        }

        // Process topics (cap at 10 per keyword-forum combo to stay under rate limits)
        const topicsToProcess = searchData.topics.slice(0, Math.min(maxResults, 10));

        for (const topic of topicsToProcess) {
          try {
            // Fetch full thread content for richer pain point signals
            const topicUrl = `https://${forum.host}/t/${topic.id}/posts.json`;
            const topicResponse = await fetch(topicUrl, {
              headers: {
                'Accept': 'application/json',
                'User-Agent': 'messaging-engine:discovery:v1.0',
              },
            });

            let fullContent = '';
            let author = '';

            if (topicResponse.ok) {
              const topicData = (await topicResponse.json()) as DiscourseTopicPostsResponse;
              const topicPosts = topicData.post_stream?.posts || [];

              // Use the first post (OP) as the main content and author
              if (topicPosts.length > 0) {
                author = topicPosts[0].username;
                fullContent = topicPosts
                  .slice(0, 5) // First 5 posts for context
                  .map(p => stripDiscourseHtml(p.cooked))
                  .join('\n\n---\n\n');
              }
            }

            // Fall back to search blurb if topic fetch failed
            if (!fullContent) {
              const searchPosts = postsByTopic.get(topic.id);
              if (searchPosts && searchPosts.length > 0) {
                fullContent = searchPosts
                  .map(p => stripDiscourseHtml(p.blurb))
                  .join('\n\n');
                author = searchPosts[0].username;
              }
            }

            if (!fullContent) {
              fullContent = topic.title;
            }
            if (!author) {
              author = 'unknown';
            }

            // Skip posts with too little content to extract meaningful pain points
            if (fullContent.length < 50) {
              logger.debug('Skipping topic with insufficient content', { topicId: topic.id, length: fullContent.length });
              continue;
            }

            const searchPost = postsByTopic.get(topic.id)?.[0];

            posts.push({
              sourceType: 'discourse',
              sourceUrl: `https://${forum.host}/t/${topic.slug}/${topic.id}`,
              sourceId: `discourse-${forum.host}-${topic.id}`,
              title: topic.title,
              content: fullContent,
              author,
              metadata: {
                topicViews: topic.views,
                topicLikes: topic.like_count,
                topicReplies: topic.posts_count - 1,
                postLikes: searchPost?.like_count || 0,
                forumHost: forum.host,
                forumName: forum.name,
              },
              discoveredAt: searchPost?.created_at || new Date().toISOString(),
            });
          } catch (error) {
            logger.error('Failed to fetch Discourse topic', {
              topicId: topic.id,
              host: forum.host,
              error,
            });
          }

          // Rate limiting between topic fetches — stay under Discourse's 12 req/min
          await new Promise(resolve => setTimeout(resolve, 500));
        }

        // Rate limiting between keyword-forum combos
        await new Promise(resolve => setTimeout(resolve, 2000));
      } catch (error) {
        logger.error('Failed to search Discourse forum', { host: forum.host, keyword, error });
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

  logger.info(`Discovered ${deduped.length} Discourse posts (${posts.length - deduped.length} duplicates removed)`);
  return deduped;
}
