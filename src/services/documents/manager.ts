// Product document management service
// Handles upload, storage, and retrieval of product context documents

import { getDatabase } from '../../db/index.js';
import { productDocuments } from '../../db/schema.js';
import { eq, and } from 'drizzle-orm';
import { generateId } from '../../utils/hash.js';
import { createLogger } from '../../utils/logger.js';

const logger = createLogger('documents:manager');

export type DocumentType = 'launch_brief' | 'prd' | 'feature_spec' | 'release_notes' | 'messaging_doc';

export async function uploadDocument(params: {
  name: string;
  description?: string;
  content: string;
  documentType: DocumentType;
  tags?: string[];
}): Promise<string> {
  const db = getDatabase();
  const id = generateId();

  await db.insert(productDocuments).values({
    id,
    name: params.name,
    description: params.description || '',
    content: params.content,
    documentType: params.documentType,
    tags: JSON.stringify(params.tags || []),
    isActive: true,
    uploadedAt: new Date().toISOString(),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });

  logger.info('Document uploaded', { id, name: params.name, type: params.documentType });
  return id;
}

export async function getActiveDocuments(): Promise<Array<{
  id: string;
  name: string;
  content: string;
  documentType: string;
  tags: string[];
}>> {
  const db = getDatabase();
  const docs = await db.query.productDocuments.findMany({
    where: eq(productDocuments.isActive, true),
  });

  return docs.map(d => ({
    id: d.id,
    name: d.name,
    content: d.content,
    documentType: d.documentType,
    tags: JSON.parse(d.tags || '[]'),
  }));
}

export async function getDocumentById(id: string) {
  const db = getDatabase();
  return db.query.productDocuments.findFirst({
    where: eq(productDocuments.id, id),
  });
}

export async function updateDocument(id: string, updates: Partial<{
  name: string;
  description: string;
  content: string;
  documentType: DocumentType;
  tags: string[];
  isActive: boolean;
}>) {
  const db = getDatabase();
  const data: Record<string, any> = { updatedAt: new Date().toISOString() };

  if (updates.name !== undefined) data.name = updates.name;
  if (updates.description !== undefined) data.description = updates.description;
  if (updates.content !== undefined) data.content = updates.content;
  if (updates.documentType !== undefined) data.documentType = updates.documentType;
  if (updates.tags !== undefined) data.tags = JSON.stringify(updates.tags);
  if (updates.isActive !== undefined) data.isActive = updates.isActive;

  await db.update(productDocuments).set(data).where(eq(productDocuments.id, id));
  logger.info('Document updated', { id });
}

export async function deleteDocument(id: string) {
  const db = getDatabase();
  await db.update(productDocuments)
    .set({ isActive: false, updatedAt: new Date().toISOString() })
    .where(eq(productDocuments.id, id));
  logger.info('Document soft-deleted', { id });
}
