import { User, UserManager } from 'oidc-client-ts';
import { afterEach, vi } from 'vitest';
import { acquireEntraUserToken } from '../auth/entra';
import { graphAgent, linkedUser } from './graphFixtures';

function entraUser(oid: unknown = linkedUser.entra_oid, tid: unknown = linkedUser.entra_tid): User {
  return new User({
    access_token: 'blueprint-user-assertion', token_type: 'Bearer',
    expires_at: Math.floor(Date.now() / 1000) + 600,
    profile: { sub: 'entra-sub', iss: 'https://login.microsoftonline.com/tenant-id/v2.0',
      aud: 'spa-client-id', exp: 9999999999, iat: 1, oid, tid },
  });
}

afterEach(() => vi.restoreAllMocks());

it('uses tenant-pinned native code/PKCE popup with blueprint scope and memory-only stores', async () => {
  let readUser: (() => Promise<User | null>) | undefined;
  vi.spyOn(UserManager.prototype, 'signinPopup').mockImplementation(async function (this: UserManager, args) {
    readUser = () => this.getUser();
    expect(args).toEqual({ prompt: 'select_account', nonce: expect.any(String) });
    expect(this.settings.authority).toBe('https://login.microsoftonline.com/tenant-id/v2.0');
    expect(this.settings.client_id).toBe('spa-client-id');
    expect(this.settings.response_type).toBe('code');
    expect(this.settings.disablePKCE).toBe(false);
    expect(this.settings.scope).toBe('openid profile api://blueprint-id/access_agent');
    expect(this.settings.popup_redirect_uri).toBe(`${window.location.origin}/auth/entra-callback`);
    const result = entraUser();
    await this.storeUser(result);
    return result;
  });
  const local = { ...localStorage };
  const session = { ...sessionStorage };
  expect(await acquireEntraUserToken(graphAgent, linkedUser)).toBe('blueprint-user-assertion');
  expect(await readUser?.()).toBeNull();
  expect({ ...localStorage }).toEqual(local);
  expect({ ...sessionStorage }).toEqual(session);
});

it.each([
  ['wrong object', 'another-user', linkedUser.entra_tid],
  ['wrong tenant', linkedUser.entra_oid, 'another-tenant'],
  ['missing object', undefined, linkedUser.entra_tid],
] as const)('rejects %s without email comparison', async (_, oid, tid) => {
  vi.spyOn(UserManager.prototype, 'signinPopup').mockResolvedValue(entraUser(oid ?? null, tid));
  await expect(acquireEntraUserToken(graphAgent, linkedUser)).rejects.toThrow(/does not match/);
});

it.each(['Popup closed by user', 'consent_required', 'interaction_required', 'access_denied'])('surfaces %s honestly', async (error) => {
  vi.spyOn(UserManager.prototype, 'signinPopup').mockRejectedValue(new Error(error));
  await expect(acquireEntraUserToken(graphAgent, linkedUser)).rejects.toThrow(error);
});

it('rejects unlinked local users before browser acquisition', async () => {
  const popup = vi.spyOn(UserManager.prototype, 'signinPopup');
  await expect(acquireEntraUserToken(graphAgent, { ...linkedUser, entra_oid: undefined }))
    .rejects.toThrow(/administrator-linked user/);
  expect(popup).not.toHaveBeenCalled();
});
