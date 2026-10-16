import {
  Badge,
  Button,
  Card,
  Field,
  Input,
  Spinner,
  Tab,
  TabList,
  TabValue,
  Text,
  Textarea,
} from '@fluentui/react-components';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  getAgent,
  type ImpersonationMode,
} from '../../api/client';
import { useAuthStore } from '../../auth/store';
import { AgentInfoPanel } from '../../components/AgentInfoPanel';
import { ChatPanel } from '../../components/ChatPanel';
import { ImpersonationToggle } from '../../components/ImpersonationToggle';
import { MonitorPanel } from '../../components/MonitorPanel';
import { A2APanel } from './A2APanel';
import { AgentGuardrails } from '../guardrails/Guardrails';
import { useConnectivityFaultStore } from '../../state/connectivityFault';
import { authTypeLabel, executionIdentityLabel, identityModeLabels } from '../tools/toolCatalog';
import { useAgentConversation } from './useAgentConversation';
import { allowedIdentityModes } from './identityModes';
import { embeddedMode } from '../../auth/config';

export function PromptAgentPlayground(): JSX.Element {
  const embedded = embeddedMode();
  const { name = '' } = useParams();
  const navigate = useNavigate();
  const agentQuery = useQuery({ queryKey: ['agent', name], queryFn: () => getAgent(name), enabled: Boolean(name) });
  const [tab, setTab] = useState<TabValue>('chat');
  const [impersonation, setImpersonation] = useState<ImpersonationMode>('app');
  const user = useAuthStore((state) => state.user);
  const mode = useConnectivityFaultStore((state) => state.enabled);
  const conversation = useAgentConversation(name, impersonation, mode);
  const agent = conversation.pinned ?? agentQuery.data;
  const entraTools = agent?.tools?.filter((tool) => tool.authType === 'entra') ?? [];
  const allowedModes = allowedIdentityModes(agent, mode, user);
  const unavailableTools = mode && entraTools.length > 0;
  const unsupportedIdentity = !allowedModes.includes(impersonation);
  const invocationBlocked = conversation.failed || !agent || (!conversation.pinned && (!agent.endpoint || agent.phase !== 'Ready')) || unsupportedIdentity;
  const callerIdentity = impersonation === 'endUserOBO' ? `Linked Entra user: ${user?.entra_oid ?? 'Not linked'}`
    : impersonation === 'agentUser' ? `Agent worker user: ${agent?.identity?.agentUserId ?? 'Not provisioned'}`
      : `Agent app: ${agent?.identity?.entraClientId ?? agent?.identity?.keycloakClientId ?? 'Application identity not reported'}`;

  return (
    <section className="page playground-page">
      <div className="playground-titlebar">
        <div className="playground-titlebar-group">
          <Button appearance="transparent" onClick={() => navigate(embedded ? '/' : '/agents')}>
            ← Agents
          </Button>
          <Text as="h1" size={500} weight="semibold">
            {agent?.name ?? name}
          </Text>
          <Badge appearance="tint">prompt</Badge>
        </div>
        <div className="titlebar-actions">
          <Text>{conversation.pinned ? 'Conversation runtime pinned' : 'Current mutable runtime'}</Text>
        </div>
      </div>
      {agentQuery.isLoading ? <Spinner label="Loading agent" /> : null}
      {agentQuery.error ? <Text className="error-text">Failed to load agent.</Text> : null}
      <div className="playground-shell three-pane">
        <aside className="playground-left">
          <ImpersonationToggle
            value={impersonation}
            onChange={setImpersonation}
            allowedModes={[...allowedModes]}
            disabled={conversation.started}
          />
          <Text size={200}>Model calls always use application identity. Graph /me requires a user;
            app mode reports that limitation rather than impersonating a user.</Text>
          {unsupportedIdentity ? (
            <Text className="error-text" role="alert">
              Selected identity is unsupported by an attached Entra tool. Choose a supported call identity before invoking.
            </Text>
          ) : null}
          {unavailableTools ? (
            <Text role="status">
              {entraTools.some((tool) => tool.type === 'builtin')
                ? 'Cloud outage injection is enabled. Graph cannot return a cloud profile; local model conversation remains available.'
                : 'Cloud outage injection is enabled. Cloud-only tools may fail; local model conversation and local tools remain available.'}
            </Text>
          ) : null}
          <Field label="Model">
            <Input value={agent?.model ?? ''} readOnly />
          </Field>
          <Field label="Instructions">
            <Textarea
              appearance="filled-darker"
              value={agent?.instructions ?? ''}
              resize="vertical"
              readOnly
            />
          </Field>
          <Field label="Tools">
            <div className="tools-attach-list">
              {!agent?.tools?.length && !agent?.skills?.length ? (
                <Text size={200} className="muted-text">
                  No tools attached.
                </Text>
              ) : (
                agent?.tools?.map((tool, index) => (
                  <Card key={`${tool.connectionRef}-${index}`} appearance="filled-alternative">
                    <Text weight="semibold">{tool.serverLabel} ({tool.type === 'builtin' ? 'Built-in' : 'MCP'})</Text>
                    <dl className="info-list">
                      <div><dt>Catalogue ID</dt><dd>{tool.connectionRef}</dd></div>
                      {tool.type === 'mcp' ? <div><dt>Endpoint</dt><dd>{tool.serverUrl}</dd></div>
                        : <div><dt>Function</dt><dd>{tool.name} (native graph_me)</dd></div>}
                      <div><dt>Approvals</dt><dd>{tool.requireApproval === 'always' ? 'Always required' : 'Not required'}</dd></div>
                      {tool.type === 'mcp' ? <div><dt>Allowed tools</dt><dd>{tool.allowedTools === undefined ? 'All server tools' : tool.allowedTools.join(', ') || 'None'}</dd></div> : null}
                      <div><dt>Authentication</dt><dd>{authTypeLabel(tool.authType)}</dd></div>
                      {tool.authType === 'entra' ? (
                        <>
                          <div><dt>Audience</dt><dd>{tool.audience ?? 'Not configured'}</dd></div>
                          <div><dt>Supported identities</dt><dd>{tool.identityModes.map((identity) => identityModeLabels[identity]).join(', ') || 'None'}</dd></div>
                          <div>
                            <dt>Tool caller</dt>
                            <dd>{mode ? 'Cloud outage injected'
                              : !tool.identityModes.includes(impersonation) ? 'Selected identity is unsupported'
                                : callerIdentity}</dd>
                          </div>
                        </>
                      ) : <div><dt>MCP caller</dt><dd>No platform identity bearer is sent; the identity toggle does not authenticate this tool.</dd></div>}
                      <div><dt>Execution identity</dt><dd>{executionIdentityLabel(tool.executionIdentity, tool.type === 'builtin')}</dd></div>
                    </dl>
                  </Card>
                ))
              )}
              {agent?.skills?.map((skill) => (
                <Card key={skill.path} appearance="filled-alternative">
                  <Text weight="semibold">{skill.name} (Skill)</Text>
                  <Text size={200}>{skill.path}</Text>
                  <Text>{skill.description}</Text>
                  <Text size={200}>Configured on the current agent. Instructions load on demand; no script execution.</Text>
                </Card>
              ))}
            </div>
          </Field>
          <Text className="muted-text">Configuration is managed through Radius.</Text>
        </aside>
        <main className="playground-main tabbed-main">
          <TabList selectedValue={tab} onTabSelect={(_, data) => setTab(data.value)}>
            <Tab value="chat">Chat</Tab>
            <Tab value="monitor">Monitor</Tab>
            {!embedded ? <Tab value="guardrails">Guardrails</Tab> : null}
            {!embedded ? <Tab value="a2a">A2A</Tab> : null}
          </TabList>
          <div hidden={tab !== 'chat'} className="tab-pane">
            <ChatPanel
              key={name}
              emptyTitle={agent?.name ?? 'Prompt agent'}
              emptySubtitle={agent?.description}
              placeholder="Message the agent..."
              onSend={conversation.send}
              onReset={conversation.reset}
              disabled={invocationBlocked}
            />
          </div>
          <div hidden={tab !== 'monitor'} className="tab-pane">
            <MonitorPanel name={name} visible={tab === 'monitor'} />
          </div>
          {!embedded ? <div hidden={tab !== 'guardrails'} className="tab-pane">
            <AgentGuardrails name={name} visible={tab === 'guardrails'} />
          </div> : null}
          {!embedded ? <div hidden={tab !== 'a2a'} className="tab-pane">
            <A2APanel name={name} />
          </div> : null}
        </main>
        <aside className="playground-info">
          <AgentInfoPanel identity={agent?.identity} kind="prompt" />
        </aside>
      </div>
    </section>
  );
}
