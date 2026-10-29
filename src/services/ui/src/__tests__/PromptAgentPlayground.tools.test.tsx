import { fireEvent, screen, waitFor } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { Route, Routes } from 'react-router-dom';
import { afterEach, vi } from 'vitest';
import type { Agent, AgentToolRef } from '../api/client';
import { PromptAgentPlayground } from '../routes/agents/PromptAgentPlayground';
import { server } from '../mocks/server';
import { useConnectivityFaultStore } from '../state/connectivityFault';
import { renderWithProviders } from './testUtils';

const genericTool: AgentToolRef = {
  type: 'mcp',
  connectionRef: 'generic-mcp',
  serverLabel: 'local-search',
  serverUrl: 'http://search.adaptive.svc/mcp',
  requireApproval: 'never',
  allowedTools: ['search_code'],
  authType: 'none',
  identityModes: [],
  executionIdentity: 'caller',
};
const entraTool: AgentToolRef = {
  ...genericTool,
  connectionRef: 'azure-mcp',
  serverLabel: 'azure',
  serverUrl: 'https://azure-mcp.example/mcp',
  requireApproval: 'always',
  authType: 'entra',
  audience: 'api://azure-mcp',
  identityModes: ['app', 'endUserOBO'],
  executionIdentity: 'server',
};
const runtime = {
  endpoint: '/agents/handoff-service/responses',
  phase: 'Ready' as const,
};

function nativeReply(delta: string) {
  return new HttpResponse(
    `data: ${JSON.stringify({ type: 'response.output_text.delta', delta })}\n\n`
    + 'data: {"type":"response.completed","response":{"id":"resp-tools","status":"completed"}}\n\n',
    { headers: { 'Content-Type': 'text/event-stream' } },
  );
}

afterEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  vi.unstubAllEnvs();
  useConnectivityFaultStore.setState({ enabled: false });
});

function renderAgent(tools: AgentToolRef[]): ReturnType<typeof renderWithProviders> {
  const agent: Agent = {
    name: 'handoff-service',
    type: 'prompt',
    ...runtime,
    model: 'gpt-5.4-mini',
    identity: { entraClientId: 'agent-client-id', blueprintId: 'agent-blueprint', keycloakClientId: 'mirror' },
    tools,
  };
  server.use(
    http.get('*/v1/agents/handoff-service', () => HttpResponse.json(agent)),
  );
  return renderWithProviders(
    <Routes><Route path="/agents/:name" element={<PromptAgentPlayground />} /></Routes>,
    { route: '/agents/handoff-service' },
  );
}

it('shows configured tools and read-only settings while preserving streamed invocation', async () => {
  let body: unknown;
  const agent: Agent = {
      name: 'handoff-service',
      type: 'prompt',
      ...runtime,
      model: 'gpt-5.4-mini',
      instructions: 'Use the configured tools.',
      tools: [genericTool],
      skills: [{
        path: 'travel-checklist/SKILL.md',
        name: 'travel-checklist',
        description: 'Create a pre-departure checklist.',
      }],
    };
  server.use(
    http.get('*/v1/agents/handoff-service', () => HttpResponse.json(agent)),
    http.post('*/agents/handoff-service/responses', async ({ request }) => {
      body = await request.json();
      return nativeReply('Tool-backed reply');
    }),
  );
  renderWithProviders(
    <Routes><Route path="/agents/:name" element={<PromptAgentPlayground />} /></Routes>,
    { route: '/agents/handoff-service' },
  );
  expect(await screen.findByText('local-search (MCP)')).toBeInTheDocument();
  expect(screen.getByText(genericTool.serverUrl)).toBeInTheDocument();
  expect(screen.getByText('search_code')).toBeInTheDocument();
  expect(screen.getByText('travel-checklist (Skill)')).toBeInTheDocument();
  expect(screen.getByText('travel-checklist/SKILL.md')).toBeInTheDocument();
  expect(screen.getByText('Create a pre-departure checklist.')).toBeInTheDocument();
  expect(screen.getByText('Not required')).toBeInTheDocument();
  expect(screen.getByText(/No platform identity bearer is sent/)).toBeInTheDocument();
  expect(screen.getByText(/resource delegation is not implied/)).toBeInTheDocument();
  expect(screen.getByRole('radio', { name: 'Agent user' })).toBeDisabled();
  expect(screen.getByLabelText('Model')).toHaveAttribute('readonly');
  expect(screen.getByLabelText('Instructions')).toHaveAttribute('readonly');
  expect(screen.queryByRole('button', { name: /save|publish|preview|connect/i })).not.toBeInTheDocument();
  expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
  fireEvent.change(screen.getByLabelText('Message the agent...'), { target: { value: 'Find code' } });
  fireEvent.click(screen.getByRole('tab', { name: 'Monitor' }));
  fireEvent.click(screen.getByRole('tab', { name: 'Guardrails' }));
  expect(await screen.findByText('Policies: none attached')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('tab', { name: 'Chat' }));
  expect(screen.getByLabelText('Message the agent...')).toHaveValue('Find code');
  fireEvent.click(screen.getByRole('button', { name: 'Send' }));
  expect(await screen.findByText('Tool-backed reply')).toBeInTheDocument();
  await waitFor(() => expect(body).toEqual({
    input: 'Find code',
    store: false,
    stream: true,
  }));
});

it('keeps app identity separate from downstream server identity and disables OBO', async () => {
  localStorage.setItem('adaptive.providerToken', 'user-subject');
  renderAgent([entraTool]);
  expect(await screen.findByText('Agent app: agent-client-id')).toBeInTheDocument();
  expect(screen.getByText('api://azure-mcp')).toBeInTheDocument();
  expect(screen.getByText('Always required')).toBeInTheDocument();
  expect(screen.getByText(/Downstream server workload identity — no caller delegation/)).toBeInTheDocument();
  expect(screen.getByRole('radio', { name: 'Agent user' })).toBeDisabled();
  expect(screen.getByRole('radio', { name: 'On behalf of me' })).toBeDisabled();
  expect(screen.getByText(/OBO requires connected mode/)).toBeInTheDocument();
  expect(screen.getByText(/Downstream server workload identity — no caller delegation/)).toBeInTheDocument();
});

it('does not enable worker-user invocation from captured tool modes or a Keycloak mirror', async () => {
  renderAgent([{ ...entraTool, identityModes: ['app', 'agentUser'], executionIdentity: 'caller' }]);
  await screen.findByText('azure (MCP)');
  expect(screen.getByRole('radio', { name: 'Agent user' })).toBeDisabled();
  expect(screen.getByText(/Hosted delegation is unavailable/)).toBeInTheDocument();
  expect(screen.getByText(/resource delegation is not implied/)).toBeInTheDocument();
});

it('prevents invocation when the current identity is unsupported by any attached Entra tool', async () => {
  renderAgent([genericTool, { ...entraTool, identityModes: ['endUserOBO'] }]);
  await screen.findByText('azure (MCP)');
  fireEvent.change(screen.getByLabelText('Message the agent...'), { target: { value: 'Use tools' } });
  expect(screen.getByRole('alert')).toHaveTextContent(/Selected identity is unsupported/);
  expect(screen.getByRole('radio', { name: 'App' })).toBeDisabled();
  expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
});

it.each([
  { label: 'conversation', tools: [entraTool] },
  { label: 'conversation with local tools', tools: [entraTool, genericTool] },
])('preserves $label with supported app identity during injected cloud loss', async ({ tools }) => {
  useConnectivityFaultStore.setState({ enabled: true });
  let selectedIdentity: string | null = null;
  server.use(http.post('*/agents/handoff-service/responses', ({ request }) => {
    selectedIdentity = request.headers.get('X-Impersonation-Mode');
    return nativeReply('Local conversation continues');
  }));
  const { unmount } = renderAgent(tools);
  expect(await screen.findByText('Cloud outage injected')).toBeInTheDocument();
  expect(screen.getByRole('status')).toHaveTextContent(/Cloud-only tools may fail/);
  expect(screen.getByRole('radio', { name: 'Agent user' })).toBeDisabled();
  expect(screen.queryByText(/Selected identity is unsupported/)).not.toBeInTheDocument();
  fireEvent.change(screen.getByLabelText('Message the agent...'), { target: { value: 'Continue locally' } });
  expect(screen.getByRole('button', { name: 'Send' })).toBeEnabled();
  fireEvent.click(screen.getByRole('button', { name: 'Send' }));
  expect(await screen.findByText('Local conversation continues')).toBeInTheDocument();
  expect(selectedIdentity).toBe('app');
  unmount();
});

it('keeps local generic tools usable during injected cloud loss', async () => {
  useConnectivityFaultStore.setState({ enabled: true });
  const { unmount } = renderAgent([genericTool]);
  await screen.findByText('local-search (MCP)');
  expect(screen.getByRole('radio', { name: 'Agent user' })).toBeDisabled();
  fireEvent.change(screen.getByLabelText('Message the agent...'), { target: { value: 'Use local tools' } });
  expect(screen.getByRole('button', { name: 'Send' })).toBeEnabled();
  unmount();
});

it('does not offer OBO even when legacy browser credentials remain', async () => {
  localStorage.setItem('adaptive.authToken', 'broker-token');
  localStorage.setItem('adaptive.providerToken', 'login-subject');
  sessionStorage.setItem('adaptive.refreshToken', 'refresh-token');
  const invoke = vi.fn(() => HttpResponse.json({}));
  server.use(http.post('*/agents/handoff-service/responses', invoke));
  renderAgent([entraTool]);
  await screen.findByText('azure (MCP)');
  expect(screen.getByRole('radio', { name: 'On behalf of me' })).toBeDisabled();
  expect(invoke).not.toHaveBeenCalled();
});
