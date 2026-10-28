import { InMemoryWebStorage, UserManager, WebStorageStateStore } from 'oidc-client-ts';
import type { Agent } from '../api/client';
import type { AuthUser } from './oidc';

export function linkedEntraUser(user?: AuthUser): boolean {
  return typeof user?.entra_tid === 'string' && Boolean(user.entra_tid)
    && typeof user.entra_oid === 'string' && Boolean(user.entra_oid);
}

export async function acquireEntraUserToken(agent: Agent, user: AuthUser): Promise<string> {
  const identity = agent.identity;
  if (!identity?.graphDelegation || !identity.entraTenantId || !identity.oboClientId
      || !identity.blueprintId || !linkedEntraUser(user)
      || user.entra_tid !== identity.entraTenantId) {
    throw new Error('OBO requires a configured Entra client and an administrator-linked user in the agent tenant.');
  }
  const redirect = `${window.location.origin}/auth/entra-callback`;
  const manager = new UserManager({
    authority: `https://login.microsoftonline.com/${encodeURIComponent(identity.entraTenantId)}/v2.0`,
    client_id: identity.oboClientId,
    redirect_uri: redirect,
    popup_redirect_uri: redirect,
    response_type: 'code',
    scope: `openid profile api://${identity.blueprintId}/access_agent`,
    loadUserInfo: false,
    automaticSilentRenew: false,
    userStore: new WebStorageStateStore({ store: new InMemoryWebStorage() }),
    stateStore: new WebStorageStateStore({ store: new InMemoryWebStorage() }),
  });
  try {
    const result = await manager.signinPopup({ prompt: 'select_account', nonce: crypto.randomUUID() });
    if (result.profile.tid !== user.entra_tid || result.profile.oid !== user.entra_oid) {
      throw new Error('The Entra account does not match the administrator-linked platform user. No invocation was sent.');
    }
    if (!result.access_token || result.expired !== false) {
      throw new Error('Entra sign-in did not return a usable user assertion.');
    }
    return result.access_token;
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'Unknown Entra error';
    throw new Error(`Entra sign-in failed or was cancelled. Consent or Conditional Access may require action: ${reason}`);
  } finally {
    await manager.removeUser();
  }
}
