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

const tenantName = import.meta.env.VITE_TENANT_NAME ?? 'adaptive-edge';

export function App(): JSX.Element {
  const location = useLocation();

  // The OAuth redirect lands here before authentication completes, so it must
  // bypass the gate (which would otherwise show the sign-in screen).
  if (location.pathname === '/auth/callback') {
    return <AuthCallback />;
  }
  if (location.pathname === '/auth/entra-callback') return <EntraCallback />;

  return (
    <AuthGate>
      <Shell />
    </AuthGate>
  );
}

function Shell(): JSX.Element {
  const governance = useQuery({
    queryKey: ['guardrails'],
    queryFn: getPlatformGuardrails,
    refetchInterval: 30_000,
  });
  const faultEnabled = useConnectivityFaultStore((state) => state.enabled);
  const faultError = useConnectivityFaultStore((state) => state.error);
  const faultLoading = useConnectivityFaultStore((state) => state.isLoading);
  const start = useConnectivityFaultStore((state) => state.start);
  const stop = useConnectivityFaultStore((state) => state.stop);

  useEffect(() => {
    start();
    return stop;
  }, [start, stop]);

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand-lockup">
          <div className="brand-glyph">A</div>
          <Text weight="semibold">Adaptive AI</Text>
          <span className="crumb">/</span>
          <Text weight="semibold">{tenantName}</Text>
        </div>
        <div className="topbar-search">Search with AI (Ctrl + K)</div>
        <div className="topbar-actions">
          <Badge appearance="outline">Runtime only</Badge>
          <Badge
            appearance="tint"
            color={governance.isError ? 'warning' : governance.data?.enabled ? 'brand' : 'subtle'}
            title="Global policy configuration only; agent releases may also have attachments. This catalogue does not verify runtime enforcement."
          >
            Global policies: {governance.isError ? 'unavailable' : governance.isLoading ? 'loading' : governance.data?.enabled ? 'configured' : 'none'}
          </Badge>
          <Badge color={faultError ? 'warning' : faultEnabled ? 'danger' : 'subtle'} appearance="tint">
            {faultError ? 'Fault status unavailable' : faultLoading ? 'Checking fault configuration'
              : faultEnabled ? 'Cloud outage injected' : 'No outage injected'}
          </Badge>
          <RedButtonToggle />
          <UserMenu />
        </div>
      </header>
      <div className="body-shell">
        <nav className="sidebar" aria-label="Primary">
          <NavLink to="/agents" className={({ isActive }) => `nav-entry ${isActive ? 'active' : ''}`}>
            Agents
          </NavLink>
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
        </nav>
        <main className="content-shell">
          <Routes>
            <Route path="/" element={<Navigate to="/models" replace />} />
            <Route path="/models" element={<ModelsList />} />
            <Route path="/models/:modelId/playground" element={<ModelPlayground />} />
            <Route path="/agents" element={<AgentsList />} />
            <Route path="/agents/:name/prompt" element={<PromptAgentPlayground />} />
            <Route path="/agents/:name/hosted" element={<HostedAgentPlayground />} />
            <Route path="/tools" element={<ToolsList />} />
            <Route path="/guardrails" element={<PlatformGuardrails />} />
            <Route path="*" element={<Navigate to="/models" replace />} />
          </Routes>
        </main>
      </div>
    </div>
  );
}
