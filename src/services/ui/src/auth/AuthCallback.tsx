import { Button, Spinner, Text } from '@fluentui/react-components';
import { useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuthStore } from './store';

/**
 * Renders at `/auth/callback`. Completes the PKCE code exchange against the
 * Keycloak, then returns to the app. On failure it surfaces the reason and a way
 * back to the sign-in screen.
 */
export function AuthCallback(): JSX.Element {
  const navigate = useNavigate();
  const status = useAuthStore((state) => state.status);
  const error = useAuthStore((state) => state.error);
  const handleCallback = useAuthStore((state) => state.handleCallback);
  const started = useRef(false);

  useEffect(() => {
    if (started.current) {
      return;
    }
    started.current = true;
    void handleCallback(window.location.href).then(() => {
      if (useAuthStore.getState().status === 'authenticated') navigate('/', { replace: true });
    });
  }, [handleCallback, navigate]);

  if (status === 'anonymous' && error) {
    return (
      <div className="auth-screen">
        <Text size={400} weight="semibold">
          Sign-in failed
        </Text>
        <Text className="error-text">{error}</Text>
        <Button appearance="primary" onClick={() => navigate('/', { replace: true })}>
          Back to sign in
        </Button>
      </div>
    );
  }

  return (
    <div className="auth-screen">
      <Spinner label="Completing sign-in…" />
    </div>
  );
}
