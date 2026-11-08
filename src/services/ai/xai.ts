/**
 * xAI client.
 * Text and web research: grok-4.7 on POST /v1/responses (web_search tool).
 * Images: grok-imagine-image-2.0 on POST /v1/images/generations.
 * Docs: https://docs.x.ai/developers/models
 */
import { config } from '../../config.js';

export const XAI_TEXT_MODEL = 'grok-4.7';
export const XAI_IMAGE_MODEL = 'grok-imagine-image-2.0';
const XAI_BASE = 'https://api.x.ai/v1';
const XAI_HOST = 'api.x.ai';

const ALLOWED_TEXT_MODELS = new Set([XAI_TEXT_MODEL]);

export interface XaiMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface XaiSource {
  title: string;
  url: string;
}

export interface XaiTextResult {
  text: string;
  sources: XaiSource[];
  inputTokens: number;
  outputTokens: number;
  status?: string;
}

/** Any id other than grok-4.7 is ignored. Every text call uses grok-4.7. */
export function resolveTextModel(requested?: string): string {
  if (requested && ALLOWED_TEXT_MODELS.has(requested)) return requested;
  return XAI_TEXT_MODEL;
}

function apiKey(): string {
  const key = process.env.XAI_API_KEY || config.apiKeys.xai;
  if (!key) throw new Error('XAI_API_KEY is not configured');
  return key;
}

async function post(path: string, body: unknown): Promise<any> {
  const url = new URL(`${XAI_BASE}${path}`);
  if (url.host !== XAI_HOST) {
    throw new Error(`Refusing non-xAI host: ${url.host}`);
  }
  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const detail = (await res.text()).slice(0, 500);
    throw new Error(`xAI ${res.status}${res.status === 429 ? ' rate limited' : ''}${res.status >= 500 ? ' 503' : ''}: ${detail}`);
  }
  return res.json();
}

function addSource(seen: Set<string>, chunks: XaiSource[], uri?: string, title?: string) {
  if (uri && !seen.has(uri)) {
    seen.add(uri);
    chunks.push({ url: uri, title: title ?? '' });
  }
}

export function parseResponsesPayload(data: any): XaiTextResult {
  let text = '';
  const seen = new Set<string>();
  const sources: XaiSource[] = [];
  for (const item of data?.output ?? []) {
    if (item?.type !== 'message') continue;
    for (const part of item.content ?? []) {
      if (part?.type === 'output_text') {
        text += part.text ?? '';
        for (const annotation of part.annotations ?? []) addSource(seen, sources, annotation.url, annotation.title);
      }
    }
  }
  for (const citation of data?.citations ?? []) {
    addSource(seen, sources, typeof citation === 'string' ? citation : citation?.url, citation?.title);
  }
  const usage = data?.usage ?? {};
  return {
    text,
    sources,
    inputTokens: usage.input_tokens ?? 0,
    outputTokens: usage.output_tokens ?? 0,
    status: data?.status,
  };
}

function requestBody(opts: {
  model?: string;
  input: XaiMessage[];
  temperature?: number;
  maxTokens?: number;
  search?: boolean;
  instructions?: string;
  stream?: boolean;
}): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: resolveTextModel(opts.model),
    input: opts.input,
  };
  if (opts.instructions) body.instructions = opts.instructions;
  if (typeof opts.temperature === 'number') body.temperature = opts.temperature;
  if (opts.maxTokens) body.max_output_tokens = opts.maxTokens;
  if (opts.search) body.tools = [{ type: 'web_search' }];
  if (opts.stream) body.stream = true;
  return body;
}

export async function xaiRespond(opts: {
  model?: string;
  input: XaiMessage[];
  temperature?: number;
  maxTokens?: number;
  search?: boolean;
  instructions?: string;
}): Promise<XaiTextResult> {
  return parseResponsesPayload(await post('/responses', requestBody(opts)));
}

function deltaFromEvent(json: any): string {
  if (!json || typeof json !== 'object') return '';
  if (json.type === 'response.output_text.delta' && typeof json.delta === 'string') return json.delta;
  return '';
}

/** Stream grok-4.7 text deltas. Throws if the response is not a stream. */
export async function* xaiRespondStream(opts: {
  model?: string;
  input: XaiMessage[];
  temperature?: number;
  maxTokens?: number;
  instructions?: string;
}): AsyncGenerator<string> {
  const url = new URL(`${XAI_BASE}/responses`);
  if (url.host !== XAI_HOST) throw new Error(`Refusing non-xAI host: ${url.host}`);
  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(requestBody({ ...opts, stream: true })),
  });
  if (!res.ok) {
    const detail = (await res.text()).slice(0, 500);
    throw new Error(`xAI ${res.status}${res.status === 429 ? ' rate limited' : ''}${res.status >= 500 ? ' 503' : ''}: ${detail}`);
  }
  if (!res.body) throw new Error('xAI stream response had no body');

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data:')) continue;
      const payload = trimmed.slice(5).trim();
      if (!payload || payload === '[DONE]') continue;
      try {
        const delta = deltaFromEvent(JSON.parse(payload));
        if (delta) yield delta;
      } catch {
        // Ignore non-JSON keepalives.
      }
    }
  }
}

export async function xaiGenerateImage(prompt: string): Promise<{ imageData: string; mimeType: string }> {
  const data = await post('/images/generations', {
    model: XAI_IMAGE_MODEL,
    prompt,
    n: 1,
    response_format: 'b64_json',
  });
  const imageData = data?.data?.[0]?.b64_json;
  if (!imageData || typeof imageData !== 'string') {
    throw new Error('No image data in xAI response');
  }
  return { imageData, mimeType: 'image/jpeg' };
}
