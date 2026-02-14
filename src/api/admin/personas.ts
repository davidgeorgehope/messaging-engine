import { Hono } from 'hono';
import { getDatabase } from '../../db/index.js';
import { personaCritics } from '../../db/schema.js';
import { eq } from 'drizzle-orm';
import { generateId } from '../../utils/hash.js';

const app = new Hono();

app.get('/', async (c) => {
  const db = getDatabase();
  return c.json(await db.query.personaCritics.findMany());
});

app.get('/:id', async (c) => {
  const db = getDatabase();
  const item = await db.query.personaCritics.findFirst({ where: eq(personaCritics.id, c.req.param('id')) });
  if (!item) return c.json({ error: 'Not found' }, 404);
  return c.json(item);
});

app.post('/', async (c) => {
  const db = getDatabase();
  const body = await c.req.json();
  const id = generateId();
  await db.insert(personaCritics).values({
    id, name: body.name, description: body.description || '',
    promptTemplate: body.promptTemplate, isActive: true,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  });
  return c.json({ id }, 201);
});

app.put('/:id', async (c) => {
  const db = getDatabase();
  const body = await c.req.json();
  await db.update(personaCritics).set({ ...body, updatedAt: new Date().toISOString() })
    .where(eq(personaCritics.id, c.req.param('id')));
  return c.json({ success: true });
});

export default app;
