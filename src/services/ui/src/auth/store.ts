import { create } from 'zustand';
import { accessToken, beginLogin, clearSession, completeCallback, currentUser, logout, type AuthUser } from './oidc';

export type AuthStatus = 'unknown' | 'authenticated' | 'anonymous';

type AuthState = {
  status: AuthStatus;
  user?: AuthUser;
  error?: string;
  restore: () => Promise<void>;
  login: () => Promise<void>;
  handleCallback: (url: string) => Promise<void>;
  logout: () => Promise<void>;
};

export const useAuthStore = create<AuthState>((set) => ({
  status: 'unknown',
  user: undefined,
  error: undefined,

  restore: async () => {
    try {
      const token = await accessToken();
      if (!token) {
        await clearSession();
        set({ status: 'anonymous', user: undefined });
        return;
      }
      const user = await currentUser();
      set({ status: 'authenticated', user, error: undefined });
    } catch (error) {
      await clearSession();
      set({ status: 'anonymous', user: undefined, error: error instanceof Error ? error.message : 'Session restore failed' });
    }
  },

  login: async () => {
    set({ error: undefined });
    try {
      await beginLogin();
    } catch (error) {
      set({ error: error instanceof Error ? error.message : 'Login failed' });
    }
  },

  handleCallback: async (url) => {
    try {
      await completeCallback(url);
      const token = await accessToken();
      if (!token) throw new Error('Login did not establish a session.');
      const user = await currentUser();
      set({ status: 'authenticated', user, error: undefined });
    } catch (error) {
      await clearSession();
      set({ status: 'anonymous', user: undefined, error: error instanceof Error ? error.message : 'Login failed' });
    }
  },

  logout: async () => {
    set({ status: 'anonymous', user: undefined, error: undefined });
    try {
      await logout();
    } catch (error) {
      set({ error: error instanceof Error ? error.message : 'Keycloak logout failed' });
    }
  },
}));

window.addEventListener('adaptive:unauthorized', () => {
  if (useAuthStore.getState().status === 'authenticated') {
    useAuthStore.setState({
      status: 'anonymous', user: undefined, error: 'Your session ended. Please sign in again.',
    });
  }
});
