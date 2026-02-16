import Anthropic from '@anthropic-ai/sdk';
import { GoogleGenAI } from '@google/genai';
import { config, getModelForTask, isTestProfile } from '../../config.js';
import { createLogger } from '../../utils/logger.js';
import { withRetry, withTimeout, createRateLimiter } from '../../utils/retry.js';
import { logCall } from './call-logger.js';
import type {
  TokenUsage,
  AIResponse,
  GenerateOptions,
  GenerateJSONOptions,
  SearchResult,
  GroundedSearchResponse,
  UsageStats,
} from './types.js';

const logger = createLogger('ai-clients');

// ---------------------------------------------------------------------------
// Rate limiters
// ---------------------------------------------------------------------------
const claudeRateLimiter = createRateLimiter({ maxRequests: 10, windowMs: 60000 });
const geminiFlashRateLimiter = createRateLimiter({ maxRequests: 60, windowMs: 60000 });
const geminiProRateLimiter = createRateLimiter({ maxRequests: 15, windowMs: 60000 });

// ---------------------------------------------------------------------------
// Lazy-initialized clients
// ---------------------------------------------------------------------------
let anthropicClient: Anthropic | null = null;
let googleClient: GoogleGenAI | null = null;

function getAnthropicClient(): Anthropic {
  if (!anthropicClient) {
    if (!config.apiKeys.anthropic) {
      throw new Error('ANTHROPIC_API_KEY is not configured');
    }
    anthropicClient = new Anthropic({ apiKey: config.apiKeys.anthropic });
  }
  return anthropicClient;
}

function getGoogleClient(): GoogleGenAI {
  if (!googleClient) {
    if (!config.apiKeys.googleAi) {
      throw new Error('GOOGLE_AI_API_KEY is not configured');
    }
    googleClient = new GoogleGenAI({ apiKey: config.apiKeys.googleAi });
  }
  return googleClient;
}

// ---------------------------------------------------------------------------
// Usage tracker
// ---------------------------------------------------------------------------
export class UsageTracker {
  private stats: UsageStats = {
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalTokens: 0,
    totalCachedTokens: 0,
    requestCount: 0,
    errorCount: 0,
    totalLatencyMs: 0,
    avgLatencyMs: 0,
    byModel: {},
  };

  track(model: string, usage: TokenUsage, latencyMs: number): void {
    this.stats.totalInputTokens += usage.inputTokens;
    this.stats.totalOutputTokens += usage.outputTokens;
    this.stats.totalTokens += usage.totalTokens;
    this.stats.totalCachedTokens += usage.cachedTokens ?? 0;
    this.stats.requestCount++;
    this.stats.totalLatencyMs += latencyMs;
    this.stats.avgLatencyMs = Math.round(this.stats.totalLatencyMs / this.stats.requestCount);

    if (!this.stats.byModel[model]) {
      this.stats.byModel[model] = {
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        requestCount: 0,
        errorCount: 0,
        totalLatencyMs: 0,
      };
    }

    const modelStats = this.stats.byModel[model];
    modelStats.inputTokens += usage.inputTokens;
    modelStats.outputTokens += usage.outputTokens;
    modelStats.totalTokens += usage.totalTokens;
    modelStats.requestCount++;
    modelStats.totalLatencyMs += latencyMs;
  }

  trackError(model: string): void {
    this.stats.errorCount++;
    if (this.stats.byModel[model]) {
      this.stats.byModel[model].errorCount++;
    }
  }

  getStats(): UsageStats {
    return { ...this.stats };
  }

  reset(): void {
    this.stats = {
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalTokens: 0,
      totalCachedTokens: 0,
      requestCount: 0,
      errorCount: 0,
      totalLatencyMs: 0,
      avgLatencyMs: 0,
      byModel: {},
    };
  }
}

export const usageTracker = new UsageTracker();

// ---------------------------------------------------------------------------
// generateWithClaude
// ---------------------------------------------------------------------------
export async function generateWithClaude(
  prompt: string,
  options: GenerateOptions = {}
): Promise<AIResponse> {
  const model = options.model ?? config.ai.claude.model;
  const maxTokens = options.maxTokens ?? 16384;

  await claudeRateLimiter.acquire();

  logger.info('Claude call', { model, promptLength: prompt.length });

  const startTime = performance.now();

  try {
    const response = await withRetry(
      async () => {
        const client = getAnthropicClient();
        return client.messages.create({
          model,
          max_tokens: maxTokens,
          temperature: options.temperature ?? 0.7,
          system: options.systemPrompt ?? '',
          messages: [{ role: 'user', content: prompt }],
          ...(options.stopSequences ? { stop_sequences: options.stopSequences } : {}),
        });
      },
      {
        maxRetries: 3,
        baseDelayMs: 2000,
        retryOn: (error: Error) => {
          const msg = error.message.toLowerCase();
          return msg.includes('rate') || msg.includes('overloaded') || msg.includes('529');
        },
      }
    );

    const latencyMs = Math.round(performance.now() - startTime);

    const usage: TokenUsage = {
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
      totalTokens: response.usage.input_tokens + response.usage.output_tokens,
      cachedTokens: (response.usage as any).cache_read_input_tokens ?? 0,
    };

    usageTracker.track(model, usage, latencyMs);

    const text = response.content
      .filter((block): block is Anthropic.TextBlock => block.type === 'text')
      .map((block) => block.text)
      .join('');

    logger.debug('Claude response received', {
      model,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      latencyMs,
    });

    logCall({
      model,
      systemPrompt: options.systemPrompt,
      userPrompt: prompt,
      response: text,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      totalTokens: usage.totalTokens,
      cachedTokens: usage.cachedTokens,
      latencyMs,
      success: true,
      finishReason: response.stop_reason ?? undefined,
    });

    return {
      text,
      usage,
      model,
      finishReason: response.stop_reason ?? undefined,
      latencyMs,
    };
  } catch (error) {
    usageTracker.trackError(model);
    logger.error('Claude generation failed', {
      model,
      error: error instanceof Error ? error.message : String(error),
    });
    logCall({
      model,
      systemPrompt: options.systemPrompt,
      userPrompt: prompt,
      success: false,
      errorMessage: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

// ---------------------------------------------------------------------------
// generateWithGemini
// ---------------------------------------------------------------------------
export async function generateWithGemini(
  prompt: string,
  options: GenerateOptions & { useProModel?: boolean } = {}
): Promise<AIResponse> {
  const model = options.model ?? (options.useProModel ? getModelForTask("pro") : getModelForTask("flash"));
  const isProModel = options.useProModel || (options.model && options.model.includes("pro"));

  await (isProModel ? geminiProRateLimiter : geminiFlashRateLimiter).acquire();

  logger.info('Gemini call', { model, promptLength: prompt.length });

  const startTime = performance.now();

  try {
    const response = await withRetry(
      async () => {
        const client = getGoogleClient();
        return client.models.generateContent({
          model,
          contents: [
            {
              role: 'user',
              parts: [{ text: options.systemPrompt ? `${options.systemPrompt}\n\n${prompt}` : prompt }],
            },
          ],
          config: {
            ...(options.maxTokens ? { maxOutputTokens: options.maxTokens } : {}),
            temperature: options.temperature ?? 0.7,
            topP: options.topP,
            topK: options.topK,
            stopSequences: options.stopSequences,
          },
        });
      },
      {
        maxRetries: 3,
        baseDelayMs: 2000,
        retryOn: (error: Error) => {
          const msg = error.message.toLowerCase();
          return msg.includes('rate') || msg.includes('quota') || msg.includes('503');
        },
      }
    );

    const latencyMs = Math.round(performance.now() - startTime);

    const usageMeta = response.usageMetadata;
    const usage: TokenUsage = {
      inputTokens: usageMeta?.promptTokenCount ?? 0,
      outputTokens: usageMeta?.candidatesTokenCount ?? 0,
      totalTokens: usageMeta?.totalTokenCount ?? 0,
      cachedTokens: usageMeta?.cachedContentTokenCount ?? 0,
    };

    usageTracker.track(model, usage, latencyMs);

    const text = response.text ?? '';

    logger.debug('Gemini response received', {
      model,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      latencyMs,
    });

    logCall({
      model,
      systemPrompt: options.systemPrompt,
      userPrompt: prompt,
      response: text,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      totalTokens: usage.totalTokens,
      cachedTokens: usage.cachedTokens,
      latencyMs,
      success: true,
      finishReason: response.candidates?.[0]?.finishReason ?? undefined,
    });

    return {
      text,
      usage,
      model,
      finishReason: response.candidates?.[0]?.finishReason ?? undefined,
      latencyMs,
    };
  } catch (error) {
    usageTracker.trackError(model);
    logger.error('Gemini generation failed', {
      model,
      error: error instanceof Error ? error.message : String(error),
    });
    logCall({
      model,
      systemPrompt: options.systemPrompt,
      userPrompt: prompt,
      success: false,
      errorMessage: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

// ---------------------------------------------------------------------------
// generateWithGeminiGroundedSearch
// ---------------------------------------------------------------------------
export async function generateWithGeminiGroundedSearch(
  prompt: string,
  options: GenerateOptions = {}
): Promise<GroundedSearchResponse> {
  const model = options.model ?? getModelForTask("flash");

  await geminiFlashRateLimiter.acquire();

  logger.info('Gemini search call', { model, promptLength: prompt.length });
  const startTime = performance.now();

  try {
    // Retry wrapper that also retries on empty grounded search results
    const MAX_EMPTY_RETRIES = 5;
    let response: any;
    let emptyRetries = 0;

    while (true) {
      response = await withRetry(
        async () => {
          const client = getGoogleClient();
          return client.models.generateContent({
            model,
            contents: [
              {
                role: 'user',
                parts: [{ text: options.systemPrompt ? `${options.systemPrompt}\n\n${prompt}` : prompt }],
              },
            ],
            config: {
              temperature: options.temperature ?? 0.3,
              tools: [{ googleSearch: {} }],
            },
          });
        },
        {
          maxRetries: 3,
          baseDelayMs: 2000,
          retryOn: (error: Error) => {
            const msg = error.message.toLowerCase();
            return msg.includes('rate') || msg.includes('quota') || msg.includes('503');
          },
        }
      );

      // Retry if grounded search returned empty (flaky API behavior)
      const responseText = response.text ?? '';
      const hasChunks = (response.candidates?.[0] as any)?.groundingMetadata?.groundingChunks?.length > 0;
      if (responseText.length === 0 && !hasChunks && emptyRetries < MAX_EMPTY_RETRIES) {
        emptyRetries++;
        logger.warn('Grounded search returned empty, retrying', { attempt: emptyRetries, maxRetries: MAX_EMPTY_RETRIES });
        await new Promise(r => setTimeout(r, 3000 * emptyRetries));
        await geminiFlashRateLimiter.acquire();
        continue;
      }
      break;
    }

    const latencyMs = Math.round(performance.now() - startTime);

    const usageMeta = response.usageMetadata;
    const usage: TokenUsage = {
      inputTokens: usageMeta?.promptTokenCount ?? 0,
      outputTokens: usageMeta?.candidatesTokenCount ?? 0,
      totalTokens: usageMeta?.totalTokenCount ?? 0,
    };

    usageTracker.track(model, usage, latencyMs);

    const text = response.text ?? '';

    // Extract grounding sources from the response
    const groundingMetadata = (response.candidates?.[0] as any)?.groundingMetadata;
    const sources: SearchResult[] = [];

    if (groundingMetadata?.groundingChunks) {
      for (const chunk of groundingMetadata.groundingChunks) {
        if (chunk.web) {
          sources.push({
            title: chunk.web.title ?? '',
            url: chunk.web.uri ?? '',
            snippet: '',
          });
        }
      }
    }

    if (groundingMetadata?.webSearchQueries) {
      logger.debug('Grounding search queries', { queries: groundingMetadata.webSearchQueries });
    }

    logger.debug('Gemini grounded search response received', {
      model,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      sourcesCount: sources.length,
      latencyMs,
    });

    logCall({
      model,
      systemPrompt: options.systemPrompt,
      userPrompt: prompt,
      response: text,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      totalTokens: usage.totalTokens,
      latencyMs,
      success: true,
    });

    return {
      text,
      sources,
      usage,
      model,
      searchQueries: groundingMetadata?.webSearchQueries,
      latencyMs,
    };
  } catch (error) {
    usageTracker.trackError(model);
    logger.error('Gemini grounded search failed', {
      model,
      error: error instanceof Error ? error.message : String(error),
    });
    logCall({
      model,
      systemPrompt: options.systemPrompt,
      userPrompt: prompt,
      success: false,
      errorMessage: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

// ---------------------------------------------------------------------------
// generateJSON
// ---------------------------------------------------------------------------
export async function generateJSON<T = unknown>(
  prompt: string,
  options: GenerateJSONOptions = {}
): Promise<{ data: T; usage: TokenUsage; model: string }> {
  const maxRetries = options.maxParseRetries ?? 2;

  const jsonPrompt = options.schema
    ? `${prompt}\n\nRespond with valid JSON matching this schema:\n${JSON.stringify(options.schema, null, 2)}\n\nIMPORTANT: Return ONLY valid JSON, no markdown code fences or explanation.`
    : `${prompt}\n\nIMPORTANT: Return ONLY valid JSON, no markdown code fences or explanation.`;

  let lastError: string | undefined;
  let lastResponse: string | undefined;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    // On retry, include the previous error so the model can fix it
    let currentPrompt = jsonPrompt;
    if (attempt > 0 && lastError && lastResponse) {
      currentPrompt = `${jsonPrompt}\n\nYour previous response was invalid JSON. Here was the error:\n${lastError}\n\nThe broken response started with:\n${lastResponse.substring(0, 500)}\n\nPlease fix the JSON and return ONLY valid JSON.`;
    }

    const response = await generateWithGemini(currentPrompt, {
      useProModel: true,
      ...options,
      temperature: options.temperature ?? 0.3,
    });

    try {
      // Strip markdown code fences if present
      let jsonText = response.text.trim();
      if (jsonText.startsWith('```')) {
        jsonText = jsonText.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '');
      }

      const data = JSON.parse(jsonText) as T;
      return { data, usage: response.usage, model: response.model };
    } catch (parseError) {
      lastError = parseError instanceof Error ? parseError.message : String(parseError);
      lastResponse = response.text;

      if (attempt === maxRetries || !options.retryOnParseError) {
        logger.error('JSON parse failed after retries', {
          attempt,
          error: lastError,
          rawText: response.text.substring(0, 200),
        });
        throw new Error(`Failed to parse AI response as JSON: ${lastError}`);
      }

      logger.warn('JSON parse failed, retrying with error feedback', {
        attempt,
        error: lastError,
      });
    }
  }

  throw new Error('Unreachable: JSON generation exhausted retries');
}

// ---------------------------------------------------------------------------
// Deep Research functions (adapted from compintels pattern)
// ---------------------------------------------------------------------------

/**
 * Creates an async deep research interaction using the Gemini deep research agent.
 * Returns the interaction ID to poll for results.
 */
export async function createDeepResearchInteraction(prompt: string): Promise<string> {
  const client = getGoogleClient();
  const model = getModelForTask("deepResearch");

  logger.info('Creating deep research interaction', { model, promptLength: prompt.length });

  const response = await withRetry(
    async () => {
      return client.models.generateContent({
        model,
        contents: [
          {
            role: 'user',
            parts: [{ text: prompt }],
          },
        ],
      });
    },
    {
      maxRetries: 2,
      baseDelayMs: 5000,
    }
  );

  // The deep research agent returns an interaction ID in the response metadata
  // or in the response structure as an async operation
  const interactionId = (response as any).name
    ?? (response as any).operationId
    ?? (response as any).metadata?.interactionId;

  if (!interactionId) {
    // If no async interaction ID, the response may have completed synchronously
    // Generate an ID and return the response directly
    const syntheticId = `dr-sync-${Date.now().toString(36)}`;
    logger.info('Deep research completed synchronously', { interactionId: syntheticId });

    // Cache the synchronous result for retrieval
    _syncResults.set(syntheticId, {
      text: response.text ?? '',
      candidates: response.candidates,
      usageMetadata: response.usageMetadata,
    });

    return syntheticId;
  }

  logger.info('Deep research interaction created', { interactionId });
  return interactionId;
}

// Cache for synchronous deep research results
const _syncResults = new Map<string, any>();

/**
 * Polls a deep research interaction until it completes or times out.
 * Uses configurable poll interval (default 30s) and timeout (default 60min).
 */
export async function pollInteractionUntilComplete(
  interactionId: string,
  onProgress?: (status: string) => void
): Promise<{ text: string; sources: SearchResult[] }> {
  const pollInterval = config.deepResearch.pollIntervalMs;
  const timeout = config.deepResearch.timeoutMs;

  logger.info('Polling deep research interaction', { interactionId, pollInterval, timeout });

  // Check for cached synchronous result
  if (_syncResults.has(interactionId)) {
    const cached = _syncResults.get(interactionId)!;
    _syncResults.delete(interactionId);

    const text = cached.text ?? '';
    const sources = extractSourcesFromResponse(text, cached);

    return { text, sources };
  }

  return withTimeout(
    async () => {
      const client = getGoogleClient();
      const startTime = Date.now();

      while (true) {
        try {
          // Poll the operation status
          const operation = await (client as any).operations?.get({ name: interactionId });

          if (!operation) {
            throw new Error(`Could not retrieve operation: ${interactionId}`);
          }

          const status = operation.done ? 'completed' : (operation.metadata?.status ?? 'in_progress');

          if (onProgress) {
            const elapsed = Math.round((Date.now() - startTime) / 1000);
            onProgress(`${status} (${elapsed}s elapsed)`);
          }

          logger.debug('Deep research poll', {
            interactionId,
            status,
            elapsed: Math.round((Date.now() - startTime) / 1000),
          });

          if (operation.done) {
            if (operation.error) {
              throw new Error(`Deep research failed: ${operation.error.message ?? JSON.stringify(operation.error)}`);
            }

            const result = operation.response ?? operation.result;
            const text = result?.text
              ?? result?.candidates?.[0]?.content?.parts?.map((p: { text?: string }) => p.text).join('')
              ?? '';
            const sources = extractSourcesFromResponse(text, result);

            logger.info('Deep research completed', {
              interactionId,
              textLength: text.length,
              sourcesCount: sources.length,
              totalElapsed: Math.round((Date.now() - startTime) / 1000),
            });

            return { text, sources };
          }
        } catch (error) {
          // If it's a non-retryable error, throw immediately
          if (error instanceof Error && error.message.includes('Deep research failed')) {
            throw error;
          }
          logger.warn('Poll attempt failed, continuing', {
            interactionId,
            error: error instanceof Error ? error.message : String(error),
          });
        }

        await new Promise((resolve) => setTimeout(resolve, pollInterval));
      }
    },
    {
      timeoutMs: timeout,
      message: `Deep research interaction ${interactionId} timed out after ${timeout}ms`,
    }
  );
}

/**
 * Extracts structured SearchResult sources from a deep research response.
 */
export function extractSourcesFromResponse(text: string, interaction: Record<string, any>): SearchResult[] {
  const sources: SearchResult[] = [];
  const seenUrls = new Set<string>();

  // Extract from grounding metadata (if present in candidates)
  const candidates = interaction?.candidates ?? [];
  for (const candidate of candidates) {
    const groundingMetadata = candidate?.groundingMetadata;
    if (groundingMetadata?.groundingChunks) {
      for (const chunk of groundingMetadata.groundingChunks) {
        if (chunk.web && chunk.web.uri && !seenUrls.has(chunk.web.uri)) {
          seenUrls.add(chunk.web.uri);
          sources.push({
            title: chunk.web.title ?? '',
            url: chunk.web.uri,
            snippet: '',
          });
        }
      }
    }

    // Also check grounding supports for snippets
    if (groundingMetadata?.groundingSupports) {
      for (const support of groundingMetadata.groundingSupports) {
        if (support.segment?.text && support.groundingChunkIndices) {
          for (const idx of support.groundingChunkIndices) {
            const chunk = groundingMetadata.groundingChunks?.[idx];
            if (chunk?.web?.uri) {
              const existing = sources.find((s) => s.url === chunk.web.uri);
              if (existing && !existing.snippet) {
                existing.snippet = support.segment.text;
              }
            }
          }
        }
      }
    }
  }

  // Extract from search entry points
  if (interaction?.searchEntryPoint?.renderedContent) {
    logger.debug('Search entry point found in response');
  }

  // Fallback: extract URLs from the text itself
  if (sources.length === 0 && text) {
    const urlRegex = /https?:\/\/[^\s)\]>"']+/g;
    const matches = text.match(urlRegex) ?? [];
    for (const url of matches) {
      const cleanUrl = url.replace(/[.,;:!?]+$/, '');
      if (!seenUrls.has(cleanUrl)) {
        seenUrls.add(cleanUrl);
        sources.push({
          title: '',
          url: cleanUrl,
          snippet: '',
        });
      }
    }
  }

  return sources;
}
