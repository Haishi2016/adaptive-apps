import { webcrypto } from 'node:crypto';
import { URLSearchParams as NativeURLSearchParams } from 'node:url';
import { OidcClient, User, UserManager, WebStorageStateStore } from 'oidc-client-ts';
import { http, HttpResponse } from 'msw';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { oidcSettings } from '../auth/config';
import { accessToken, authenticatedFetch, beginLogin, clearSession, completeCallback, logout } from '../auth/oidc';
import { useAuthStore } from '../auth/store';
import { server } from '../mocks/server';

const authority = 'https://identity.example/realms/adaptive';

function user(expiresIn = 600): User {
  return new User({
    access_token: 'keycloak-access', id_token: 'keycloak-id', refresh_token: 'keycloak-refresh',
    token_type: 'Bearer', expires_at: Math.floor(Date.now() / 1000) + expiresIn,
    profile: { sub: 'local-user', iss: authority, aud: 'adaptive-ui', exp: 9999999999, iat: 1 },
  });
}

beforeEach(() => {
  vi.stubGlobal('crypto', webcrypto);
  vi.stubGlobal('URLSearchParams', NativeURLSearchParams);
  vi.stubEnv('VITE_AUTH_ENABLED', 'true');
  vi.stubEnv('VITE_KEYCLOAK_AUTHORITY', authority);
  vi.stubEnv('VITE_KEYCLOAK_CLIENT_ID', 'adaptive-ui');
});

afterEach(async () => {
  vi.restoreAllMocks();
  await clearSession();
  sessionStorage.clear();
  localStorage.clear();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  useAuthStore.setState({ status: 'unknown', user: undefined, error: undefined });
});

describe('native Keycloak login', () => {
  it('uses the SDK redirect without provider hints or broker parameters', async () => {
    const redirect = vi.spyOn(UserManager.prototype, 'signinRedirect').mockResolvedValue();
    localStorage.setItem('adaptive.providerToken', 'old-upstream-token');
    await beginLogin();
    expect(redirect).toHaveBeenCalledWith();
    expect(localStorage.getItem('adaptive.providerToken')).toBeNull();
  });

  it('lets the SDK reject missing or broker-wrapped state before exchanging a code', async () => {
    const token = vi.fn(() => HttpResponse.json({}));
    server.use(http.post(`${authority}/protocol/openid-connect/token`, token));
    await expect(completeCallback(`${window.location.origin}/auth/callback?code=x&state=broker.invalid`))
      .rejects.toThrow(/state/i);
    expect(token).not.toHaveBeenCalled();
  });

  it('performs a real SDK PKCE callback and persists only the Keycloak session', async () => {
    server.use(http.get(`${authority}/.well-known/openid-configuration`, () => HttpResponse.json({
      issuer: authority,
      authorization_endpoint: `${authority}/protocol/openid-connect/auth`,
      token_endpoint: `${authority}/protocol/openid-connect/token`,
      jwks_uri: `${authority}/protocol/openid-connect/certs`,
    })));
    const oidc = new OidcClient({
      ...oidcSettings(), stateStore: new WebStorageStateStore({ store: sessionStorage }),
    });
    const request = await oidc.createSigninRequest({ request_type: 'si:r' });
    const params = new URL(request.url).searchParams;
    expect(params.get('code_challenge_method')).toBe('S256');
    expect(params.get('provider')).toBeNull();
    const claims = {
      iss: authority, aud: 'adaptive-ui', sub: 'local-user',
      exp: Math.floor(Date.now() / 1000) + 600, iat: Math.floor(Date.now() / 1000),
      ...(params.get('nonce') ? { nonce: params.get('nonce') } : {}),
    };
    const idToken = `${Buffer.from('{"alg":"RS256"}').toString('base64url')}.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.fixture`;
    const exchange = vi.fn(async ({ request: tokenRequest }: { request: Request }) => {
      const body = new URLSearchParams(await tokenRequest.text());
      expect(body.get('code_verifier')).toBe(request.state.code_verifier);
      expect(body.get('grant_type')).toBe('authorization_code');
      expect(body.has('client_secret')).toBe(false);
      expect(body.has('provider')).toBe(false);
      return HttpResponse.json({ access_token: 'keycloak-access', id_token: idToken, refresh_token: 'keycloak-refresh', token_type: 'Bearer', expires_in: 600 });
    });
    server.use(http.post(`${authority}/protocol/openid-connect/token`, exchange));
    await useAuthStore.getState().handleCallback(`${window.location.origin}/auth/callback?code=fixture&state=${params.get('state')}`);
    expect(useAuthStore.getState().error).toBeUndefined();
    expect(exchange).toHaveBeenCalledOnce();
    expect(await accessToken()).toBe('keycloak-access');
    expect(useAuthStore.getState().status).toBe('authenticated');
    expect(useAuthStore.getState().user?.sub).toBe('local-user');
    expect(useAuthStore.getState().user?.iss).toBe(authority);
    expect(localStorage.getItem('adaptive.authToken')).toBeNull();
    await expect(completeCallback(`${window.location.origin}/auth/callback?code=fixture&state=${params.get('state')}`))
      .rejects.toThrow(/state/i);
    expect(exchange).toHaveBeenCalledOnce();
  });

  it('ends the Keycloak session with the ID token hint', async () => {
    vi.spyOn(UserManager.prototype, 'getUser').mockResolvedValue(user());
    const redirect = vi.spyOn(UserManager.prototype, 'signoutRedirect').mockResolvedValue();
    await logout();
    expect(redirect).toHaveBeenCalledWith({ id_token_hint: 'keycloak-id' });
  });

  it('restores the native user profile without a broker or operational API request', async () => {
    vi.spyOn(UserManager.prototype, 'getUser').mockResolvedValue(user());
    const fetchMock = vi.spyOn(globalThis, 'fetch');
    await useAuthStore.getState().restore();
    expect(useAuthStore.getState().status).toBe('authenticated');
    expect(useAuthStore.getState().user).toEqual(user().profile);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects a stored session from a different issuer', async () => {
    const wrongIssuer = user();
    wrongIssuer.profile.iss = 'https://other.example/realms/adaptive';
    vi.spyOn(UserManager.prototype, 'getUser').mockResolvedValue(wrongIssuer);
    await useAuthStore.getState().restore();
    expect(useAuthStore.getState().status).toBe('anonymous');
    expect(useAuthStore.getState().user).toBeUndefined();
    expect(useAuthStore.getState().error).toMatch(/session is invalid/i);
  });
});

describe('authenticated requests', () => {
  it('shares one refresh across concurrent requests and uses the renewed bearer', async () => {
    vi.spyOn(UserManager.prototype, 'getUser').mockResolvedValue(user(-1));
    let finish!: (value: User) => void;
    const refresh = vi.spyOn(UserManager.prototype, 'signinSilent').mockReturnValue(new Promise((resolve) => { finish = resolve; }));
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response('{}'));
    const first = authenticatedFetch('/v1/agents');
    const second = authenticatedFetch('/models/v1/models');
    await vi.waitFor(() => expect(refresh).toHaveBeenCalledOnce());
    finish(user());
    await Promise.all([first, second]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    for (const [, init] of fetchMock.mock.calls) {
      expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer keycloak-access');
    }
  });

  it('does not use old broker or static tokens when Keycloak auth is enabled', async () => {
    vi.spyOn(UserManager.prototype, 'getUser').mockResolvedValue(null);
    vi.stubEnv('VITE_AUTH_TOKEN', 'static-token');
    localStorage.setItem('adaptive.authToken', 'old-broker-token');
    const fetchMock = vi.spyOn(globalThis, 'fetch');
    await expect(authenticatedFetch('/v1/agents')).rejects.toThrow(/sign in/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('fails closed on refresh failure without making the application request', async () => {
    vi.spyOn(UserManager.prototype, 'getUser').mockResolvedValue(user(-1));
    vi.spyOn(UserManager.prototype, 'signinSilent').mockRejectedValue(new Error('Refresh rejected'));
    const remove = vi.spyOn(UserManager.prototype, 'removeUser').mockResolvedValue();
    const fetchMock = vi.spyOn(globalThis, 'fetch');
    useAuthStore.setState({ status: 'authenticated' });
    await expect(authenticatedFetch('/v1/agents')).rejects.toThrow('Refresh rejected');
    expect(remove).toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(useAuthStore.getState().status).toBe('anonymous');
  });

  it('does not restore a session when a refresh completes after logout', async () => {
    vi.spyOn(UserManager.prototype, 'getUser').mockResolvedValue(user(-1));
    let finish!: (value: User) => void;
    const refresh = vi.spyOn(UserManager.prototype, 'signinSilent').mockReturnValue(new Promise((resolve) => { finish = resolve; }));
    const fetchMock = vi.spyOn(globalThis, 'fetch');
    const request = authenticatedFetch('/v1/agents');
    const rejected = expect(request).rejects.toThrow(/session ended/i);
    await vi.waitFor(() => expect(refresh).toHaveBeenCalledOnce());
    await clearSession();
    finish(user());
    await rejected;
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('clears a rejected session without replaying a mutation', async () => {
    vi.spyOn(UserManager.prototype, 'getUser').mockResolvedValue(user());
    const remove = vi.spyOn(UserManager.prototype, 'removeUser').mockResolvedValue();
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { status: 401 }));
    useAuthStore.setState({ status: 'authenticated' });
    await authenticatedFetch('/v1/agents', { method: 'POST', body: '{}' });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(remove).toHaveBeenCalledOnce();
    expect(useAuthStore.getState().status).toBe('anonymous');
  });
});
