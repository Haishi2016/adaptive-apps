import { Spinner } from '@fluentui/react-components';
import { useEffect, type ReactNode } from 'react';
import { authEnabled } from './config';
import { LoginScreen } from './LoginScreen';
import { useAuthStore } from './store';

/**
 * Gates the app behind a signed-in user when `VITE_AUTH_ENABLED === 'true'`.
 * When disabled (default) it renders children unchanged, preserving the
 * static-token / mocked-backend behavior used in dev and tests.
 */
export function AuthGate({ children }: { children: ReactNode }): JSX.Element {
  const enabled = authEnabled();
  const status = useAuthStore((state) => state.status);
  const restore = useAuthStore((state) => state.restore);

  useEffect(() => {
    if (enabled) {
      void restore();
    }
  }, [enabled, restore]);

  if (!enabled) {
    return <>{children}</>;
  }
  if (status === 'authenticated') {
    return <>{children}</>;
  }
  if (status === 'anonymous') {
    return <LoginScreen />;
  }
  return (
    <div className="auth-screen">
      <Spinner label="Checking your session…" />
    </div>
  );
}
