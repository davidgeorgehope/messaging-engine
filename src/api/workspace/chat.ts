import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { eq, and } from 'drizzle-orm';
import { getDatabase } from '../../db/index.js';
import { sessions, sessionMessages, sessionVersions } from '../../db/schema.js';
import { generateId } from '../../utils/hash.js';
import { createLogger } from '../../utils/logger.js';
import { assembleChatContext } from '../../services/workspace/chat-context.js';
import { scoreContent, checkQualityGates, DEFAULT_THRESHOLDS } from '../../services/quality/score-content.js';
import { config, getModelForTask } from '../../config.js';
import { desc } from 'drizzle-orm';

const logger = createLogger('api:workspace:chat');

type Variables = { user: { id: string | null; username: string; displayName: string; role: string } };
const app = new Hono<{ Variables: Variables }>();

async function verifySessionAccess(sessionId: string, user: { id: string | null; role: string }) {
  const db = getDatabase();
  const session = await db.query.sessions.findFirst({ where: eq(sessions.id, sessionId) });
  if (!session) return null;
  if (user.id && user.id !== 'admin-env' && user.role !== 'admin' && session.userId !== user.id) return null;
  return session;
}

// POST /sessions/:id/chat — SSE streaming chat
app.post('/:id/chat', async (c) => {
  const sessionId = c.req.param('id');
  const user = c.get('user');

  const session = await verifySessionAccess(sessionId, user);
  if (!session) return c.json({ error: 'Session not found' }, 404);

  let body: { message?: string; assetType?: string };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }

  const { message, assetType } = body;
  if (!message || typeof message !== 'string') {
    return c.json({ error: 'message string is required' }, 400);
  }

  const db = getDatabase();

  // Save user message
  const userMsgId = generateId();
  await db.insert(sessionMessages).values({
    id: userMsgId,
    sessionId,
    role: 'user',
    content: message,
    assetType: assetType || null,
    metadata: JSON.stringify({}),
    createdAt: new Date().toISOString(),
  });

  // Assemble context
  const context = await assembleChatContext(sessionId, assetType);

  // Build conversation history for Gemini (system prompt goes in first user turn)
  const chatHistory = context.messages.map(m => ({
    role: m.role === 'assistant' ? 'model' as const : 'user' as const,
    parts: [{ text: m.content }],
  }));

  // Combine system prompt with user message
  const userPrompt = context.systemPrompt
    ? `${context.systemPrompt}\n\n${message}`
    : message;

  return streamSSE(c, async (stream) => {
    try {
      const { GoogleGenAI } = await import('@google/genai');
      const client = new GoogleGenAI({ apiKey: config.apiKeys.googleAi });
      const model = getModelForTask('pro');

      let fullText = '';

      const response = await client.models.generateContentStream({
        model,
        contents: [
          ...chatHistory,
          { role: 'user', parts: [{ text: userPrompt }] },
        ],
        config: {
          temperature: 0.7,
        },
      });

      for await (const chunk of response) {
        const text = chunk.text ?? '';
        if (text) {
          fullText += text;
          await stream.writeSSE({
            data: JSON.stringify({ type: 'delta', text }),
          });
        }
      }

      // Save assistant message
      const assistantMsgId = generateId();
      await db.insert(sessionMessages).values({
        id: assistantMsgId,
        sessionId,
        role: 'assistant',
        content: fullText,
        assetType: assetType || null,
        metadata: JSON.stringify({
          model,
          timestamp: new Date().toISOString(),
        }),
        createdAt: new Date().toISOString(),
      });

      await stream.writeSSE({
        data: JSON.stringify({ type: 'done', messageId: assistantMsgId, fullText }),
      });
    } catch (error) {
      logger.error('Chat streaming failed', {
        sessionId,
        error: error instanceof Error ? error.message : String(error),
      });
      await stream.writeSSE({
        data: JSON.stringify({ type: 'error', message: error instanceof Error ? error.message : 'Chat failed' }),
      });
    }
  });
});

// POST /sessions/:id/chat/:messageId/accept — accept proposed content
app.post('/:id/chat/:messageId/accept', async (c) => {
  const sessionId = c.req.param('id');
  const messageId = c.req.param('messageId');
  const user = c.get('user');

  const session = await verifySessionAccess(sessionId, user);
  if (!session) return c.json({ error: 'Session not found' }, 404);

  const db = getDatabase();
  const msg = await db.query.sessionMessages.findFirst({
    where: eq(sessionMessages.id, messageId),
  });

  if (!msg || msg.sessionId !== sessionId || msg.role !== 'assistant') {
    return c.json({ error: 'Message not found or not an assistant message' }, 404);
  }

  // Extract proposed content from ---PROPOSED--- delimiters
  const match = msg.content.match(/---PROPOSED---([\s\S]*?)---PROPOSED---/);
  const content = match ? match[1].trim() : msg.content.trim();

  const assetType = msg.assetType;
  if (!assetType) {
    return c.json({ error: 'No asset type associated with this message' }, 400);
  }

  // Get next version number
  const existing = await db.query.sessionVersions.findMany({
    where: and(
      eq(sessionVersions.sessionId, sessionId),
      eq(sessionVersions.assetType, assetType),
    ),
    orderBy: [desc(sessionVersions.versionNumber)],
    limit: 1,
  });

  const versionNumber = (existing[0]?.versionNumber ?? 0) + 1;

  // Deactivate current active
  const activeVersions = await db.query.sessionVersions.findMany({
    where: and(
      eq(sessionVersions.sessionId, sessionId),
      eq(sessionVersions.assetType, assetType),
      eq(sessionVersions.isActive, true),
    ),
  });
  for (const v of activeVersions) {
    await db.update(sessionVersions).set({ isActive: false }).where(eq(sessionVersions.id, v.id)).run();
  }

  // Score the accepted content
  const scores = await scoreContent(content);
  const passesGates = checkQualityGates(scores, DEFAULT_THRESHOLDS);

  const versionId = generateId();
  await db.insert(sessionVersions).values({
    id: versionId,
    sessionId,
    assetType,
    versionNumber,
    content,
    source: 'chat',
    sourceDetail: JSON.stringify({ messageId, acceptedAt: new Date().toISOString() }),
    slopScore: scores.slopScore,
    vendorSpeakScore: scores.vendorSpeakScore,
    authenticityScore: scores.authenticityScore,
    specificityScore: scores.specificityScore,
    personaAvgScore: scores.personaAvgScore,
    passesGates,
    isActive: true,
    createdAt: new Date().toISOString(),
  });

  // Update message with version reference
  await db.update(sessionMessages)
    .set({ versionCreated: versionId })
    .where(eq(sessionMessages.id, messageId))
    .run();

  const version = await db.query.sessionVersions.findFirst({
    where: eq(sessionVersions.id, versionId),
  });

  return c.json({ version });
});

// GET /sessions/:id/messages — list chat history
app.get('/:id/messages', async (c) => {
  const sessionId = c.req.param('id');
  const user = c.get('user');

  const session = await verifySessionAccess(sessionId, user);
  if (!session) return c.json({ error: 'Session not found' }, 404);

  const db = getDatabase();

  const messages = await db.query.sessionMessages.findMany({
    where: eq(sessionMessages.sessionId, sessionId),
    orderBy: [sessionMessages.createdAt],
  });

  return c.json({ data: messages });
});

export default app;
