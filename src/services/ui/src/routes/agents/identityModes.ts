import type { Agent, ImpersonationMode } from '../../api/client';
import { linkedEntraUser } from '../../auth/entra';
import type { AuthUser } from '../../auth/oidc';

export function allowedIdentityModes(agent: Agent | undefined, faultEnabled: boolean, user?: AuthUser): ImpersonationMode[] {
  if (!agent) return [];
  const tools = agent.tools?.filter((tool) => tool.authType === 'entra') ?? [];
  const allowed: ImpersonationMode[] = tools.every((tool) => tool.identityModes.includes('app'))
    ? ['app'] : [];
  const identity = agent.identity;
  if (agent.type !== 'prompt' || faultEnabled || !identity?.graphDelegation
      || !tools.some((tool) => tool.type === 'builtin' && tool.name === 'graph-me')) return allowed;
  // Existing MCP profiles and hosted images have no trusted delegated boundary.
  const supports = (selected: ImpersonationMode) => tools.every((tool) =>
    tool.type === 'builtin' && tool.identityModes.includes(selected));
  if (supports('endUserOBO') && identity.entraTenantId && identity.oboClientId && identity.blueprintId
      && linkedEntraUser(user) && user?.entra_tid === identity.entraTenantId) allowed.push('endUserOBO');
  if (supports('agentUser') && identity.agentUserId) allowed.push('agentUser');
  return allowed;
}
