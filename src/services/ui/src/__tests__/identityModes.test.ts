import { AgentSchema } from '../api/client';
import { allowedIdentityModes } from '../routes/agents/identityModes';
import { graphAgent, linkedUser } from './graphFixtures';

it('accepts a captured built-in without a server URL and enables the configured modes', () => {
  const agent = AgentSchema.parse(graphAgent);
  expect(agent.tools?.[0].type).toBe('builtin');
  expect(allowedIdentityModes(agent, false, linkedUser)).toEqual(['app', 'endUserOBO', 'agentUser']);
});

it.each([
  ['hosted', { ...graphAgent, type: 'hosted' as const }, linkedUser, ['app']],
  ['no linked user', graphAgent, undefined, ['app', 'agentUser']],
  ['wrong linked tenant', graphAgent, { ...linkedUser, entra_tid: 'other-tenant' }, ['app', 'agentUser']],
  ['no linked object', graphAgent, { ...linkedUser, entra_oid: '' }, ['app', 'agentUser']],
  ['no delegation', { ...graphAgent, identity: { ...graphAgent.identity, graphDelegation: false } }, linkedUser, ['app']],
  ['no SPA', { ...graphAgent, identity: { ...graphAgent.identity, oboClientId: null } }, linkedUser, ['app', 'agentUser']],
  ['no blueprint', { ...graphAgent, identity: { ...graphAgent.identity, blueprintId: null } }, linkedUser, ['app', 'agentUser']],
  ['no tenant', { ...graphAgent, identity: { ...graphAgent.identity, entraTenantId: null } }, linkedUser, ['app', 'agentUser']],
  ['no worker', { ...graphAgent, identity: { ...graphAgent.identity, agentUserId: null } }, linkedUser, ['app', 'endUserOBO']],
  ['no built-in', { ...graphAgent, tools: [] }, linkedUser, ['app']],
] as const)('honestly gates %s prerequisites', (_, agent, user, expected) => {
  expect(allowedIdentityModes(AgentSchema.parse(agent), false, user)).toEqual(expected);
});

it('keeps cloud-only identities unavailable during injected loss', () => {
  expect(allowedIdentityModes(graphAgent, true, linkedUser)).toEqual(['app']);
});

it('does not substitute application identity for an OBO-only tool during an outage', () => {
  const agent = { ...graphAgent, tools: [{ ...graphAgent.tools![0], identityModes: ['endUserOBO' as const] }] };
  expect(allowedIdentityModes(agent, true, linkedUser)).toEqual([]);
});
