import { afterEach, describe, expect, it, vi } from 'vitest';
import { invokeAgent } from '../api/client';

const endpoint = '/agents/demo/responses';

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
  sessionStorage.clear();
});

describe('invocation identity', () => {
  it('rejects OBO before any request even if old provider tokens remain in storage', async () => {
    localStorage.setItem('adaptive.authToken', 'platform.token');
    localStorage.setItem('adaptive.providerToken', 'old-user-token');
    sessionStorage.setItem('adaptive.refreshToken', 'old-refresh-token');
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await expect(invokeAgent(endpoint, { input: 'hi' }, { impersonation: 'endUserOBO' }))
      .rejects.toThrow(/OBO requires an Entra user assertion/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each(['app', 'agentUser', undefined] as const)('preserves %s invocation without delegated headers', async (impersonation) => {
    localStorage.setItem('adaptive.authToken', 'platform.token');
    const fetchMock = vi.fn().mockResolvedValue(new Response('data: [DONE]\n\n', {
      headers: { 'Content-Type': 'text/event-stream' },
    }));
    vi.stubGlobal('fetch', fetchMock);
    await invokeAgent(endpoint, { input: 'hi' }, { impersonation });
    const headers = new Headers(fetchMock.mock.calls[0][1].headers);
    expect(headers.get('Authorization')).toBe('Bearer platform.token');
    expect(headers.get('X-Impersonation-Mode')).toBe(impersonation ?? null);
    expect(headers.has('X-Adaptive-User-Token')).toBe(false);
    expect(headers.has('X-Entra-User-Token')).toBe(false);
    expect([...headers.keys()].some((key) => key.startsWith('x-client-'))).toBe(false);
  });

  it.each(['app', 'agentUser', undefined] as const)('forbids user tokens in %s mode before fetching', async (impersonation) => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await expect(invokeAgent(endpoint, {}, { impersonation, entraUserToken: 'user-assertion' }))
      .rejects.toThrow(/forbidden outside OBO/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('validates the mode before fetching', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await expect(invokeAgent(endpoint, {}, { impersonation: 'invalid' as 'app' })).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('forwards only the platform bearer and OBO assertion to native ingress', async () => {
    localStorage.setItem('adaptive.authToken', 'platform.token');
    const fetchMock = vi.fn().mockResolvedValue(new Response('data: [DONE]\n\n', {
      headers: { 'Content-Type': 'text/event-stream' },
    }));
    vi.stubGlobal('fetch', fetchMock);
    await invokeAgent(endpoint, { input: 'hi' }, { impersonation: 'endUserOBO', entraUserToken: 'entra.assertion' });
    expect(fetchMock.mock.calls[0][0]).toBe(endpoint);
    const headers = new Headers(fetchMock.mock.calls[0][1].headers);
    expect(headers.get('Authorization')).toBe('Bearer platform.token');
    expect(headers.get('X-Entra-User-Token')).toBe('entra.assertion');
    expect(headers.get('X-Impersonation-Mode')).toBe('endUserOBO');
    expect([...headers.keys()].some((key) => key.startsWith('x-client-'))).toBe(false);
  });
});
