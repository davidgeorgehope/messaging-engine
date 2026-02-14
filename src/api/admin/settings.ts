import { Hono } from 'hono';
import { getDatabase } from '../../db/index.js';
import { settings } from '../../db/schema.js';
import { eq, and, isNull } from 'drizzle-orm';
import { generateId } from '../../utils/hash.js';

const app = new Hono();

app.get('/', async (c) => {
  const db = getDatabase();
  const items = await db.query.settings.findMany({ where: isNull(settings.priorityId) });
  return c.json(items);
});

app.put('/:key', async (c) => {
  const db = getDatabase();
  const body = await c.req.json();
  const key = c.req.param('key');
  const existing = await db.query.settings.findFirst({
    where: and(eq(settings.key, key), isNull(settings.priorityId)),
  });
  if (existing) {
    await db.update(settings).set({ value: body.value, updatedAt: new Date().toISOString() })
      .where(eq(settings.id, existing.id));
  } else {
    await db.insert(settings).values({
      id: generateId(), key, value: body.value,
      description: body.description || '', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    });
  }
  return c.json({ success: true });
});

export default app;
