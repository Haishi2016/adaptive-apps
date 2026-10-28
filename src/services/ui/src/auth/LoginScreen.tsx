import { Button, Card, Text } from '@fluentui/react-components';
import { useState } from 'react';
import { useAuthStore } from './store';

export function LoginScreen(): JSX.Element {
  const login = useAuthStore((state) => state.login);
  const error = useAuthStore((state) => state.error);
  const [redirecting, setRedirecting] = useState(false);

  return (
    <div className="auth-screen">
      <Card className="auth-card">
        <div className="brand-lockup">
          <div className="brand-glyph">A</div>
          <Text weight="semibold">Adaptive AI</Text>
        </div>
        <Text size={400} weight="semibold">Sign in to continue</Text>
        <Text size={200}>
          Keycloak provides local sign-in and Microsoft Entra sign-in when enabled by your administrator.
        </Text>
        <Button appearance="primary" disabled={redirecting} onClick={() => {
          setRedirecting(true);
          void login().finally(() => setRedirecting(false));
        }}>
          {redirecting ? 'Redirecting to sign in…' : 'Sign in'}
        </Button>
        {error ? <Text role="alert" className="error-text">{error}</Text> : null}
      </Card>
    </div>
  );
}
