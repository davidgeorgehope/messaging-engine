import { Hono } from 'hono';
import { getDatabase } from '../../db/index.js';
import { messagingPriorities } from '../../db/schema.js';
import { eq } from 'drizzle-orm';
import { generateId, slugify } from '../../utils/hash.js';

const app = new Hono();

app.get('/', async (c) => {
  const db = getDatabase();
  const items = await db.query.messagingPriorities.findMany();
  return c.json(items);
});

app.get('/:id', async (c) => {
  const db = getDatabase();
  const item = await db.query.messagingPriorities.findFirst({
    where: eq(messagingPriorities.id, c.req.param('id')),
  });
  if (!item) return c.json({ error: 'Not found' }, 404);
  return c.json(item);
});

app.post('/', async (c) => {
  const db = getDatabase();
  const body = await c.req.json();
  const id = generateId();
  await db.insert(messagingPriorities).values({
    id,
    name: body.name,
    slug: slugify(body.name),
    description: body.description || '',
    keywords: JSON.stringify(body.keywords || []),
    productContext: body.productContext || '',
    isActive: true,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
  return c.json({ id }, 201);
});

app.put('/:id', async (c) => {
  const db = getDatabase();
  const body = await c.req.json();
  await db.update(messagingPriorities).set({
    ...body,
    keywords: body.keywords ? JSON.stringify(body.keywords) : undefined,
    updatedAt: new Date().toISOString(),
  }).where(eq(messagingPriorities.id, c.req.param('id')));
  return c.json({ success: true });
});

app.delete('/:id', async (c) => {
  const db = getDatabase();
  await db.update(messagingPriorities).set({
    isActive: false,
    updatedAt: new Date().toISOString(),
  }).where(eq(messagingPriorities.id, c.req.param('id')));
  return c.json({ success: true });
});

export default app;
