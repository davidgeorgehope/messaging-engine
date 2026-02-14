import { Hono } from 'hono';
import { getDatabase } from '../../db/index.js';
import { generationJobs } from '../../db/schema.js';
import { eq, desc } from 'drizzle-orm';
import { createGenerationJob, runGenerationJob } from '../../services/generation/orchestrator.js';

const app = new Hono();

app.get('/', async (c) => {
  const db = getDatabase();
  const limit = parseInt(c.req.query('limit') || '50');
  const items = await db.query.generationJobs.findMany({
    orderBy: [desc(generationJobs.createdAt)],
    limit,
  });
  return c.json(items);
});

app.get('/:id', async (c) => {
  const db = getDatabase();
  const item = await db.query.generationJobs.findFirst({
    where: eq(generationJobs.id, c.req.param('id')),
  });
  if (!item) return c.json({ error: 'Not found' }, 404);
  return c.json(item);
});

// Queue a new generation job
app.post('/queue', async (c) => {
  const body = await c.req.json();
  const jobId = await createGenerationJob(body.painPointId, body.assetTypes);
  return c.json({ jobId }, 201);
});

// Retry a failed job
app.post('/:id/retry', async (c) => {
  const db = getDatabase();
  await db.update(generationJobs).set({
    status: 'pending',
    errorMessage: null,
    errorStack: null,
    updatedAt: new Date().toISOString(),
  }).where(eq(generationJobs.id, c.req.param('id')));
  return c.json({ success: true });
});

export default app;
