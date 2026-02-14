import { getDatabase } from '../db/index.js';
import { generationJobs, discoveredPainPoints } from '../db/schema.js';
import { eq, desc } from 'drizzle-orm';
import { createLogger } from '../utils/logger.js';
import { config } from '../config.js';
import { runGenerationJob, createGenerationJob } from '../services/generation/orchestrator.js';

const logger = createLogger('jobs:generate');

const runningJobs = new Set<string>();

export async function runGenerationProcessor(): Promise<{
  jobsStarted: number;
  jobsCompleted: number;
  jobsFailed: number;
}> {
  const db = getDatabase();
  logger.info('Starting generation processor');

  const result = { jobsStarted: 0, jobsCompleted: 0, jobsFailed: 0 };

  const pendingJobs = await db.query.generationJobs.findMany({
    where: eq(generationJobs.status, 'pending'),
    orderBy: [desc(generationJobs.createdAt)],
    limit: config.generation.maxConcurrentJobs,
  });

  const jobsToProcess = pendingJobs.filter(job => !runningJobs.has(job.id));
  const availableSlots = config.generation.maxConcurrentJobs - runningJobs.size;
  const jobsToStart = jobsToProcess.slice(0, availableSlots);

  logger.info(`Found ${pendingJobs.length} pending jobs, starting ${jobsToStart.length}`);

  const jobPromises = jobsToStart.map(async (job) => {
    runningJobs.add(job.id);
    result.jobsStarted++;
    try {
      await runGenerationJob(job.id);
      result.jobsCompleted++;
    } catch (error) {
      result.jobsFailed++;
      logger.error(`Job ${job.id} failed`, { error });
    } finally {
      runningJobs.delete(job.id);
    }
  });

  await Promise.allSettled(jobPromises);
  logger.info('Generation processor complete', result);
  return result;
}
