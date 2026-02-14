import { eq, desc, and } from 'drizzle-orm';
import { getDatabase } from '../../db/index.js';
import {
  sessions,
  sessionVersions,
  sessionMessages,
  discoveredPainPoints,
  voiceProfiles,
  productDocuments,
} from '../../db/schema.js';
import { createLogger } from '../../utils/logger.js';

const logger = createLogger('workspace:chat-context');

// Rough token estimate: ~4 chars per token
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

const MAX_CONTEXT_TOKENS = 150000;

export interface ChatContext {
  systemPrompt: string;
  messages: Array<{ role: 'user' | 'assistant'; content: string }>;
}

export async function assembleChatContext(
  sessionId: string,
  targetAssetType?: string,
): Promise<ChatContext> {
  const db = getDatabase();

  const session = await db.query.sessions.findFirst({ where: eq(sessions.id, sessionId) });
  if (!session) throw new Error('Session not found');

  // Build system prompt
  const systemParts: string[] = [];

  systemParts.push(`You are a messaging refinement assistant. You help improve PMM messaging assets — making them more authentic, specific, and practitioner-focused. You never use vendor-speak cliches.`);

  // Voice guide
  if (session.voiceProfileId) {
    const voice = await db.query.voiceProfiles.findFirst({
      where: eq(voiceProfiles.id, session.voiceProfileId),
    });
    if (voice) {
      systemParts.push(`\n## Voice Profile: ${voice.name}\n${voice.voiceGuide}`);
    }
  }

  // Anti-slop rules
  systemParts.push(`\n## Anti-Slop Rules
- Never use: "industry-leading", "best-in-class", "next-generation", "enterprise-grade", "mission-critical", "turnkey", "end-to-end", "single pane of glass", "seamless", "robust", "leverage", "cutting-edge", "game-changer"
- Every claim must be specific and traceable
- Sound like a practitioner peer, not a marketer`);

  // Role description
  systemParts.push(`\n## Your Role
When the user asks you to refine content, provide the improved version. If they ask about the content, explain your thinking.
When proposing new content, wrap it in ---PROPOSED--- delimiters like this:
---PROPOSED---
[your proposed content here]
---PROPOSED---
This allows the user to accept the proposed content as a new version.`);

  // Context: pain point
  if (session.painPointId) {
    const painPoint = await db.query.discoveredPainPoints.findFirst({
      where: eq(discoveredPainPoints.id, session.painPointId),
    });
    if (painPoint) {
      systemParts.push(`\n## Pain Point Context\n### ${painPoint.title}\n${painPoint.content}`);
      const quotes = JSON.parse(painPoint.practitionerQuotes || '[]');
      if (quotes.length > 0) {
        systemParts.push(`### Practitioner Quotes\n${quotes.map((q: string) => `> ${q}`).join('\n')}`);
      }
    }
  }

  // Context: product docs (abbreviated)
  let productContext = '';
  const docIds = session.productDocIds ? JSON.parse(session.productDocIds) : [];
  if (docIds.length > 0) {
    const docs = await Promise.all(
      docIds.map((id: string) => db.query.productDocuments.findFirst({ where: eq(productDocuments.id, id) }))
    );
    productContext = docs.filter(Boolean).map((d: any) => `## ${d.name}\n${d.content.substring(0, 2000)}`).join('\n\n');
  }
  if (session.productContext) {
    productContext += `\n\n## Additional Context\n${session.productContext.substring(0, 3000)}`;
  }
  if (productContext) {
    systemParts.push(`\n## Product Context (abbreviated)\n${productContext}`);
  }

  // Context: active version content
  const versions = await db.query.sessionVersions.findMany({
    where: eq(sessionVersions.sessionId, sessionId),
    orderBy: [desc(sessionVersions.versionNumber)],
  });

  if (targetAssetType) {
    const targetVersions = versions.filter(v => v.assetType === targetAssetType);
    const active = targetVersions.find(v => v.isActive) || targetVersions[0];
    if (active) {
      systemParts.push(`\n## Current Content (${targetAssetType.replace(/_/g, ' ')}, v${active.versionNumber})\n${active.content}`);
    }

    // Summarize other asset types briefly
    const otherTypes = [...new Set(versions.map(v => v.assetType))].filter(t => t !== targetAssetType);
    if (otherTypes.length > 0) {
      const summaries = otherTypes.map(t => {
        const v = versions.find(ver => ver.assetType === t && ver.isActive) || versions.find(ver => ver.assetType === t);
        return v ? `- ${t.replace(/_/g, ' ')}: ${v.content.substring(0, 200)}...` : null;
      }).filter(Boolean);
      if (summaries.length > 0) {
        systemParts.push(`\n## Other Asset Summaries\n${summaries.join('\n')}`);
      }
    }
  } else {
    // Include first active version of each type
    const byType = new Map<string, string>();
    for (const v of versions) {
      if (!byType.has(v.assetType) && (v.isActive || !byType.has(v.assetType))) {
        byType.set(v.assetType, `### ${v.assetType.replace(/_/g, ' ')} (v${v.versionNumber})\n${v.content.substring(0, 500)}...`);
      }
    }
    if (byType.size > 0) {
      systemParts.push(`\n## Current Versions\n${Array.from(byType.values()).join('\n\n')}`);
    }
  }

  const systemPrompt = systemParts.join('\n');

  // Load message history
  const allMessages = await db.query.sessionMessages.findMany({
    where: eq(sessionMessages.sessionId, sessionId),
    orderBy: [sessionMessages.createdAt],
  });

  // Convert to role/content pairs
  let messages = allMessages.map(m => ({
    role: m.role as 'user' | 'assistant',
    content: m.content,
  }));

  // Trim oldest messages if over budget
  let totalTokens = estimateTokens(systemPrompt);
  const trimmedMessages: typeof messages = [];

  // Work backwards from newest
  for (let i = messages.length - 1; i >= 0; i--) {
    const msgTokens = estimateTokens(messages[i].content);
    if (totalTokens + msgTokens > MAX_CONTEXT_TOKENS) break;
    totalTokens += msgTokens;
    trimmedMessages.unshift(messages[i]);
  }

  return {
    systemPrompt,
    messages: trimmedMessages,
  };
}
