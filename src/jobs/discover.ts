import { getDatabase } from '../db/index.js';
import { discoverySchedules } from '../db/schema.js';
import { eq, and, or, lte, isNull } from 'drizzle-orm';
import { createLogger } from '../utils/logger.js';
import { runSchedule } from '../services/discovery/index.js';
import type { DiscoveryResult } from '../services/discovery/types.js';

const logger = createLogger('jobs:discover');

export async function runDiscoveryJob(): Promise<{
  schedulesProcessed: number;
  totalDiscovered: number;
  results: DiscoveryResult[];
  errors: Array<{ scheduleId: string; error: string }>;
}> {
  const db = getDatabase();
  logger.info('Starting discovery job');
  const now = new Date().toISOString();

  const dueSchedules = await db.query.discoverySchedules.findMany({
    where: and(
      eq(discoverySchedules.isActive, true),
      or(isNull(discoverySchedules.nextRunAt), lte(discoverySchedules.nextRunAt, now))
    ),
  });

  logger.info(`Found ${dueSchedules.length} schedules due`);

  const results: DiscoveryResult[] = [];
  const errors: Array<{ scheduleId: string; error: string }> = [];
  let totalDiscovered = 0;

  for (const schedule of dueSchedules) {
    try {
      const result = await runSchedule(schedule);
      results.push(result);
      totalDiscovered += result.posts.length;

      const nextRun = new Date();
      nextRun.setHours(nextRun.getHours() + 4);
      await db.update(discoverySchedules).set({
        nextRunAt: nextRun.toISOString(),
        lastRunAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }).where(eq(discoverySchedules.id, schedule.id));
    } catch (error) {
      errors.push({ scheduleId: schedule.id, error: error instanceof Error ? error.message : 'Unknown' });
      logger.error(`Discovery failed for schedule ${schedule.id}`, { error });
    }
    await new Promise(resolve => setTimeout(resolve, 2000));
  }

  logger.info('Discovery job complete', { processed: dueSchedules.length, discovered: totalDiscovered, errors: errors.length });
  return { schedulesProcessed: dueSchedules.length, totalDiscovered, results, errors };
}
