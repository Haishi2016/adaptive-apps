import { webcrypto } from 'node:crypto';
import { URLSearchParams as NativeURLSearchParams } from 'node:url';
import { http, HttpResponse } from 'msw';
import { afterEach, beforeEach, vi } from 'vitest';
import { acquireEntraUserToken } from '../auth/entra';
import { completeEntraPopupCallback } from '../auth/oidc';
import { server } from '../mocks/server';
import { graphAgent, linkedUser } from './graphFixtures';

const authority = 'https://login.microsoftonline.com/tenant-id/v2.0';
const tokenEndpoint = 'https://login.microsoftonline.com/tenant-id/oauth2/v2.0/token';

beforeEach(() => {
  vi.stubGlobal('crypto', webcrypto);
  vi.stubGlobal('URLSearchParams', NativeURLSearchParams);
  vi.stubEnv('VITE_KEYCLOAK_AUTHORITY', linkedUser.iss);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  sessionStorage.clear();
  localStorage.clear();
});

it.each(['valid', 'wrong state', 'wrong nonce'] as const)(
  'completes native cross-window PKCE with opener-only memory state: %s',
  async (outcome) => {
    sessionStorage.setItem('keycloak-session-fixture', 'unchanged-platform-session');
    const sessionBefore = { ...sessionStorage };
    const localBefore = { ...localStorage };
    let authorization: URL | undefined;
    let callbackUrl = '';
    let notifyFinished!: () => void;
    const notified = new Promise<void>((resolve) => { notifyFinished = resolve; });
    const popup = {
      closed: false,
      focus: vi.fn(),
      close: vi.fn(),
      location: {
        replace: vi.fn((url: string) => {
          authorization = new URL(url);
          callbackUrl = `${window.location.origin}/auth/entra-callback?code=fixture&state=${
            outcome === 'wrong state' ? 'unknown-state' : authorization.searchParams.get('state')}`;
          // Navigation happens before the native opener installs its listener.
          setTimeout(() => {
            void completeEntraPopupCallback(callbackUrl).then(notifyFinished);
          }, 0);
        }),
      },
    };
    vi.spyOn(window, 'open').mockReturnValue(popup as unknown as Window);
    vi.stubGlobal('opener', {
      postMessage: (data: unknown, targetOrigin: string) => {
        expect(targetOrigin).toBe(window.location.origin);
        expect(data).toEqual({ source: 'oidc-client', url: callbackUrl, keepOpen: false });
        // Only an authorization code and opaque state cross windows, never a
        // token, PKCE verifier, or the platform's Keycloak session.
        window.dispatchEvent(new MessageEvent('message', {
          data, origin: window.location.origin, source: popup as unknown as Window,
        }));
      },
    });
    server.use(http.get(`${authority}/.well-known/openid-configuration`, () => HttpResponse.json({
      issuer: authority,
      authorization_endpoint: 'https://login.microsoftonline.com/tenant-id/oauth2/v2.0/authorize',
      token_endpoint: tokenEndpoint,
      jwks_uri: 'https://login.microsoftonline.com/tenant-id/discovery/v2.0/keys',
    })));
    const exchange = vi.fn(async ({ request }: { request: Request }) => {
      const body = new URLSearchParams(await request.text());
      const params = authorization!.searchParams;
      expect(params.get('client_id')).toBe('spa-client-id');
      expect(params.get('response_type')).toBe('code');
      expect(params.get('scope')).toBe('openid profile api://blueprint-id/access_agent');
      expect(params.get('redirect_uri')).toBe(`${window.location.origin}/auth/entra-callback`);
      expect(params.get('code_challenge_method')).toBe('S256');
      const digest = await webcrypto.subtle.digest('SHA-256', new TextEncoder().encode(body.get('code_verifier')!));
      expect(Buffer.from(digest).toString('base64url')).toBe(params.get('code_challenge'));
      expect(body.get('grant_type')).toBe('authorization_code');
      expect(body.get('client_id')).toBe('spa-client-id');
      expect(body.has('client_secret')).toBe(false);
      const claims = {
        iss: authority, aud: 'spa-client-id', sub: 'entra-sub',
        tid: linkedUser.entra_tid, oid: linkedUser.entra_oid,
        exp: Math.floor(Date.now() / 1000) + 600, iat: Math.floor(Date.now() / 1000),
        ...(outcome === 'wrong nonce' ? { nonce: 'wrong-nonce' }
          : params.get('nonce') ? { nonce: params.get('nonce') } : {}),
      };
      const idToken = `${Buffer.from('{"alg":"RS256"}').toString('base64url')}.${
        Buffer.from(JSON.stringify(claims)).toString('base64url')}.fixture`;
      return HttpResponse.json({
        access_token: 'blueprint-user-assertion', id_token: idToken,
        token_type: 'Bearer', expires_in: 600,
      });
    });
    server.use(http.post(tokenEndpoint, exchange));
    const acquisition = acquireEntraUserToken(graphAgent, linkedUser);
    if (outcome === 'valid') {
      await expect(acquisition).resolves.toBe('blueprint-user-assertion');
      expect(exchange).toHaveBeenCalledOnce();
    } else {
      await expect(acquisition).rejects.toThrow(outcome === 'wrong state' ? /state/i : /nonce/i);
      expect(exchange).toHaveBeenCalledTimes(outcome === 'wrong state' ? 0 : 1);
    }
    await notified;
    expect(popup.close).toHaveBeenCalled();
    expect({ ...sessionStorage }).toEqual(sessionBefore);
    expect({ ...localStorage }).toEqual(localBefore);
  },
);
