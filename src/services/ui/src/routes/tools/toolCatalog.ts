import type { AgentToolRef, ImpersonationMode } from '../../api/client';

export const identityModeLabels: Record<ImpersonationMode, string> = {
  app: 'Agent app identity',
  endUserOBO: 'Signed-in user (OBO)',
  agentUser: 'Agent worker user',
};

export function authTypeLabel(authType: AgentToolRef['authType']): string {
  return authType === 'entra' ? 'Microsoft Entra' : 'No authentication';
}

export function executionIdentityLabel(identity: AgentToolRef['executionIdentity'], builtin = false): string {
  if (builtin) return 'Native Graph tool uses request-local user delegation; app identity cannot call /me.';
  return identity === 'server'
    ? 'Downstream server workload identity — no caller delegation. The selected identity authenticates only at the MCP boundary.'
    : 'MCP caller identity — downstream resource identity depends on the server; resource delegation is not implied.';
}
