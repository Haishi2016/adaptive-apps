import { Field, Select, Text } from '@fluentui/react-components';
import { useQuery } from '@tanstack/react-query';
import { useEffect } from 'react';
import { Agent, AgentVersion, listAgentVersions } from '../../api/client';

export function defaultRelease(agent: Agent, releases: AgentVersion[]): string | undefined {
  const available = releases.filter((release) => release.status === 'Available' && release.endpoint);
  for (const version of [agent.activeVersion, agent.requestedActiveVersion]) {
    if (available.some((release) => release.version === version)) return version ?? undefined;
  }
  if (agent.activeVersion) return undefined;
  return available.map((release) => release.version).sort()[0];
}

export function AgentReleases({ name, agent, version, onSelect, disabled }: {
  name: string;
  agent?: Agent;
  version?: string;
  onSelect: (version: string) => void;
  disabled: boolean;
}): JSX.Element {
  const releases = useQuery({ queryKey: ['agent-versions', name], queryFn: () => listAgentVersions(name) });
  useEffect(() => {
    if (!disabled && !version && agent && releases.data) {
      const selected = defaultRelease(agent, releases.data);
      if (selected && selected !== agent.activeVersion) onSelect(selected);
    }
  }, [agent, disabled, onSelect, releases.data, version]);
  const selected = version ?? agent?.activeVersion;
  const candidate = selected && selected !== agent?.activeVersion && selected !== agent?.requestedActiveVersion;
  return (
    <section aria-label="Release readiness">
      <Text block>Requested active: {agent?.requestedActiveVersion ?? '—'}</Text>
      <Text block>Effective active: {agent?.activeVersion ?? '—'} · {agent?.phase ?? 'Unknown'}</Text>
      {!agent?.activeVersion ? <Text block>No effective active release. Select an Available release; selection does not promote it.</Text>
        : !agent.endpoint ? <Text block>Effective active endpoint unavailable. No release fallback.</Text> : null}
      {candidate ? <Text block>UI-selected candidate: {selected}. No active promotion. Available candidates are ordered by release ID, not age.</Text> : null}
      <Field label="Invocation release">
        <Select value={version ?? ''} disabled={disabled || !releases.data} onChange={(_, data) => onSelect(data.value)}>
          <option value="">{agent?.activeVersion ? `Effective active release · ${agent.activeVersion}` : 'No effective active release'}</option>
          {version && !releases.data?.some((release) => release.version === version)
            ? <option value={version} disabled>{version} · unavailable</option> : null}
          {releases.data?.map((release) => <option key={release.version} value={release.version}
            disabled={release.status !== 'Available' || !release.endpoint}>
            {release.version} · {release.status}
          </option>)}
        </Select>
      </Field>
      <Text block>Stateless requests: earlier messages are display-only, not model context. Start a new conversation to change releases.</Text>
      {releases.error ? <Text role="alert">Release inventory unavailable.</Text> : null}
      {releases.data?.map((release) => <Text block key={release.version}>
        {release.version} · {release.status}{release.requestedActive ? ' · requested' : ''}{release.active ? ' · effective' : ''}
      </Text>)}
    </section>
  );
}
