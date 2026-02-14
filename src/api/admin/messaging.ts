import { Hono } from 'hono';
import { getDatabase } from '../../db/index.js';
import { messagingAssets, assetVariants, assetTraceability, personaScores } from '../../db/schema.js';
import { eq, desc } from 'drizzle-orm';

const app = new Hono();

app.get('/', async (c) => {
  const db = getDatabase();
  const status = c.req.query('status');
  const limit = parseInt(c.req.query('limit') || '50');
  const items = await db.query.messagingAssets.findMany({
    orderBy: [desc(messagingAssets.createdAt)],
    limit,
    ...(status ? { where: eq(messagingAssets.status, status) } : {}),
  });
  return c.json(items);
});

app.get('/:id', async (c) => {
  const db = getDatabase();
  const asset = await db.query.messagingAssets.findFirst({
    where: eq(messagingAssets.id, c.req.param('id')),
  });
  if (!asset) return c.json({ error: 'Not found' }, 404);

  // Load variants, traceability, and persona scores
  const [variants, traceability, scores] = await Promise.all([
    db.query.assetVariants.findMany({ where: eq(assetVariants.assetId, asset.id) }),
    db.query.assetTraceability.findMany({ where: eq(assetTraceability.assetId, asset.id) }),
    db.query.personaScores.findMany({ where: eq(personaScores.assetId, asset.id) }),
  ]);

  return c.json({ ...asset, variants, traceability, personaScores: scores });
});

// Approve asset
app.post('/:id/approve', async (c) => {
  const db = getDatabase();
  const body = await c.req.json();
  await db.update(messagingAssets).set({
    status: 'approved',
    approvedAt: new Date().toISOString(),
    approvedBy: body.approvedBy || 'admin',
    reviewNotes: body.notes || '',
    updatedAt: new Date().toISOString(),
  }).where(eq(messagingAssets.id, c.req.param('id')));
  return c.json({ success: true });
});

// Reject asset
app.post('/:id/reject', async (c) => {
  const db = getDatabase();
  const body = await c.req.json();
  await db.update(messagingAssets).set({
    status: 'rejected',
    reviewNotes: body.notes || '',
    updatedAt: new Date().toISOString(),
  }).where(eq(messagingAssets.id, c.req.param('id')));
  return c.json({ success: true });
});

// Select a specific variant
app.post('/variants/:id/select', async (c) => {
  const db = getDatabase();
  const variant = await db.query.assetVariants.findFirst({
    where: eq(assetVariants.id, c.req.param('id')),
  });
  if (!variant) return c.json({ error: 'Not found' }, 404);

  // Deselect all other variants for this asset
  await db.update(assetVariants).set({ isSelected: false })
    .where(eq(assetVariants.assetId, variant.assetId));
  // Select this one
  await db.update(assetVariants).set({ isSelected: true })
    .where(eq(assetVariants.id, c.req.param('id')));

  return c.json({ success: true });
});

export default app;
