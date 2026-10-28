import { afterEach, describe, expect, it, vi } from 'vitest';
import { authEnabled, oidcSettings } from '../auth/config';

afterEach(() => vi.unstubAllEnvs());

describe('Keycloak configuration', () => {
  it('keeps development auth opt-in and requires an explicit issuer', () => {
    vi.stubEnv('VITE_AUTH_ENABLED', '');
    vi.stubEnv('VITE_KEYCLOAK_AUTHORITY', '');
    expect(authEnabled()).toBe(false);
    expect(oidcSettings).toThrow(/VITE_KEYCLOAK_AUTHORITY/);
  });

  it('uses one public client and standard code flow, without upstream Entra scopes', () => {
    vi.stubEnv('VITE_KEYCLOAK_AUTHORITY', ' https://identity.example/realms/adaptive/ ');
    vi.stubEnv('VITE_KEYCLOAK_CLIENT_ID', '');
    expect(oidcSettings()).toMatchObject({
      authority: 'https://identity.example/realms/adaptive',
      client_id: 'adaptive-ui',
      response_type: 'code',
      scope: 'openid profile',
      redirect_uri: `${window.location.origin}/auth/callback`,
      post_logout_redirect_uri: window.location.origin,
      automaticSilentRenew: false,
    });
  });

  it.each(['http://identity.example/realms/adaptive', 'https://user:pass@identity.example', 'https://identity.example?realm=x', 'https://identity.example#realm'])(
    'rejects an unsafe issuer: %s', (authority) => {
      vi.stubEnv('VITE_KEYCLOAK_AUTHORITY', authority);
      expect(oidcSettings).toThrow(/HTTPS/);
    },
  );
});
