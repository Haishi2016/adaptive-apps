import { UserManager, WebStorageStateStore, type User } from 'oidc-client-ts';
import { authEnabled, embeddedMode, oidcSettings } from './config';

export type AuthUser = User['profile'];

let manager: UserManager | undefined;
let renewal: Promise<User | null> | undefined;
let sessionVersion = 0;

export function authSessionVersion(): number {
  return sessionVersion;
}

function client(): UserManager {
  manager ??= new UserManager({
    ...oidcSettings(),
    userStore: new WebStorageStateStore({ store: sessionStorage }),
    stateStore: new WebStorageStateStore({ store: sessionStorage }),
  });
  return manager;
}

export async function clearSession(): Promise<void> {
  sessionVersion += 1;
  localStorage.removeItem('adaptive.authToken');
  localStorage.removeItem('adaptive.providerToken');
  sessionStorage.removeItem('adaptive.refreshToken');
  sessionStorage.removeItem('adaptive.authFlow');
  await manager?.removeUser();
}

export async function beginLogin(): Promise<void> {
  await clearSession();
  await client().clearStaleState();
  // Keycloak owns provider selection and availability in both cluster modes.
  await client().signinRedirect();
}

export async function completeCallback(url: string): Promise<void> {
  await client().signinRedirectCallback(url);
}

export async function completeEntraPopupCallback(url: string): Promise<void> {
  // This native callback only notifies the opener; its tenant-specific manager
  // validates state and exchanges the code without altering the Keycloak user.
  await client().signinPopupCallback(url);
}

export async function logout(): Promise<void> {
  const oidc = client();
  const user = await oidc.getUser();
  await clearSession();
  await oidc.signoutRedirect({ id_token_hint: user?.id_token });
}

export async function accessToken(): Promise<string | undefined> {
  const version = sessionVersion;
  const oidc = client();
  let user = await oidc.getUser();
  if (!user) return undefined;
  try {
    if ((user.expires_in ?? 0) <= 30) {
      if (!user.refresh_token) throw new Error('Your session ended. Please sign in again.');
      // Concurrent API/model requests must not redeem a rotating refresh token twice.
      renewal ??= oidc.signinSilent().finally(() => { renewal = undefined; });
      user = await renewal;
    }
    if (version !== sessionVersion || !user?.access_token || user.expired !== false) {
      throw new Error('Your session ended. Please sign in again.');
    }
    return user.access_token;
  } catch (error) {
    await clearSession();
    window.dispatchEvent(new CustomEvent('adaptive:unauthorized'));
    throw error;
  }
}

export async function authenticatedFetch(url: string, init?: RequestInit): Promise<Response> {
  if (embeddedMode()) {
    const headers = new Headers(init?.headers);
    headers.delete('Authorization');
    return fetch(url, { ...init, headers, credentials: 'same-origin' });
  }
  const token = authEnabled()
    ? await accessToken()
    : localStorage.getItem('adaptive.authToken') ?? import.meta.env.VITE_AUTH_TOKEN;
  if (authEnabled() && !token) {
    window.dispatchEvent(new CustomEvent('adaptive:unauthorized'));
    throw new Error('Please sign in before making this request.');
  }
  const headers = new Headers(init?.headers);
  if (token) headers.set('Authorization', `Bearer ${token}`);
  const response = await fetch(url, { ...init, headers });
  if (response.status === 401) {
    if (authEnabled()) await clearSession();
    window.dispatchEvent(new CustomEvent('adaptive:unauthorized'));
  }
  return response;
}

export async function currentUser(): Promise<AuthUser> {
  const user = await client().getUser();
  if (!user || user.expired !== false || !user.profile.sub
      || user.profile.iss !== oidcSettings().authority) {
    throw new Error('The signed-in OpenID Connect session is invalid.');
  }
  return user.profile;
}
