import { Spinner, Text } from '@fluentui/react-components';
import { useEffect, useRef, useState } from 'react';
import { completeEntraPopupCallback } from './oidc';

export function EntraCallback(): JSX.Element {
  const started = useRef(false);
  const [error, setError] = useState<string>();
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void completeEntraPopupCallback(window.location.href).catch((reason: unknown) => {
      setError(reason instanceof Error ? reason.message : 'Entra popup callback failed.');
    });
  }, []);
  return <div className="auth-screen">
    {error ? <Text role="alert">{error} Close this popup and start a new conversation.</Text>
      : <Spinner label="Completing Entra sign-in…" />}
  </div>;
}
