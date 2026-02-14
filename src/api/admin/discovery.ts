import { Hono } from 'hono';
import { getDatabase } from '../../db/index.js';
import { discoveredPainPoints, discoverySchedules } from '../../db/schema.js';
import { eq, desc } from 'drizzle-orm';
import { generateId } from '../../utils/hash.js';

const app = new Hono();

// List pain points with pagination
app.get('/pain-points', async (c) => {
  const db = getDatabase();
  const status = c.req.query('status');
  const limit = parseInt(c.req.query('limit') || '50');
  const offset = parseInt(c.req.query('offset') || '0');

  let query = db.query.discoveredPainPoints.findMany({
    orderBy: [desc(discoveredPainPoints.painScore)],
    limit,
    offset,
    ...(status ? { where: eq(discoveredPainPoints.status, status) } : {}),
  });

  const items = await query;
  return c.json(items);
});

// Get single pain point
app.get('/pain-points/:id', async (c) => {
  const db = getDatabase();
  const item = await db.query.discoveredPainPoints.findFirst({
    where: eq(discoveredPainPoints.id, c.req.param('id')),
  });
  if (!item) return c.json({ error: 'Not found' }, 404);
  return c.json(item);
});

// Approve pain point for generation
app.post('/pain-points/:id/approve', async (c) => {
  const db = getDatabase();
  await db.update(discoveredPainPoints).set({
    status: 'queued',
    updatedAt: new Date().toISOString(),
  }).where(eq(discoveredPainPoints.id, c.req.param('id')));
  return c.json({ success: true });
});

// Reject pain point
app.post('/pain-points/:id/reject', async (c) => {
  const db = getDatabase();
  const body = await c.req.json();
  await db.update(discoveredPainPoints).set({
    status: 'rejected',
    rejectionReason: body.reason || '',
    updatedAt: new Date().toISOString(),
  }).where(eq(discoveredPainPoints.id, c.req.param('id')));
  return c.json({ success: true });
});

// Schedule CRUD
app.get('/schedules', async (c) => {
  const db = getDatabase();
  const items = await db.query.discoverySchedules.findMany();
  return c.json(items);
});

app.post('/schedules', async (c) => {
  const db = getDatabase();
  const body = await c.req.json();
  const id = generateId();
  await db.insert(discoverySchedules).values({
    id,
    priorityId: body.priorityId,
    sourceType: body.sourceType,
    config: JSON.stringify(body.config || {}),
    isActive: true,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
  return c.json({ id }, 201);
});

// Manual discovery trigger
app.post('/trigger', async (c) => {
  const { triggerDiscovery } = await import('../../jobs/scheduler.js');
  await triggerDiscovery();
  return c.json({ success: true, message: 'Discovery triggered' });
});

export default app;
