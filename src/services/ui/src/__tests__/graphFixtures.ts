import type { Agent, AgentToolRef } from '../api/client';
import type { AuthUser } from '../auth/oidc';

export const graphTool: AgentToolRef = {
  type: 'builtin', name: 'graph-me', connectionRef: 'demo-graph', serverLabel: 'Graph profile',
  requireApproval: 'never', authType: 'entra', audience: 'https://graph.microsoft.com',
  identityModes: ['app', 'endUserOBO', 'agentUser'], executionIdentity: 'caller',
};

export const graphAgent: Agent = {
  name: 'graph-demo', type: 'prompt', phase: 'Ready',
  endpoint: '/agents/graph-demo/responses', tools: [graphTool],
  identity: {
    blueprintId: 'blueprint-id', entraClientId: 'agent-id', entraTenantId: 'tenant-id',
    oboClientId: 'spa-client-id', graphDelegation: true, agentUserId: 'worker-id',
  },
};

export const linkedUser: AuthUser = {
  iss: 'https://keycloak.example/realms/adaptive', sub: 'local-sub',
  aud: 'adaptive-ui', exp: 9999999999, iat: 1,
  entra_tid: 'tenant-id', entra_oid: 'linked-object-id',
};
