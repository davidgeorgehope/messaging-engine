import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { eq, and } from 'drizzle-orm';
import { getDatabase } from '../../db/index.js';
import { sessionMessages, sessionVersions } from '../../db/schema.js';
import { generateId } from '../../utils/hash.js';
import { createLogger } from '../../utils/logger.js';
import { assembleChatContext } from '../../services/workspace/chat-context.js';
import { config } from '../../config.js';
import { desc } from 'drizzle-orm';

const logger = createLogger('api:workspace:chat');

type Variables = { user: { id: string | null; username: string; displayName: string; role: string } };
const app = new Hono<{ Variables: Variables }>();

// POST /sessions/:id/chat — SSE streaming chat
app.post('/:id/chat', async (c) => {
  const sessionId = c.req.param('id');

  let body: any;
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

  // Build Claude messages
  const claudeMessages = [
    ...context.messages.map(m => ({ role: m.role as 'user' | 'assistant', content: m.content })),
    { role: 'user' as const, content: message },
  ];

  return streamSSE(c, async (stream) => {
    try {
      const Anthropic = (await import('@anthropic-ai/sdk')).default;
      const client = new Anthropic({ apiKey: config.apiKeys.anthropic });

      let fullText = '';

      const response = await client.messages.stream({
        model: config.ai.claude.model,
        max_tokens: 4096,
        system: context.systemPrompt,
        messages: claudeMessages,
      });

      for await (const event of response) {
        if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
          const text = event.delta.text;
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
          model: config.ai.claude.model,
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

  const versionId = generateId();
  await db.insert(sessionVersions).values({
    id: versionId,
    sessionId,
    assetType,
    versionNumber,
    content,
    source: 'chat',
    sourceDetail: JSON.stringify({ messageId, acceptedAt: new Date().toISOString() }),
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
  const db = getDatabase();

  const messages = await db.query.sessionMessages.findMany({
    where: eq(sessionMessages.sessionId, sessionId),
    orderBy: [sessionMessages.createdAt],
  });

  return c.json({ data: messages });
});

export default app;
