import type { UserManagerSettings } from 'oidc-client-ts';

export function authEnabled(): boolean {
  return import.meta.env.VITE_AUTH_ENABLED === 'true';
}

export function embeddedMode(): boolean {
  return import.meta.env.VITE_EMBEDDED === 'true';
}

export function oidcSettings(): UserManagerSettings {
  const authority = import.meta.env.VITE_KEYCLOAK_AUTHORITY?.trim().replace(/\/+$/, '');
  if (!authority) {
    throw new Error('VITE_KEYCLOAK_AUTHORITY must specify the HTTPS Keycloak realm issuer.');
  }
  const url = new URL(authority);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
    throw new Error('Keycloak authority must be HTTPS without credentials, query or fragment.');
  }
  return {
    authority,
    client_id: import.meta.env.VITE_KEYCLOAK_CLIENT_ID?.trim() || 'adaptive-ui',
    redirect_uri: `${window.location.origin}/auth/callback`,
    post_logout_redirect_uri: window.location.origin,
    response_type: 'code',
    scope: 'openid profile',
    automaticSilentRenew: false,
    monitorSession: false,
    loadUserInfo: false,
    requestTimeoutInSeconds: 10,
  };
}
