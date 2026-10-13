import { Agent, AgentVersion } from '../api/client';
import { defaultRelease } from '../routes/agents/AgentReleases';

const agent: Agent = {
  name: 'demo', type: 'prompt', activeVersion: null, requestedActiveVersion: null, endpoint: null,
};
const release = (version: string, status: AgentVersion['status'] = 'Available'): AgentVersion => ({
  name: 'demo', version, status, endpoint: `/agents/demo/versions/${version}/responses`,
  definitionDigest: null, active: false, requestedActive: false,
});

it('prefers the available effective release, then requested active', () => {
  const releases = [release('amber'), release('birch')];
  expect(defaultRelease({ ...agent, activeVersion: 'birch', requestedActiveVersion: 'amber' }, releases)).toBe('birch');
  expect(defaultRelease({ ...agent, requestedActiveVersion: 'birch' }, releases)).toBe('birch');
  expect(defaultRelease({ ...agent, activeVersion: 'unavailable', requestedActiveVersion: 'birch' }, releases)).toBe('birch');
});

it('selects the only Available candidate without active promotion', () => {
  expect(defaultRelease(agent, [release('candidate'), release('newer', 'Progressing')])).toBe('candidate');
  expect(agent.activeVersion).toBeNull();
});

it('uses explicit lexicographic release ordering, not inventory order or age', () => {
  expect(defaultRelease(agent, [release('zebra'), release('amber')])).toBe('amber');
  expect(defaultRelease(agent, [release('amber'), release('zebra')])).toBe('amber');
});

it('never falls back from an unavailable effective release or selects an endpointless candidate', () => {
  expect(defaultRelease({ ...agent, activeVersion: 'retired' }, [release('candidate')])).toBeUndefined();
  expect(defaultRelease(agent, [{ ...release('candidate'), endpoint: null }])).toBeUndefined();
});
