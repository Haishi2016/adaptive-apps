import {
  Badge,
  Button,
  Card,
  CardHeader,
  Field,
  Input,
  Select,
  Spinner,
  Text,
  Textarea,
} from '@fluentui/react-components';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { getAgentCard, testA2ACall, validateAgentCard } from '../../api/client';
import { useConnectivityFaultStore } from '../../state/connectivityFault';

export function A2APanel({ name }: { name: string }): JSX.Element {
  const faultEnabled = useConnectivityFaultStore((state) => state.enabled);
  const cardQuery = useQuery({
    queryKey: ['agent-card', name],
    queryFn: () => getAgentCard(name),
    enabled: Boolean(name),
    refetchInterval: 5_000,
  });
  const [selectedPeer, setSelectedPeer] = useState('');
  const [testMessage, setTestMessage] = useState('Say hello.');
  const card = cardQuery.data;
  const peer = card?.peers.find((item) => item.name === selectedPeer) ?? card?.peers[0];
  const validateMutation = useMutation({ mutationFn: () => validateAgentCard(name) });
  const testMutation = useMutation({
    mutationFn: () => testA2ACall(name, { peer: peer?.name ?? '', message: testMessage }),
  });

  if (cardQuery.isLoading) {
    return <Spinner label="Loading A2A configuration" />;
  }
  if (cardQuery.isError || !card) {
    return <Text className="error-text">Failed to load A2A configuration.</Text>;
  }

  const cloudPeerDisabled = faultEnabled
    && peer?.cardUrl?.startsWith('http') && !peer.cardUrl.includes('.svc.');
  const reconciling = card.observedCardHash && card.resolvedCardHash !== card.observedCardHash;
  const validation = validateMutation.data;
  const result = testMutation.data;

  return (
    <div className="a2a-panel">
      <div className="a2a-toolbar">
        <Text weight="semibold">A2A configuration</Text>
        <Badge appearance="tint">{card.enabled ? 'Enabled' : 'Disabled'}</Badge>
        {reconciling ? <Badge color="warning">Reconciling</Badge> : null}
        <Text className="muted-text">Read-only configuration. Validation and test calls do not change it.</Text>
        <Button disabled={validateMutation.isPending} onClick={() => validateMutation.mutate()}>
          Validate live card
        </Button>
      </div>
      {validateMutation.error ? <Text role="alert" className="error-text">{validateMutation.error.message}</Text> : null}
      {testMutation.error ? <Text role="alert" className="error-text">{testMutation.error.message}</Text> : null}
      <div className="a2a-grid">
        <Card appearance="filled-alternative" className="a2a-card-col">
          <CardHeader header={<Text weight="semibold">Declared card</Text>} />
          <pre className="a2a-json-preview">{JSON.stringify(card.declared, null, 2)}</pre>
        </Card>
        <Card appearance="filled-alternative" className="a2a-card-col">
          <CardHeader header={<Text weight="semibold">Live resolved card</Text>} />
          <Field label="Public well-known URL"><Input readOnly value={card.cardUrl ?? ''} /></Field>
          <Field label="A2A base URL"><Input readOnly value={card.a2aBaseUrl ?? ''} /></Field>
          <Field label="Connection string"><Input readOnly value={card.connectionString ?? ''} /></Field>
          <pre className="a2a-json-preview" data-testid="a2a-resolved-card">
            {JSON.stringify(card.resolved, null, 2)}
          </pre>
          {validation ? (
            <div className="a2a-validation">
              <Text className={validation.valid ? 'success-text' : 'error-text'}>
                {validation.valid ? 'Live card matches declared card.' : validation.message ?? `Drift detected (${validation.differences?.length ?? 0})`}
              </Text>
              <ul>
                {validation.differences?.map((diff) => (
                  <li key={diff.path}>
                    <code>{diff.path}</code>: declared <code>{JSON.stringify(diff.declared)}</code> ≠ live <code>{JSON.stringify(diff.live)}</code>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </Card>
        <Card appearance="filled-alternative" className="a2a-card-col">
          <CardHeader header={<Text weight="semibold">Trust + Test</Text>} />
          <Text weight="semibold">Allowed callers</Text>
          <pre className="a2a-json-preview">{JSON.stringify(card.allowedCallers, null, 2)}</pre>
          <Text weight="semibold">Outbound peers</Text>
          <pre className="a2a-json-preview">{JSON.stringify(card.peers, null, 2)}</pre>
          {card.blueprintConsentPending ? <Badge color="warning">Admin consent required</Badge> : null}
          <Field label="Test peer">
            <Select value={peer?.name ?? ''} onChange={(_, data) => setSelectedPeer(data.value)}>
              {!peer ? <option value="">No configured peers</option> : null}
              {card.peers.map((item) => <option key={item.name} value={item.name}>{item.name}</option>)}
            </Select>
          </Field>
          <Field label="Test message">
            <Textarea value={testMessage} onChange={(_, data) => setTestMessage(data.value)} />
          </Field>
          <Button
            appearance="primary"
            disabled={!card.enabled || !peer || !testMessage.trim() || testMutation.isPending || Boolean(cloudPeerDisabled)}
            onClick={() => testMutation.mutate()}
          >
            Send
          </Button>
          {cloudPeerDisabled ? <Text className="muted-text">Selected peer is cloud-only — unavailable in red-button.</Text> : null}
          {result ? (
            <div className="a2a-test-result" data-testid="a2a-test-result">
              <Text weight="semibold">{result.ok ? 'Response' : 'Error'}</Text>
              <pre>{result.responseText ?? result.errorMessage ?? ''}</pre>
              {result.traceId ? <Text className="muted-text">traceId: {result.traceId}</Text> : null}
            </div>
          ) : null}
        </Card>
      </div>
    </div>
  );
}
