// Fire-and-forget LLM call logger — persists every LLM call to the database.
// Never throws; errors are logged and swallowed.

import { getDatabase } from '../../db/index.js';
import { llmCalls } from '../../db/schema.js';
import { generateId } from '../../utils/hash.js';
import { createLogger } from '../../utils/logger.js';
import { llmCallContext } from './call-context.js';

const logger = createLogger('ai:call-logger');

export interface LogCallData {
  model: string;
  purpose?: string;
  sessionId?: string;
  jobId?: string;
  systemPrompt?: string;
  userPrompt: string;
  response?: string;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  cachedTokens?: number;
  latencyMs?: number;
  success?: boolean;
  errorMessage?: string;
  finishReason?: string;
}

/**
 * Log an LLM call to the database. Fire-and-forget — never throws.
 * Reads context from AsyncLocalStorage if purpose/sessionId/jobId not provided.
 */
export function logCall(data: LogCallData): void {
  try {
    const ctx = llmCallContext.getStore();
    const now = new Date().toISOString();

    const db = getDatabase();
    db.insert(llmCalls).values({
      id: generateId(),
      sessionId: data.sessionId ?? ctx?.sessionId ?? null,
      jobId: data.jobId ?? ctx?.jobId ?? null,
      timestamp: now,
      model: data.model,
      purpose: data.purpose ?? ctx?.purpose ?? 'unknown',
      systemPrompt: data.systemPrompt ?? null,
      userPrompt: data.userPrompt,
      response: data.response ?? null,
      inputTokens: data.inputTokens ?? 0,
      outputTokens: data.outputTokens ?? 0,
      totalTokens: data.totalTokens ?? 0,
      cachedTokens: data.cachedTokens ?? 0,
      latencyMs: data.latencyMs ?? 0,
      success: data.success ?? true,
      errorMessage: data.errorMessage ?? null,
      finishReason: data.finishReason ?? null,
      createdAt: now,
    }).run();
  } catch (err) {
    logger.warn('Failed to log LLM call', {
      model: data.model,
      purpose: data.purpose,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
