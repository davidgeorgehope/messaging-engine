import { eq } from 'drizzle-orm';
import { getDatabase } from '../../db/index.js';
import { actionJobs } from '../../db/schema.js';
import { generateId } from '../../utils/hash.js';
import { createLogger } from '../../utils/logger.js';

const logger = createLogger('workspace:action-runner');

export function updateActionProgress(jobId: string, fields: { currentStep?: string; progress?: number }) {
  const db = getDatabase();
  db.update(actionJobs)
    .set({ ...fields, updatedAt: new Date().toISOString() })
    .where(eq(actionJobs.id, jobId))
    .run();
}

export function runActionInBackground(
  sessionId: string,
  assetType: string,
  actionName: string,
  actionFn: () => Promise<any>,
): string {
  const db = getDatabase();
  const jobId = generateId();
  const now = new Date().toISOString();

  db.insert(actionJobs).values({
    id: jobId,
    sessionId,
    assetType,
    actionName,
    status: 'running',
    currentStep: 'Starting...',
    progress: 0,
    createdAt: now,
    updatedAt: now,
  }).run();

  // Fire and forget — do not await
  actionFn()
    .then((result) => {
      db.update(actionJobs)
        .set({
          status: 'completed',
          currentStep: 'Done',
          progress: 100,
          result: JSON.stringify(result),
          updatedAt: new Date().toISOString(),
        })
        .where(eq(actionJobs.id, jobId))
        .run();
      logger.info('Action job completed', { jobId, actionName });
    })
    .catch((err) => {
      const message = err instanceof Error ? err.message : String(err);
      db.update(actionJobs)
        .set({
          status: 'failed',
          errorMessage: message,
          updatedAt: new Date().toISOString(),
        })
        .where(eq(actionJobs.id, jobId))
        .run();
      logger.error('Action job failed', { jobId, actionName, error: message });
    });

  return jobId;
}

export function getActionJobStatus(jobId: string) {
  const db = getDatabase();
  const job = db.select().from(actionJobs).where(eq(actionJobs.id, jobId)).get();
  if (!job) return null;

  return {
    id: job.id,
    sessionId: job.sessionId,
    assetType: job.assetType,
    actionName: job.actionName,
    status: job.status,
    currentStep: job.currentStep,
    progress: job.progress,
    result: job.status === 'completed' && job.result ? JSON.parse(job.result) : null,
    errorMessage: job.errorMessage,
  };
}
