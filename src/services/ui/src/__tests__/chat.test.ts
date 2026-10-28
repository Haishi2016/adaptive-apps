import { vi } from 'vitest';
import { streamChatCompletion, generateImage } from '../api/chat';
import { modelBaseUrl } from '../api/client';

it.each([
  ['', '/models/v1'],
  ['   ', '/models/v1'],
  ['/models/v1', '/models/v1'],
  ['/v1', '/v1'],
  [' /v1/ ', '/v1'],
  ['https://gateway.example/v1/', 'https://gateway.example/v1'],
])('uses the complete configured model API base %j', (configured, expected) => {
  vi.stubEnv('VITE_GATEWAY_URL', configured);
  try {
    expect(modelBaseUrl()).toBe(expected);
  } finally {
    vi.unstubAllEnvs();
  }
});

describe('streamChatCompletion', () => {
  it.each([
    ['HTML fallback', '<html>SPA</html>', 'text/html', 'Expected a native chat'],
    ['native error', 'data: {"error":{"message":"Model unavailable"}}\n\n', 'text/event-stream', 'Model unavailable'],
    ['truncated stream', 'data: {"choices":[{"delta":{"content":"Partial"}}]}\n\n', 'text/event-stream', 'without [DONE]'],
  ])('rejects %s rather than reporting a successful empty response', async (_, body, contentType, message) => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(body, {
      headers: { 'Content-Type': contentType },
    }));
    vi.stubGlobal('fetch', fetchMock);
    try {
      await expect(streamChatCompletion({
        model: 'local', messages: [{ role: 'user', content: 'Hello' }], onDelta: () => undefined,
      })).rejects.toThrow(message);
    } finally {
      vi.unstubAllGlobals();
    }
  });
  it.each([
    ['', '/models/v1'],
    ['/models/v1', '/models/v1'],
    ['/v1', '/v1'],
  ])('handles native SSE through configured base %j and reports the model', async (configured, base) => {
    vi.stubEnv('VITE_GATEWAY_URL', configured);
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          encoder.encode('data: {"model":"qwen2.5-7b-instruct","choices":[{"delta":{"content":"Hel'),
        );
        controller.enqueue(
          encoder.encode(
            'lo"}}]}\n\ndata: {"model":"qwen2.5-7b-instruct","choices":[{"delta":{"content":" world"}}]}',
          ),
        );
        controller.enqueue(encoder.encode('\n\ndata: [DONE]\n\n'));
        controller.close();
      },
    });
    const fetchMock = vi.fn().mockResolvedValue(new Response(stream, {
      status: 200, headers: { 'Content-Type': 'text/event-stream' },
    }));
    vi.stubGlobal('fetch', fetchMock);
    const deltas: string[] = [];
    const models: string[] = [];

    await streamChatCompletion({
      model: 'qwen2.5-7b-instruct',
      messages: [{ role: 'user', content: 'Say hello' }],
      onDelta: (delta) => deltas.push(delta),
      onModel: (model) => models.push(model),
    });

    expect(deltas).toEqual(['Hello', ' world']);
    expect(models).toEqual(['qwen2.5-7b-instruct']);
    expect(fetchMock).toHaveBeenCalledWith(
      `${base}/chat/completions`,
      expect.objectContaining({ method: 'POST' }),
    );
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });
});

describe('generateImage', () => {
  it.each([
    ['', '/models/v1'],
    ['/models/v1', '/models/v1'],
    ['/v1', '/v1'],
  ])('posts to the native images endpoint through configured base %j', async (configured, base) => {
    vi.stubEnv('VITE_GATEWAY_URL', configured);
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ data: [{ b64_json: 'AAAA' }] }), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const src = await generateImage({ model: 'gpt-image-2', prompt: 'a red cube', size: '1024x1024' });

    expect(src).toBe('data:image/png;base64,AAAA');
    expect(fetchMock).toHaveBeenCalledWith(
      `${base}/images/generations`,
      expect.objectContaining({ method: 'POST' }),
    );
    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(body).toMatchObject({ model: 'gpt-image-2', prompt: 'a red cube', size: '1024x1024' });
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('surfaces the gateway error body when the model does not support images', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response('model does not support image generation', { status: 400 }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      generateImage({ model: 'qwen2.5-7b-instruct', prompt: 'a cat' }),
    ).rejects.toThrow(/400: model does not support image generation/);
    vi.unstubAllGlobals();
  });
});
