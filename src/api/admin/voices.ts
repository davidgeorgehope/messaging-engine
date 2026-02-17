import { Hono } from 'hono';
import { getDatabase } from '../../db/index.js';
import { voiceProfiles } from '../../db/schema.js';
import { eq } from 'drizzle-orm';
import { generateId, slugify } from '../../utils/hash.js';

const app = new Hono();

app.get('/', async (c) => {
  const db = getDatabase();
  const items = await db.query.voiceProfiles.findMany();
  return c.json(items);
});

app.get('/:id', async (c) => {
  const db = getDatabase();
  const item = await db.query.voiceProfiles.findFirst({
    where: eq(voiceProfiles.id, c.req.param('id')),
  });
  if (!item) return c.json({ error: 'Not found' }, 404);
  return c.json(item);
});

app.post('/', async (c) => {
  const db = getDatabase();
  const body = await c.req.json();
  const id = generateId();
  await db.insert(voiceProfiles).values({
    id,
    name: body.name,
    slug: slugify(body.name),
    description: body.description || '',
    voiceGuide: body.voiceGuide || '',
    scoringThresholds: JSON.stringify(body.scoringThresholds || { slopMax: 5, vendorSpeakMax: 5, authenticityMin: 6, specificityMin: 6, personaMin: 6, narrativeArcMin: 5 }),
    examplePhrases: JSON.stringify(body.examplePhrases || { good: [], bad: [] }),
    isDefault: body.isDefault || false,
    isActive: true,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
  return c.json({ id }, 201);
});

app.put('/:id', async (c) => {
  const db = getDatabase();
  const body = await c.req.json();
  const data: Record<string, any> = { updatedAt: new Date().toISOString() };
  if (body.name) { data.name = body.name; data.slug = slugify(body.name); }
  if (body.description !== undefined) data.description = body.description;
  if (body.voiceGuide !== undefined) data.voiceGuide = body.voiceGuide;
  if (body.scoringThresholds) data.scoringThresholds = JSON.stringify(body.scoringThresholds);
  if (body.examplePhrases) data.examplePhrases = JSON.stringify(body.examplePhrases);
  if (body.isDefault !== undefined) data.isDefault = body.isDefault;
  if (body.isActive !== undefined) data.isActive = body.isActive;

  await db.update(voiceProfiles).set(data).where(eq(voiceProfiles.id, c.req.param('id')));
  return c.json({ success: true });
});

export default app;
