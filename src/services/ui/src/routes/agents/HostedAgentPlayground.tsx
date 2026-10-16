import { Badge, Button, Card, Tab, TabList, TabValue, Text } from '@fluentui/react-components';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { getAgent } from '../../api/client';
import { AgentInfoPanel } from '../../components/AgentInfoPanel';
import { ChatPanel } from '../../components/ChatPanel';
import { ImpersonationToggle } from '../../components/ImpersonationToggle';
import { MonitorPanel } from '../../components/MonitorPanel';
import { A2APanel } from './A2APanel';
import { AgentGuardrails } from '../guardrails/Guardrails';
import { useConnectivityFaultStore } from '../../state/connectivityFault';
import { useAgentConversation } from './useAgentConversation';
import { embeddedMode } from '../../auth/config';

export function HostedAgentPlayground(): JSX.Element {
  const embedded = embeddedMode();
  const { name = '' } = useParams();
  const navigate = useNavigate();
  const [tab, setTab] = useState<TabValue>('chat');
  const agentQuery = useQuery({ queryKey: ['agent', name], queryFn: () => getAgent(name), enabled: Boolean(name) });
  const mode = useConnectivityFaultStore((state) => state.enabled);
  const conversation = useAgentConversation(name, 'app', mode);
  const agent = conversation.pinned ?? agentQuery.data;

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
          <Badge appearance="tint">hosted</Badge>
        </div>
      </div>
      {agentQuery.error ? <Text className="error-text">Failed to load agent.</Text> : null}
      <div className="playground-shell three-pane">
        <aside className="playground-left">
          <Card appearance="filled-alternative" className="metadata-card">
            <ImpersonationToggle
              value="app"
              onChange={() => undefined}
              allowedModes={['app']}
            />
            <Text size={200}>Hosted delegated identity is unavailable. Use application identity.</Text>
          </Card>
          <Card appearance="filled-alternative" className="metadata-card">
            <Text weight="semibold">Hosted metadata</Text>
            <Text size={200}>Hosted-agent tools are defined in the container’s code, not attached in this playground.</Text>
            <dl className="info-list">
              <div>
                <dt>Name</dt>
                <dd>{agent?.name ?? name}</dd>
              </div>
              <div>
                <dt>Image</dt>
                <dd>{agent?.image ?? '—'}</dd>
              </div>
              <div>
                <dt>Port</dt>
                <dd>{agent?.port ?? 8080}</dd>
              </div>
            </dl>
          </Card>
        </aside>
        <main className="playground-main hosted-main">
          <TabList selectedValue={tab} onTabSelect={(_, data) => setTab(data.value)}>
            <Tab value="chat">Chat</Tab>
            <Tab value="monitor">Monitor</Tab>
            {!embedded ? <Tab value="guardrails">Guardrails</Tab> : null}
            {!embedded ? <Tab value="a2a">A2A</Tab> : null}
          </TabList>
          <div hidden={tab !== 'chat'} className="tab-pane">
            <ChatPanel
              key={name}
              emptyTitle={agent?.name ?? 'Hosted agent'}
              emptySubtitle={agent?.description}
              placeholder="Message the hosted agent..."
              onSend={conversation.send}
              onReset={conversation.reset}
              disabled={conversation.failed || !agent || (!conversation.pinned && (!agent.endpoint || agent.phase !== 'Ready'))}
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
          <AgentInfoPanel
            identity={agent?.identity}
            image={agent?.image}
            kind="hosted"
            protocol="responses"
          />
        </aside>
      </div>
    </section>
  );
}
