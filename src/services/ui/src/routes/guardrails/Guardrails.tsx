import { Badge, Spinner, Text } from '@fluentui/react-components';
import { useQuery } from '@tanstack/react-query';
import { getAgentGuardrails, getPlatformGuardrails, PolicyResource } from '../../api/client';

function ScopeNotice(): JSX.Element {
  return (
    <Text className="muted-text">
      Read-only configuration managed through Radius. Policies govern configured outbound model and remote-tool
      endpoints. PII and prompt-injection checks inspect request text, not streamed output, and do not redact.
      Local functions and direct network bypass are outside this boundary. Cloud enforcement is separate.
    </Text>
  );
}

function ResourceView({ policy }: { policy: PolicyResource }): JSX.Element {
  const owner = policy.namespace === 'adaptive-guardrails-platform' ? 'Platform-owned' : 'Application-owned';
  return (
    <section className="guardrails-panel">
      <Text size={200}><strong>{owner}</strong> · {policy.targets.length ? `Automatic targets: ${policy.targets.join(', ')}` : 'Explicitly attached to the agent'} · Default: deny</Text>
      <div className="guardrails-table-wrap">
        <table className="guardrails-table" aria-label={`${owner} policy rules`}>
          <thead><tr><th scope="col">Policy</th><th scope="col">Rule</th><th scope="col">Stage</th><th scope="col">Condition</th><th scope="col">Decision</th></tr></thead>
          {policy.bundle.policies.map((definition) => (
            <tbody key={definition.name}>
              {definition.rules.map((rule, index) => (
                <tr key={rule.name}>
                  {index === 0 ? <th scope="rowgroup" rowSpan={definition.rules.length}>
                    {definition.name}<div>Declared mode: {definition.mode ?? 'workload default (runtime unverified)'}</div>
                  </th> : null}
                  <td title={rule.description}>{rule.name}</td>
                  <td>{rule.stage === 'pre_input' ? 'Model request' : 'Remote tool'}</td>
                  <td><code>{rule.condition}</code></td>
                  <td><Badge size="small" appearance="tint" color={rule.action === 'allow' ? 'success' : 'warning'}>{rule.action}</Badge></td>
                </tr>
              ))}
            </tbody>
          ))}
        </table>
      </div>
      <details className="guardrails-revision">
        <summary>Revision</summary>
        <code>{policy.reference}</code>
      </details>
    </section>
  );
}

export function PlatformGuardrails(): JSX.Element {
  const query = useQuery({ queryKey: ['guardrails'], queryFn: getPlatformGuardrails });
  const config = query.data;
  return (
    <section className="page guardrails-panel">
      <Text as="h1" size={600} weight="semibold">Guardrails</Text>
      <ScopeNotice />
      {query.isLoading ? <Spinner label="Loading platform guardrails" /> : null}
      {query.error ? <Text role="alert">Failed to load guardrails: {query.error.message}</Text> : null}
      {config ? (
        <>
          <Text as="h2" size={500} weight="semibold">Radius policy resources</Text>
          <Text>Matching platform policies and agent attachments all apply. Application policies cannot override inherited restrictions.</Text>
          <Text>Runtime enforcement: {config.enforcementVerified ? 'verified' : 'unverified'}. Catalogue configuration is not rollout evidence.</Text>
          {config.policies.map((policy) => <ResourceView key={policy.reference} policy={policy} />)}
          {!config.policies.length ? <Text>No global policy resources configured. Agents may still have attached policies.</Text> : null}
        </>
      ) : null}
    </section>
  );
}

export function AgentGuardrails({ name, visible }: { name: string; visible: boolean }): JSX.Element {
  const query = useQuery({
    queryKey: ['agent-guardrails', name],
    queryFn: () => getAgentGuardrails(name),
    enabled: visible && Boolean(name),
  });
  const config = query.data;
  return (
    <section className="guardrails-panel" aria-label="Agent guardrails">
      <ScopeNotice />
      {query.isLoading ? <Spinner label="Loading agent guardrails" /> : null}
      {query.error ? <Text role="alert">Failed to load agent guardrails: {query.error.message}</Text> : null}
      {config ? (
        <>
          <Text weight="semibold">{config.name}</Text>
          <Text>Policies: {config.enabled ? 'configured' : 'none attached'}</Text>
          <Text>Runtime enforcement: {config.enforcementVerified ? 'verified' : 'unverified'}</Text>
          <Text>Runtime: {config.deployment ?? 'not deployed'} · {config.phase ?? 'not observed'}</Text>
          <Text size={200}>Shows policies for the selected concrete release, or effective active release before selection. These are desired policies; runtime status alone does not verify enforcement or completed policy rollout.</Text>
          <Text as="h2" size={400} weight="semibold">Inherited platform policies</Text>
          {config.inherited.map((policy) => <ResourceView key={policy.reference} policy={policy} />)}
          {!config.inherited.length ? <Text>No platform selector matches.</Text> : null}
          <Text as="h2" size={400} weight="semibold">Agent-specific policies</Text>
          {config.attached ? (
            <>
              <ResourceView policy={config.attached} />
              <Text>Effective enforced rule: matching platform policies AND attached bundle. Enforced deny overrides allow; audit-only decisions do not change enforced restrictions.</Text>
            </>
          ) : <Text>No agent-specific bundle selected.</Text>}
          {config.policy_sha256 ? <Text size={200}>Effective policy digest: {config.policy_sha256}</Text> : null}
          <Text>Enforcement decisions appear in Monitor when guardrail telemetry is available.</Text>
        </>
      ) : null}
    </section>
  );
}
