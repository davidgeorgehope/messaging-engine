import cron from 'node-cron';
import { createLogger } from '../utils/logger.js';
import { runDiscoveryJob } from './discover.js';
import { runGenerationProcessor } from './generate.js';
import { getCronSettings } from '../services/settings.js';

const logger = createLogger('scheduler');

interface ScheduledTask {
  name: string;
  task: cron.ScheduledTask;
  cronExpression: string;
}

const scheduledTasks: ScheduledTask[] = [];

export async function startScheduler(): Promise<void> {
  const cronSettings = await getCronSettings();
  logger.info('Starting scheduler with cron settings', cronSettings);

  const discoveryTask = cron.schedule(cronSettings.discoveryCron, async () => {
    logger.info('Running scheduled discovery job');
    try { await runDiscoveryJob(); } catch (error) { logger.error('Scheduled discovery failed', { error }); }
  }, { scheduled: true, timezone: 'UTC' });
  scheduledTasks.push({ name: 'discovery', task: discoveryTask, cronExpression: cronSettings.discoveryCron });

  const generationTask = cron.schedule(cronSettings.generationCron, async () => {
    logger.info('Running scheduled generation processor');
    try { await runGenerationProcessor(); } catch (error) { logger.error('Scheduled generation failed', { error }); }
  }, { scheduled: true, timezone: 'UTC' });
  scheduledTasks.push({ name: 'generation', task: generationTask, cronExpression: cronSettings.generationCron });

  logger.info('Scheduler started', { jobs: scheduledTasks.map(t => ({ name: t.name, cron: t.cronExpression })) });
}

export function stopScheduler(): void {
  for (const task of scheduledTasks) { task.task.stop(); }
  scheduledTasks.length = 0;
  logger.info('Scheduler stopped');
}

export async function triggerDiscovery(): Promise<void> {
  logger.info('Manually triggering discovery');
  await runDiscoveryJob();
}

export async function triggerGeneration(): Promise<void> {
  logger.info('Manually triggering generation');
  await runGenerationProcessor();
}
