import { Badge, Text } from '@fluentui/react-components';
import { useQuery } from '@tanstack/react-query';
import { useEffect } from 'react';
import { NavLink, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { AuthCallback } from './auth/AuthCallback';
import { EntraCallback } from './auth/EntraCallback';
import { AuthGate } from './auth/AuthGate';
import { UserMenu } from './auth/UserMenu';
import { FoundryProjectCard } from './components/FoundryProjectCard';
import { RedButtonToggle } from './components/RedButtonToggle';
import { AgentsList } from './routes/agents/AgentsList';
import { HostedAgentPlayground } from './routes/agents/HostedAgentPlayground';
import { PromptAgentPlayground } from './routes/agents/PromptAgentPlayground';
import { ModelPlayground } from './routes/models/ModelPlayground';
import { ModelsList } from './routes/models/ModelsList';
import { ToolsList } from './routes/tools/ToolsList';
import { PlatformGuardrails } from './routes/guardrails/Guardrails';
import { useConnectivityFaultStore } from './state/connectivityFault';
import { getPlatformGuardrails } from './api/client';
import { embeddedMode } from './auth/config';

const tenantName = import.meta.env.VITE_TENANT_NAME ?? 'adaptive-edge';

export function App(): JSX.Element {
  const location = useLocation();
  const embedded = embeddedMode();

  // The OAuth redirect lands here before authentication completes, so it must
  // bypass the gate (which would otherwise show the sign-in screen).
  if (location.pathname === '/auth/callback') {
    return <AuthCallback />;
  }
  if (location.pathname === '/auth/entra-callback') return <EntraCallback />;

  const shell = <Shell embedded={embedded} />;
  return embedded ? shell : (
    <AuthGate>
      {shell}
    </AuthGate>
  );
}

function Shell({ embedded }: { embedded: boolean }): JSX.Element {
  const governance = useQuery({
    queryKey: ['guardrails'],
    queryFn: getPlatformGuardrails,
    refetchInterval: 30_000,
    enabled: !embedded,
  });
  const faultEnabled = useConnectivityFaultStore((state) => state.enabled);
  const faultError = useConnectivityFaultStore((state) => state.error);
  const faultLoading = useConnectivityFaultStore((state) => state.isLoading);
  const start = useConnectivityFaultStore((state) => state.start);
  const stop = useConnectivityFaultStore((state) => state.stop);

  useEffect(() => {
    if (embedded) return undefined;
    start();
    return stop;
  }, [embedded, start, stop]);

  const agentsRoot = embedded ? '/' : '/agents';

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand-lockup">
          <div className="brand-glyph">A</div>
          <Text weight="semibold">{embedded ? 'Trading Agents' : 'Adaptive AI'}</Text>
          {!embedded ? <><span className="crumb">/</span><Text weight="semibold">{tenantName}</Text></> : null}
        </div>
        <div className="topbar-search">Search with AI (Ctrl + K)</div>
        <div className="topbar-actions">
          {embedded ? <a href="/" className="nav-entry">← Back to Trading</a> : <Badge appearance="outline">Runtime only</Badge>}
          {!embedded ? <>
          <Badge
            appearance="tint"
            color={governance.isError ? 'warning' : governance.data?.enabled ? 'brand' : 'subtle'}
            title="Global policy configuration only; agents may also have attachments. This catalogue does not verify runtime enforcement."
          >
            Global policies: {governance.isError ? 'unavailable' : governance.isLoading ? 'loading' : governance.data?.enabled ? 'configured' : 'none'}
          </Badge>
          <Badge color={faultError ? 'warning' : faultEnabled ? 'danger' : 'subtle'} appearance="tint">
            {faultError ? 'Fault status unavailable' : faultLoading ? 'Checking fault configuration'
              : faultEnabled ? 'Cloud outage injected' : 'No outage injected'}
          </Badge>
          <RedButtonToggle />
          <UserMenu />
          </> : null}
        </div>
      </header>
      <div className="body-shell">
        <nav className="sidebar" aria-label="Primary">
          <NavLink to={agentsRoot} end className={({ isActive }) => `nav-entry ${isActive ? 'active' : ''}`}>
            Agents
          </NavLink>
          {!embedded ? <>
          <NavLink to="/tools" className={({ isActive }) => `nav-entry ${isActive ? 'active' : ''}`}>
            Tools
          </NavLink>
          <NavLink to="/models" className={({ isActive }) => `nav-entry ${isActive ? 'active' : ''}`}>
            Models
          </NavLink>
          <NavLink to="/guardrails" className={({ isActive }) => `nav-entry ${isActive ? 'active' : ''}`}>
            Guardrails
          </NavLink>
          <FoundryProjectCard />
          </> : null}
        </nav>
        <main className="content-shell">
          <Routes>
            <Route path="/" element={embedded ? <AgentsList /> : <Navigate to="/models" replace />} />
            {!embedded ? <Route path="/models" element={<ModelsList />} /> : null}
            {!embedded ? <Route path="/models/:modelId/playground" element={<ModelPlayground />} /> : null}
            {!embedded ? <Route path="/agents" element={<AgentsList />} /> : null}
            <Route path={embedded ? '/:name/prompt' : '/agents/:name/prompt'} element={<PromptAgentPlayground />} />
            <Route path={embedded ? '/:name/hosted' : '/agents/:name/hosted'} element={<HostedAgentPlayground />} />
            {!embedded ? <Route path="/tools" element={<ToolsList />} /> : null}
            {!embedded ? <Route path="/guardrails" element={<PlatformGuardrails />} /> : null}
            <Route path="*" element={<Navigate to={embedded ? '/' : '/models'} replace />} />
          </Routes>
        </main>
      </div>
    </div>
  );
}
