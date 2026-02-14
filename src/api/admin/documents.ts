import { Hono } from 'hono';
import { uploadDocument, getActiveDocuments, getDocumentById, updateDocument, deleteDocument } from '../../services/documents/manager.js';
import { getDatabase } from '../../db/index.js';
import { productDocuments } from '../../db/schema.js';

const app = new Hono();

app.get('/', async (c) => {
  const docs = await getActiveDocuments();
  return c.json(docs);
});

app.get('/:id', async (c) => {
  const doc = await getDocumentById(c.req.param('id'));
  if (!doc) return c.json({ error: 'Not found' }, 404);
  return c.json(doc);
});

app.post('/', async (c) => {
  const body = await c.req.json();
  const id = await uploadDocument({
    name: body.name,
    description: body.description,
    content: body.content,
    documentType: body.documentType,
    tags: body.tags,
  });
  return c.json({ id }, 201);
});

app.put('/:id', async (c) => {
  const body = await c.req.json();
  await updateDocument(c.req.param('id'), body);
  return c.json({ success: true });
});

app.delete('/:id', async (c) => {
  await deleteDocument(c.req.param('id'));
  return c.json({ success: true });
});

export default app;
