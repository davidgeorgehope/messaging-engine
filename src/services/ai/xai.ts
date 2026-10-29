/**
 * xAI (Grok) adapters that mimic the small slices of the @google/genai and
 * @anthropic-ai/sdk client surfaces this app uses, so call sites stay unchanged.
 * Text -> /v1/responses (googleSearch tool -> web_search), images -> grok-imagine-image-2.0.
 */
import { config } from '../../config.js';

const XAI_BASE = 'https://api.x.ai/v1';
export const XAI_IMAGE_MODEL = 'grok-imagine-image-2.0';

function apiKey(): string {
  const key = config.apiKeys.xai;
  if (!key) throw new Error('XAI_API_KEY is not configured');
  return key;
}

async function post(path: string, body: unknown): Promise<any> {
  const res = await fetch(`${XAI_BASE}${path}`, {
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

type Part = { text?: string };
type Content = { role?: string; parts?: Part[] };

function toInput(contents: string | Content[]): Array<{ role: string; content: string }> {
  if (typeof contents === 'string') return [{ role: 'user', content: contents }];
  return contents.map((c) => ({
    role: c.role === 'model' ? 'assistant' : 'user',
    content: (c.parts ?? []).map((p) => p.text ?? '').join(''),
  }));
}

function parseResponses(data: any) {
  let text = '';
  const seen = new Set<string>();
  const chunks: Array<{ web: { uri: string; title?: string } }> = [];
  const add = (uri?: string, title?: string) => {
    if (uri && !seen.has(uri)) {
      seen.add(uri);
      chunks.push({ web: { uri, title } });
    }
  };
  for (const item of data.output ?? []) {
    if (item.type !== 'message') continue;
    for (const part of item.content ?? []) {
      if (part.type === 'output_text') {
        text += part.text ?? '';
        for (const a of part.annotations ?? []) add(a.url, a.title);
      }
    }
  }
  for (const c of data.citations ?? []) add(typeof c === 'string' ? c : c?.url);
  const u = data.usage ?? {};
  return { text, chunks, inputTokens: u.input_tokens ?? 0, outputTokens: u.output_tokens ?? 0, status: data.status };
}

async function respond(opts: {
  model: string;
  input: Array<{ role: string; content: string }>;
  temperature?: number;
  maxTokens?: number;
  search?: boolean;
  instructions?: string;
}) {
  const body: Record<string, unknown> = { model: opts.model, input: opts.input };
  if (opts.instructions) body.instructions = opts.instructions;
  if (typeof opts.temperature === 'number') body.temperature = opts.temperature;
  if (opts.maxTokens) body.max_output_tokens = opts.maxTokens;
  if (opts.search) body.tools = [{ type: 'web_search' }];
  return parseResponses(await post('/responses', body));
}

/** Gemini-shaped client: models.generateContent / generateContentStream. */
export function createXaiGeminiClient() {
  const generateContent = async (req: { model: string; contents: string | Content[]; config?: any }): Promise<any> => {
    const cfg = req.config ?? {};
    if (Array.isArray(cfg.responseModalities) && cfg.responseModalities.includes('IMAGE')) {
      const prompt = toInput(req.contents).map((m) => m.content).join('\n');
      const data = await post('/images/generations', { model: XAI_IMAGE_MODEL, prompt, n: 1, response_format: 'b64_json' });
      const b64 = data.data?.[0]?.b64_json;
      return {
        text: '',
        usageMetadata: { promptTokenCount: 0, candidatesTokenCount: 0, totalTokenCount: 0 },
        candidates: b64 ? [{ content: { parts: [{ inlineData: { data: b64, mimeType: 'image/jpeg' } }] } }] : [],
      };
    }
    const search = (cfg.tools ?? []).some((t: Record<string, unknown>) => 'googleSearch' in t);
    const r = await respond({
      model: req.model,
      input: toInput(req.contents),
      temperature: cfg.temperature,
      maxTokens: cfg.maxOutputTokens,
      search,
    });
    return {
      text: r.text,
      usageMetadata: {
        promptTokenCount: r.inputTokens,
        candidatesTokenCount: r.outputTokens,
        totalTokenCount: r.inputTokens + r.outputTokens,
        cachedContentTokenCount: 0,
      },
      candidates: [{ finishReason: r.status, groundingMetadata: { groundingChunks: r.chunks } }],
    };
  };
  const generateContentStream = async function* (req: { model: string; contents: string | Content[]; config?: any }) {
    // Non-streaming upstream; yields the whole reply as one chunk.
    const r = await generateContent(req);
    yield { text: r.text };
  };
  return { models: { generateContent, generateContentStream } };
}

/** Anthropic-shaped client: messages.create. */
export function createXaiAnthropicClient() {
  return {
    messages: {
      create: async (req: { model: string; max_tokens?: number; temperature?: number; system?: string; messages: Array<{ role: string; content: string }> }) => {
        const r = await respond({
          model: req.model,
          input: req.messages.map((m) => ({ role: m.role, content: m.content })),
          instructions: req.system || undefined,
          temperature: req.temperature,
          maxTokens: req.max_tokens,
        });
        return {
          content: [{ type: 'text' as const, text: r.text }],
          usage: { input_tokens: r.inputTokens, output_tokens: r.outputTokens },
          stop_reason: r.status as string | null,
        };
      },
    },
  };
}
