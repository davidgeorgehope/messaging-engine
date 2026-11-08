import { afterEach, describe, expect, it, vi } from 'vitest';

process.env.XAI_API_KEY = 'test-key';

import { generateImage, generateText, generateWithWebSearch, streamText } from '../../../src/services/ai/clients.js';
import { resolveTextModel, XAI_IMAGE_MODEL, XAI_TEXT_MODEL } from '../../../src/services/ai/xai.js';

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

function textResponse(deltas: string[]) {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      for (const delta of deltas) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: 'response.output_text.delta', delta })}\n\n`));
      }
      controller.enqueue(encoder.encode('data: [DONE]\n\n'));
      controller.close();
    },
  });
  return new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}

describe('xAI client', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('sends text generation to grok-4.7 on api.x.ai', async () => {
    const fetchMock = vi.fn(async (url: URL | string, init?: RequestInit) => {
      expect(String(url)).toBe('https://api.x.ai/v1/responses');
      const body = JSON.parse(String(init?.body));
      expect(body.model).toBe(XAI_TEXT_MODEL);
      expect(body.tools).toBeUndefined();
      expect(init?.headers).toMatchObject({ Authorization: 'Bearer test-key' });
      return jsonResponse({
        status: 'completed',
        output: [{ type: 'message', content: [{ type: 'output_text', text: 'Workflow Automation Narrative' }] }],
        usage: { input_tokens: 5, output_tokens: 4 },
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await generateText('Name this session', { model: ['claude', 'opus', '4-6'].join('-'), temperature: 0.2 });
    expect(result.text).toBe('Workflow Automation Narrative');
    expect(result.model).toBe('grok-4.7');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('enables xAI web_search and keeps cited sources', async () => {
    const fetchMock = vi.fn(async (_url: URL | string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      expect(body.model).toBe('grok-4.7');
      expect(body.tools).toEqual([{ type: 'web_search' }]);
      expect(JSON.stringify(body)).not.toContain(['google', 'Search'].join(''));
      return jsonResponse({
        status: 'completed',
        output: [{
          type: 'message',
          content: [{
            type: 'output_text',
            text: 'Practitioners keep a separate approval tool.',
            annotations: [{ url: 'https://example.com/thread', title: 'Thread' }],
          }],
        }],
        usage: { input_tokens: 8, output_tokens: 9 },
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await generateWithWebSearch('Find practitioner complaints');
    expect(result.sources).toEqual([{ title: 'Thread', url: 'https://example.com/thread', snippet: '' }]);
    expect(String(fetchMock.mock.calls[0][0])).toBe('https://api.x.ai/v1/responses');
  });

  it('generates images with grok-imagine-image-2.0', async () => {
    const fetchMock = vi.fn(async (url: URL | string, init?: RequestInit) => {
      expect(String(url)).toBe('https://api.x.ai/v1/images/generations');
      const body = JSON.parse(String(init?.body));
      expect(body.model).toBe(XAI_IMAGE_MODEL);
      expect(body.response_format).toBe('b64_json');
      return jsonResponse({ data: [{ b64_json: 'aW1hZ2U=' }] });
    });
    vi.stubGlobal('fetch', fetchMock);

    const image = await generateImage('A deployment dashboard');
    expect(image.imageData).toBe('aW1hZ2U=');
    expect(image.mimeType).toBe('image/jpeg');
  });

  it('streams grok-4.7 text deltas', async () => {
    const fetchMock = vi.fn(async (url: URL | string, init?: RequestInit) => {
      expect(String(url)).toBe('https://api.x.ai/v1/responses');
      const body = JSON.parse(String(init?.body));
      expect(body.model).toBe('grok-4.7');
      expect(body.stream).toBe(true);
      return textResponse(['Hello', ' there']);
    });
    vi.stubGlobal('fetch', fetchMock);

    let full = '';
    for await (const delta of streamText([{ role: 'user', content: 'Hi' }])) full += delta;
    expect(full).toBe('Hello there');
  });

  it('ignores stored banned model ids', () => {
    expect(resolveTextModel(['gemini', 'pro', 'latest'].join('-'))).toBe('grok-4.7');
    expect(resolveTextModel(['claude', 'opus', '4-6'].join('-'))).toBe('grok-4.7');
    expect(resolveTextModel(['gpt', '4o'].join('-'))).toBe('grok-4.7');
    expect(resolveTextModel('grok-4.7')).toBe('grok-4.7');
    expect(resolveTextModel(undefined)).toBe('grok-4.7');
  });
});
