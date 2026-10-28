import { Badge, Card, Text } from '@fluentui/react-components';
import { AgentIdentity } from '../api/client';
import { useConnectivityFaultStore } from '../state/connectivityFault';

export type AgentInfoPanelProps = {
  identity?: AgentIdentity | null;
  image?: string | null;
  kind?: 'hosted' | 'prompt';
  protocol?: 'responses';
};

const missing = 'Not provisioned';

export function AgentInfoPanel({ identity, image, kind, protocol }: AgentInfoPanelProps): JSX.Element {
  const mode = useConnectivityFaultStore((state) => state.enabled);

  return (
    <Card className="info-panel" appearance="filled-alternative">
      <div className="panel-title-row">
        <Text as="h2" weight="semibold" size={400}>
          Agent info
        </Text>
        {kind ? <Badge appearance="tint">{kind}</Badge> : null}
      </div>
      <dl className="info-list">
        <div>
          <dt>Local agent identity</dt>
          <dd data-testid="agent-identity-value">{identity?.keycloakClientId || missing}</dd>
        </div>
        <div>
          <dt>Entra agent identity</dt>
          <dd data-testid="entra-identity-value">{identity?.entraClientId || missing}</dd>
        </div>
        <div>
          <dt>Entra agent blueprint</dt>
          <dd data-testid="agent-blueprint-value">{identity?.blueprintId || missing}</dd>
        </div>
        {image ? (
          <div>
            <dt>Code asset</dt>
            <dd>{image}</dd>
          </div>
        ) : null}
        {kind ? (
          <div>
            <dt>Kind</dt>
            <dd>{kind}</dd>
          </div>
        ) : null}
        {protocol ? (
          <div>
            <dt>Protocol</dt>
            <dd>{protocol}</dd>
          </div>
        ) : null}
      </dl>
      <Text size={200}>Local identity is the Keycloak application client; it has no Entra blueprint.
        {mode ? ' Cloud outage injection is enabled; any displayed Entra IDs are retained configuration.'
          : ' Entra identity, when provisioned, is for cloud targets; connectivity is not guaranteed.'}</Text>
    </Card>
  );
}
