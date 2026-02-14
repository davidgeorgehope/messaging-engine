import { createLogger } from '../../../utils/logger.js';
import { config as appConfig } from '../../../config.js';
import type { RawDiscoveredPainPoint, SourceConfig } from '../types.js';

const logger = createLogger('discovery:github');

interface GitHubIssue {
  id: number;
  number: number;
  title: string;
  body: string | null;
  html_url: string;
  user: {
    login: string;
  };
  labels: Array<{ name: string }>;
  comments: number;
  reactions: {
    total_count: number;
    '+1': number;
    '-1': number;
    confused: number;
  };
  created_at: string;
  state: string;
  repository_url: string;
}

interface GitHubSearchResponse {
  total_count: number;
  items: GitHubIssue[];
}

interface GitHubDiscussion {
  id: string;
  number: number;
  title: string;
  body: string;
  url: string;
  author: { login: string };
  category: { name: string };
  comments: { totalCount: number };
  reactions: { totalCount: number };
  createdAt: string;
}

export async function discoverFromGitHub(config: SourceConfig): Promise<RawDiscoveredPainPoint[]> {
  const token = appConfig.apiKeys.github;
  if (!token) {
    logger.warn('GITHUB_TOKEN not configured, skipping GitHub discovery');
    return [];
  }

  const repositories = config.repositories || [];
  const keywords = config.keywords;
  const maxResults = config.maxResults || 25;

  const posts: RawDiscoveredPainPoint[] = [];

  // Strategy 1: Search issues across repos by keyword
  for (const keyword of keywords) {
    try {
      const repoFilter = repositories.length > 0
        ? repositories.map(r => `repo:${r}`).join(' ')
        : '';
      const query = encodeURIComponent(`${keyword} ${repoFilter} is:issue is:open`);
      const url = `https://api.github.com/search/issues?q=${query}&sort=created&order=desc&per_page=${maxResults}`;

      const response = await fetch(url, {
        headers: {
          'Authorization': `token ${token}`,
          'Accept': 'application/vnd.github.v3+json',
          'User-Agent': 'messaging-engine-discovery',
        },
      });

      if (!response.ok) {
        logger.error(`GitHub API error`, { status: response.status, keyword });
        continue;
      }

      const data = (await response.json()) as GitHubSearchResponse;

      for (const issue of data.items) {
        const body = issue.body || '';

        posts.push({
          sourceType: 'github',
          sourceUrl: issue.html_url,
          sourceId: issue.id.toString(),
          title: issue.title,
          content: body,
          author: issue.user.login,
          metadata: {
            issueNumber: issue.number,
            labels: issue.labels.map(l => l.name),
            comments: issue.comments,
            reactions: issue.reactions.total_count,
            thumbsUp: issue.reactions['+1'],
            confused: issue.reactions.confused,
            state: issue.state,
            repositoryUrl: issue.repository_url,
          },
          discoveredAt: issue.created_at,
        });
      }

      // Rate limiting for GitHub API
      await new Promise(resolve => setTimeout(resolve, 1000));
    } catch (error) {
      logger.error(`Failed to search GitHub issues`, { keyword, error });
    }
  }

  // Strategy 2: Fetch discussions from specific repos using GraphQL
  for (const repo of repositories) {
    try {
      const [owner, name] = repo.split('/');
      if (!owner || !name) continue;

      const graphqlQuery = `
        query($owner: String!, $name: String!, $first: Int!) {
          repository(owner: $owner, name: $name) {
            discussions(first: $first, orderBy: {field: CREATED_AT, direction: DESC}) {
              nodes {
                id
                number
                title
                body
                url
                author { login }
                category { name }
                comments { totalCount }
                reactions { totalCount }
                createdAt
              }
            }
          }
        }
      `;

      const response = await fetch('https://api.github.com/graphql', {
        method: 'POST',
        headers: {
          'Authorization': `bearer ${token}`,
          'Content-Type': 'application/json',
          'User-Agent': 'messaging-engine-discovery',
        },
        body: JSON.stringify({
          query: graphqlQuery,
          variables: { owner, name, first: maxResults },
        }),
      });

      if (!response.ok) {
        logger.debug(`GitHub GraphQL error for ${repo} — discussions may not be enabled`, { status: response.status });
        continue;
      }

      const data = await response.json() as any;
      const discussions: GitHubDiscussion[] = data?.data?.repository?.discussions?.nodes || [];

      for (const discussion of discussions) {
        // Check if discussion content matches any keyword
        const contentLower = (discussion.title + ' ' + discussion.body).toLowerCase();
        const isRelevant = keywords.some(kw => contentLower.includes(kw.toLowerCase()));

        if (!isRelevant) continue;

        posts.push({
          sourceType: 'github',
          sourceUrl: discussion.url,
          sourceId: discussion.id,
          title: discussion.title,
          content: discussion.body,
          author: discussion.author?.login || 'unknown',
          metadata: {
            discussionNumber: discussion.number,
            category: discussion.category?.name || 'uncategorized',
            comments: discussion.comments.totalCount,
            reactions: discussion.reactions.totalCount,
            repository: repo,
            isDiscussion: true,
          },
          discoveredAt: discussion.createdAt,
        });
      }

      // Rate limiting
      await new Promise(resolve => setTimeout(resolve, 500));
    } catch (error) {
      logger.error(`Failed to fetch GitHub discussions`, { repo, error });
    }
  }

  // Deduplicate by sourceId
  const seen = new Set<string>();
  const deduped = posts.filter(post => {
    if (seen.has(post.sourceId)) return false;
    seen.add(post.sourceId);
    return true;
  });

  logger.info(`Discovered ${deduped.length} GitHub items (${posts.length - deduped.length} duplicates removed)`);
  return deduped;
}
