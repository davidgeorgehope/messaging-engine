import { Hono } from 'hono';
import { getDatabase } from '../../db/index.js';
import { messagingGaps } from '../../db/schema.js';
import { eq, desc } from 'drizzle-orm';
import { generateId } from '../../utils/hash.js';

const app = new Hono();

app.get('/', async (c) => {
  const db = getDatabase();
  const items = await db.query.messagingGaps.findMany({ orderBy: [desc(messagingGaps.frequency)] });
  return c.json(items);
});

app.post('/', async (c) => {
  const db = getDatabase();
  const body = await c.req.json();
  const id = generateId();
  await db.insert(messagingGaps).values({
    id, painPointId: body.painPointId, description: body.description,
    suggestedCapability: body.suggestedCapability || '', frequency: 1, status: 'open',
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  });
  return c.json({ id }, 201);
});

app.put('/:id', async (c) => {
  const db = getDatabase();
  const body = await c.req.json();
  await db.update(messagingGaps).set({ ...body, updatedAt: new Date().toISOString() })
    .where(eq(messagingGaps.id, c.req.param('id')));
  return c.json({ success: true });
});

export default app;
