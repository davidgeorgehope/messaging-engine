import { eq, and, gte } from 'drizzle-orm';
import { getDatabase } from '../../db/index.js';
import { discoverySchedules, discoveredPainPoints, messagingPriorities } from '../../db/schema.js';
import { createLogger } from '../../utils/logger.js';
import { generateId } from '../../utils/hash.js';
import { config } from '../../config.js';
import { scorePainPoints } from './scorer.js';
import { discoverFromReddit } from './sources/reddit.js';
import { discoverFromStackOverflow } from './sources/stackoverflow.js';
import { discoverFromHackerNews } from './sources/hackernews.js';
import { discoverFromGitHub } from './sources/github.js';
import { discoverFromGroundedSearch } from './sources/grounded-search.js';
import { discoverFromSlack } from './sources/slack.js';
import { discoverFromDiscourse } from './sources/discourse.js';
import type { SourceType, SourceConfig, RawDiscoveredPainPoint, DiscoveryResult } from './types.js';

const logger = createLogger('discovery');

// Map source types to their discovery functions
const sourceFunctions: Record<SourceType, (config: SourceConfig) => Promise<RawDiscoveredPainPoint[]>> = {
  reddit: discoverFromReddit,
  stackoverflow: discoverFromStackOverflow,
  hackernews: discoverFromHackerNews,
  github: discoverFromGitHub,
  grounded_search: discoverFromGroundedSearch,
  slack: discoverFromSlack,
  discourse: discoverFromDiscourse,
};

/**
 * Run discovery for all active schedules.
 * This is the main entry point called by the cron job.
 */
export async function runDiscovery(): Promise<DiscoveryResult[]> {
  const db = getDatabase();
  const results: DiscoveryResult[] = [];

  logger.info('Starting discovery run');
  const endTimer = logger.time('discovery-run');

  try {
    // Load all active schedules with their priority context
    const schedules = await db
      .select()
      .from(discoverySchedules)
      .where(eq(discoverySchedules.isActive, true));

    if (schedules.length === 0) {
      logger.warn('No active discovery schedules found');
      return [];
    }

    logger.info(`Found ${schedules.length} active schedules`);

    for (const schedule of schedules) {
      try {
        const result = await runSchedule(schedule);
        results.push(result);
      } catch (error) {
        logger.error('Schedule failed', { scheduleId: schedule.id, error });
        results.push({
          scheduleId: schedule.id,
          sourceType: schedule.sourceType as SourceType,
          stats: { discovered: 0, scored: 0, stored: 0, duplicates: 0, belowThreshold: 0 },
          posts: [],
        });
      }
    }

    const totalStored = results.reduce((sum, r) => sum + r.stats.stored, 0);
    const totalDiscovered = results.reduce((sum, r) => sum + r.stats.discovered, 0);
    logger.info('Discovery run completed', { totalDiscovered, totalStored, schedules: results.length });
  } finally {
    endTimer();
  }

  return results;
}

/**
 * Run discovery for a single schedule.
 */
export async function runSchedule(
  schedule: typeof discoverySchedules.$inferSelect,
): Promise<DiscoveryResult> {
  const db = getDatabase();
  const scheduleId = schedule.id;
  const sourceType = schedule.sourceType as SourceType;
  const sourceConfig = JSON.parse(schedule.config) as SourceConfig;

  logger.info('Running schedule', { scheduleId, sourceType, priorityId: schedule.priorityId });

  // Load priority for keyword context
  const [priority] = await db
    .select()
    .from(messagingPriorities)
    .where(eq(messagingPriorities.id, schedule.priorityId));

  if (!priority) {
    throw new Error(`Priority ${schedule.priorityId} not found for schedule ${scheduleId}`);
  }

  // Merge priority keywords with schedule config keywords
  const priorityKeywords = JSON.parse(priority.keywords) as string[];
  const mergedConfig: SourceConfig = {
    ...sourceConfig,
    keywords: [...new Set([...sourceConfig.keywords, ...priorityKeywords])],
  };

  // Step 1: Discover raw posts from source
  const discoverFn = sourceFunctions[sourceType];
  if (!discoverFn) {
    throw new Error(`Unknown source type: ${sourceType}`);
  }

  const rawPosts = await discoverFn(mergedConfig);
  logger.info(`Discovered ${rawPosts.length} raw posts`, { scheduleId, sourceType });

  if (rawPosts.length === 0) {
    await updateScheduleTimestamp(scheduleId);
    return {
      scheduleId,
      sourceType,
      stats: { discovered: 0, scored: 0, stored: 0, duplicates: 0, belowThreshold: 0 },
      posts: [],
    };
  }

  // Step 2: Limit to maxPostsPerRun
  const maxPosts = config.discovery.maxPostsPerRun;
  const limitedPosts = rawPosts.slice(0, maxPosts);

  // Step 3: Score all posts
  const scoredPosts = await scorePainPoints(limitedPosts);
  logger.info(`Scored ${scoredPosts.length} posts`, { scheduleId });

  // Step 4: Filter below threshold
  const minScore = config.discovery.minPainScore * 100; // Convert 0-1 to 0-100 scale
  const aboveThreshold = scoredPosts.filter(p => p.painScore >= minScore);
  const belowThreshold = scoredPosts.length - aboveThreshold.length;
  logger.info(`${aboveThreshold.length} above threshold, ${belowThreshold} below`, { scheduleId, minScore });

  // Step 5: Deduplicate against existing content hashes
  const deduplicationWindow = new Date();
  deduplicationWindow.setDate(deduplicationWindow.getDate() - config.discovery.deduplicationWindowDays);

  const existingHashes = new Set<string>();
  const existing = await db
    .select({ contentHash: discoveredPainPoints.contentHash })
    .from(discoveredPainPoints)
    .where(
      and(
        eq(discoveredPainPoints.priorityId, schedule.priorityId),
        gte(discoveredPainPoints.createdAt, deduplicationWindow.toISOString()),
      ),
    );

  for (const row of existing) {
    existingHashes.add(row.contentHash);
  }

  const newPosts = aboveThreshold.filter(p => !existingHashes.has(p.contentHash));
  const duplicates = aboveThreshold.length - newPosts.length;
  logger.info(`${newPosts.length} new posts, ${duplicates} duplicates`, { scheduleId });

  // Step 6: Store new pain points
  let stored = 0;
  for (const post of newPosts) {
    try {
      await db.insert(discoveredPainPoints).values({
        id: generateId(),
        priorityId: schedule.priorityId,
        scheduleId: schedule.id,
        sourceType: post.sourceType,
        sourceUrl: post.sourceUrl,
        sourceId: post.sourceId,
        title: post.title,
        content: post.content,
        author: post.author,
        authorLevel: post.authorLevel,
        metadata: JSON.stringify(post.metadata),
        painScore: post.painScore,
        painAnalysis: JSON.stringify(post.painAnalysis),
        practitionerQuotes: JSON.stringify(post.practitionerQuotes),
        status: 'pending',
        contentHash: post.contentHash,
        discoveredAt: post.discoveredAt,
      });
      stored++;
    } catch (error) {
      logger.error('Failed to store pain point', { title: post.title, error });
    }
  }

  logger.info(`Stored ${stored} new pain points`, { scheduleId });

  // Update schedule last run timestamp
  await updateScheduleTimestamp(scheduleId);

  return {
    scheduleId,
    sourceType,
    stats: {
      discovered: rawPosts.length,
      scored: scoredPosts.length,
      stored,
      duplicates,
      belowThreshold,
    },
    posts: newPosts,
  };
}

/**
 * Run discovery for a single priority across all its active schedules.
 */
export async function runDiscoveryForPriority(priorityId: string): Promise<DiscoveryResult[]> {
  const db = getDatabase();
  const results: DiscoveryResult[] = [];

  const schedules = await db
    .select()
    .from(discoverySchedules)
    .where(
      and(
        eq(discoverySchedules.priorityId, priorityId),
        eq(discoverySchedules.isActive, true),
      ),
    );

  if (schedules.length === 0) {
    logger.warn('No active schedules for priority', { priorityId });
    return [];
  }

  logger.info(`Running discovery for priority ${priorityId} (${schedules.length} schedules)`);

  for (const schedule of schedules) {
    try {
      const result = await runSchedule(schedule);
      results.push(result);
    } catch (error) {
      logger.error('Schedule failed', { scheduleId: schedule.id, error });
    }
  }

  return results;
}

async function updateScheduleTimestamp(scheduleId: string): Promise<void> {
  const db = getDatabase();
  const now = new Date().toISOString();

  await db
    .update(discoverySchedules)
    .set({
      lastRunAt: now,
      updatedAt: now,
    })
    .where(eq(discoverySchedules.id, scheduleId));
}
