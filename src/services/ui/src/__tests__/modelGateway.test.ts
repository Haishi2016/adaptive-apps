import { afterEach, describe, expect, it, vi } from 'vitest';
import { listModels } from '../api/client';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('gateway-only model discovery', () => {
  it.each([
    ['', '/models/v1/models'],
    ['/models/v1', '/models/v1/models'],
    ['/v1', '/v1/models'],
    [' /v1/ ', '/v1/models'],
    ['https://gateway.example/v1/', 'https://gateway.example/v1/models'],
  ])('GETs the exact native URL for configured base %j', async (configured, url) => {
    vi.stubEnv('VITE_GATEWAY_URL', configured);
    const model = { id: 'local', object: 'model' };
    const fetchMock = vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ object: 'list', data: [model] }),
      { headers: { 'Content-Type': 'application/json' } },
    ));
    vi.stubGlobal('fetch', fetchMock);

    expect(await listModels()).toEqual([model]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe(url);
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect(new Headers(init.headers).get('Accept')).toBe('application/json');
    expect(init.method ?? 'GET').toBe('GET');
  });

  it('surfaces gateway errors without retrying through the operational API', async () => {
    vi.stubEnv('VITE_GATEWAY_URL', 'https://gateway.example/v1');
    const fetchMock = vi.fn().mockResolvedValue(new Response('Unavailable', { status: 503 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(listModels()).rejects.toThrow('GET https://gateway.example/v1/models failed with 503');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe('https://gateway.example/v1/models');
  });
});
