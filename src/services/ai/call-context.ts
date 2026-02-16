// AsyncLocalStorage-based context for threading session/job/purpose through
// async call chains without changing function signatures.

import { AsyncLocalStorage } from 'node:async_hooks';

export interface LLMCallContext {
  purpose: string;
  jobId?: string;
  sessionId?: string;
}

export const llmCallContext = new AsyncLocalStorage<LLMCallContext>();

/**
 * Run an async function with LLM call context attached.
 * All LLM calls within `fn` will automatically inherit this context
 * for logging purposes.
 */
export function withLLMContext<T>(ctx: LLMCallContext, fn: () => Promise<T>): Promise<T> {
  return llmCallContext.run(ctx, fn);
}
