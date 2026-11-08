import { getModelForTask } from '../../config.js';
import { createLogger } from '../../utils/logger.js';
import { withRetry, createRateLimiter } from '../../utils/retry.js';
import { logCall } from './call-logger.js';
import {
  resolveTextModel,
  xaiGenerateImage,
  xaiRespond,
  xaiRespondStream,
  XAI_IMAGE_MODEL,
  type XaiMessage,
} from './xai.js';
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

const xaiRateLimiter = createRateLimiter({ maxRequests: 60, windowMs: 60000 });

function isRetryable(error: Error): boolean {
  const msg = error.message.toLowerCase();
  return msg.includes('rate') || msg.includes('429') || msg.includes('503') || msg.includes('overloaded');
}

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

function toUsage(inputTokens: number, outputTokens: number): TokenUsage {
  return {
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
    cachedTokens: 0,
  };
}

function toMessages(prompt: string, systemPrompt?: string): XaiMessage[] {
  return [{ role: 'user', content: systemPrompt ? `${systemPrompt}\n\n${prompt}` : prompt }];
}

export async function generateText(
  prompt: string,
  options: GenerateOptions & { useProModel?: boolean } = {},
): Promise<AIResponse> {
  const model = resolveTextModel(
    options.model ?? getModelForTask(options.useProModel ? 'pro' : 'flash'),
  );

  await xaiRateLimiter.acquire();
  logger.info('xAI call', { model, promptLength: prompt.length });
  const startTime = performance.now();

  try {
    const response = await withRetry(
      () => xaiRespond({
        model,
        input: toMessages(prompt, options.systemPrompt),
        temperature: options.temperature ?? 0.7,
        maxTokens: options.maxTokens,
      }),
      { maxRetries: 3, baseDelayMs: 2000, retryOn: isRetryable },
    );

    const latencyMs = Math.round(performance.now() - startTime);
    const usage = toUsage(response.inputTokens, response.outputTokens);
    usageTracker.track(model, usage, latencyMs);

    logCall({
      model,
      systemPrompt: options.systemPrompt,
      userPrompt: prompt,
      response: response.text,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      totalTokens: usage.totalTokens,
      cachedTokens: usage.cachedTokens,
      latencyMs,
      success: true,
      finishReason: response.status,
    });

    return {
      text: response.text,
      usage,
      model,
      finishReason: response.status,
      latencyMs,
    };
  } catch (error) {
    usageTracker.trackError(model);
    logger.error('xAI generation failed', {
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

export async function* streamText(
  messages: Array<{ role: string; content: string }>,
  options: GenerateOptions = {},
): AsyncGenerator<string> {
  const model = resolveTextModel(options.model ?? getModelForTask('pro'));
  await xaiRateLimiter.acquire();
  const input: XaiMessage[] = messages.map((message) => ({
    role: message.role === 'assistant' || message.role === 'model'
      ? 'assistant'
      : message.role === 'system'
        ? 'system'
        : 'user',
    content: message.content,
  }));
  const userPrompt = [...messages].reverse().find((message) => message.role === 'user')?.content ?? '';
  const startTime = performance.now();
  let full = '';

  try {
    try {
      for await (const delta of xaiRespondStream({
        model,
        input,
        temperature: options.temperature ?? 0.7,
        maxTokens: options.maxTokens,
        instructions: options.systemPrompt,
      })) {
        full += delta;
        yield delta;
      }
    } catch (streamError) {
      if (full) throw streamError;
      logger.warn('xAI stream failed, using a single response', {
        error: streamError instanceof Error ? streamError.message : String(streamError),
      });
      const response = await xaiRespond({
        model,
        input,
        temperature: options.temperature ?? 0.7,
        maxTokens: options.maxTokens,
        instructions: options.systemPrompt,
      });
      full = response.text;
      yield full;
    }

    const latencyMs = Math.round(performance.now() - startTime);
    logCall({
      model,
      systemPrompt: options.systemPrompt,
      userPrompt,
      response: full,
      latencyMs,
      success: true,
    });
  } catch (error) {
    logCall({
      model,
      systemPrompt: options.systemPrompt,
      userPrompt,
      success: false,
      errorMessage: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

export async function generateWithWebSearch(
  prompt: string,
  options: GenerateOptions = {},
): Promise<GroundedSearchResponse> {
  const model = resolveTextModel(options.model ?? getModelForTask('flash'));
  logger.info('xAI web search', { model, promptLength: prompt.length });
  const startTime = performance.now();
  const maxEmptyRetries = 5;

  try {
    let response = await requestSearch(model, prompt, options);
    for (let attempt = 1; attempt <= maxEmptyRetries && response.text.length === 0 && response.sources.length === 0; attempt++) {
      logger.warn('xAI web search returned empty, retrying', { attempt, maxRetries: maxEmptyRetries });
      await new Promise((resolve) => setTimeout(resolve, 3000 * attempt));
      response = await requestSearch(model, prompt, options);
    }

    const latencyMs = Math.round(performance.now() - startTime);
    const usage = toUsage(response.inputTokens, response.outputTokens);
    usageTracker.track(model, usage, latencyMs);
    const sources: SearchResult[] = response.sources.map((source) => ({
      title: source.title,
      url: source.url,
      snippet: '',
    }));

    logCall({
      model,
      systemPrompt: options.systemPrompt,
      userPrompt: prompt,
      response: response.text,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      totalTokens: usage.totalTokens,
      latencyMs,
      success: true,
    });

    return { text: response.text, sources, usage, model, latencyMs };
  } catch (error) {
    usageTracker.trackError(model);
    logger.error('xAI web search failed', {
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

async function requestSearch(model: string, prompt: string, options: GenerateOptions) {
  await xaiRateLimiter.acquire();
  return withRetry(
    () => xaiRespond({
      model,
      input: toMessages(prompt, options.systemPrompt),
      temperature: options.temperature ?? 0.3,
      maxTokens: options.maxTokens,
      search: true,
    }),
    { maxRetries: 3, baseDelayMs: 2000, retryOn: isRetryable },
  );
}

export async function generateJSON<T = unknown>(
  prompt: string,
  options: GenerateJSONOptions = {},
): Promise<{ data: T; usage: TokenUsage; model: string }> {
  const maxRetries = options.maxParseRetries ?? 2;
  const jsonPrompt = options.schema
    ? `${prompt}\n\nRespond with valid JSON matching this schema:\n${JSON.stringify(options.schema, null, 2)}\n\nIMPORTANT: Return ONLY valid JSON, no markdown code fences or explanation.`
    : `${prompt}\n\nIMPORTANT: Return ONLY valid JSON, no markdown code fences or explanation.`;

  let lastError: string | undefined;
  let lastResponse: string | undefined;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    let currentPrompt = jsonPrompt;
    if (attempt > 0 && lastError && lastResponse) {
      currentPrompt = `${jsonPrompt}\n\nYour previous response was invalid JSON. Here was the error:\n${lastError}\n\nThe broken response started with:\n${lastResponse.substring(0, 500)}\n\nPlease fix the JSON and return ONLY valid JSON.`;
    }

    const response = await generateText(currentPrompt, {
      ...options,
      model: options.model ?? getModelForTask('pro'),
      temperature: options.temperature ?? 0.3,
    });

    try {
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
      logger.warn('JSON parse failed, retrying with error feedback', { attempt, error: lastError });
    }
  }

  throw new Error('Unreachable: JSON generation exhausted retries');
}

export interface GeneratedImage {
  imageData: string;
  mimeType: string;
}

export async function generateImage(prompt: string): Promise<GeneratedImage> {
  const model = XAI_IMAGE_MODEL;
  await xaiRateLimiter.acquire();
  logger.info('xAI image generation', { model, promptLength: prompt.length });
  const startTime = performance.now();

  try {
    const image = await withRetry(
      () => xaiGenerateImage(prompt),
      { maxRetries: 2, baseDelayMs: 3000, retryOn: isRetryable },
    );
    const latencyMs = Math.round(performance.now() - startTime);
    const usage = toUsage(0, 0);
    usageTracker.track(model, usage, latencyMs);
    logCall({
      model,
      userPrompt: prompt,
      response: '[image generated]',
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      latencyMs,
      success: true,
    });
    return image;
  } catch (error) {
    usageTracker.trackError(model);
    logger.error('xAI image generation failed', {
      model,
      error: error instanceof Error ? error.message : String(error),
    });
    logCall({
      model,
      userPrompt: prompt,
      success: false,
      errorMessage: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}
