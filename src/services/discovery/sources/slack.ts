import { createLogger } from '../../../utils/logger.js';
import type { RawDiscoveredPainPoint, SourceConfig } from '../types.js';

const logger = createLogger('discovery:slack');

// Slack community discovery source
// Fetches messages from public Slack channels via Slack Web API
// Requires SLACK_BOT_TOKEN environment variable

export async function discoverFromSlack(config: SourceConfig): Promise<RawDiscoveredPainPoint[]> {
  const token = process.env.SLACK_BOT_TOKEN;
  if (!token) {
    logger.warn('SLACK_BOT_TOKEN not configured, skipping Slack discovery');
    return [];
  }

  const channels = config.slackChannels || [];
  if (channels.length === 0) {
    logger.warn('No Slack channels configured');
    return [];
  }

  const posts: RawDiscoveredPainPoint[] = [];
  const keywords = config.keywords.map(k => k.toLowerCase());

  for (const channelId of channels) {
    try {
      // Fetch recent messages from channel
      const response = await fetch('https://slack.com/api/conversations.history', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          channel: channelId,
          limit: config.maxResults || 100,
        }),
      });

      const data = await response.json() as any;

      if (!data.ok) {
        logger.error(`Slack API error for channel ${channelId}`, { error: data.error });
        continue;
      }

      for (const message of data.messages || []) {
        if (!message.text) continue;

        const textLower = message.text.toLowerCase();
        const isRelevant = keywords.some(kw => textLower.includes(kw));

        // Also check for pain indicators
        const painIndicators = ['help', 'issue', 'problem', 'struggling', 'frustrated', 'broken', 'how do', 'anyone know', 'stuck', 'error', 'failing'];
        const hasPain = painIndicators.some(ind => textLower.includes(ind));

        if (isRelevant || hasPain) {
          // Fetch thread replies if this message has them
          let threadContent = message.text;
          if (message.reply_count && message.reply_count > 0) {
            try {
              const threadResponse = await fetch('https://slack.com/api/conversations.replies', {
                method: 'POST',
                headers: {
                  'Authorization': `Bearer ${token}`,
                  'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                  channel: channelId,
                  ts: message.ts,
                  limit: 20,
                }),
              });
              const threadData = await threadResponse.json() as any;
              if (threadData.ok && threadData.messages) {
                threadContent = threadData.messages.map((m: any) => m.text).join('\n\n');
              }
            } catch {
              // Use original message if thread fetch fails
            }
          }

          posts.push({
            sourceType: 'slack',
            sourceUrl: `slack://channel/${channelId}/message/${message.ts}`,
            sourceId: message.ts,
            title: message.text.substring(0, 150),
            content: threadContent,
            author: message.user || 'unknown',
            metadata: {
              channelId,
              replyCount: message.reply_count || 0,
              reactions: message.reactions?.map((r: any) => ({ name: r.name, count: r.count })) || [],
              threadTs: message.thread_ts,
            },
            discoveredAt: new Date(parseFloat(message.ts) * 1000).toISOString(),
          });
        }
      }

      // Rate limiting
      await new Promise(resolve => setTimeout(resolve, 1000));
    } catch (error) {
      logger.error(`Failed to fetch Slack channel ${channelId}`, { error });
    }
  }

  logger.info(`Discovered ${posts.length} relevant Slack messages`);
  return posts;
}
