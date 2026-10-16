import { fireEvent, screen, waitFor } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { User, UserManager } from 'oidc-client-ts';
import { Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, vi } from 'vitest';
import { clearSession } from '../auth/oidc';
import { useAuthStore } from '../auth/store';
import { server } from '../mocks/server';
import { PromptAgentPlayground } from '../routes/agents/PromptAgentPlayground';
import { useConnectivityFaultStore } from '../state/connectivityFault';
import { graphAgent, linkedUser } from './graphFixtures';
import { renderWithProviders } from './testUtils';

function assertion(oid: unknown = linkedUser.entra_oid): User {
  return new User({
    access_token: 'entra-assertion', token_type: 'Bearer',
    expires_at: Math.floor(Date.now() / 1000) + 600,
    profile: { sub: 'entra-sub', iss: 'https://login.microsoftonline.com/tenant-id/v2.0',
      aud: 'spa-client-id', exp: 9999999999, iat: 1, tid: linkedUser.entra_tid, oid },
  });
}

beforeEach(() => {
  useAuthStore.setState({ status: 'authenticated', user: linkedUser });
  useConnectivityFaultStore.setState({ enabled: false });
  server.use(
    http.get('*/v1/agents/graph-demo', () => HttpResponse.json(graphAgent)),
  );
});

afterEach(() => {
  if (vi.isMockFunction(UserManager.prototype.signinPopup)) {
    vi.mocked(UserManager.prototype.signinPopup).mockRestore();
  }
  useAuthStore.setState({ status: 'unknown', user: undefined });
  useConnectivityFaultStore.setState({ enabled: false });
});

function renderAgent() {
  return renderWithProviders(<Routes><Route path="/agents/:name" element={<PromptAgentPlayground />} /></Routes>,
    { route: '/agents/graph-demo' });
}

async function send(text: string) {
  fireEvent.change(screen.getByLabelText('Message the agent...'), { target: { value: text } });
  await waitFor(() => expect(screen.getByRole('button', { name: 'Send' })).toBeEnabled());
  fireEvent.click(screen.getByRole('button', { name: 'Send' }));
}

function respond() {
  return new HttpResponse(
    'data: {"type":"response.output_item.added","item":{"type":"function_call","name":"graph_me"}}\n\n'
    + 'data: {"type":"response.output_text.delta","delta":"Graph reply"}\n\n'
    + 'data: {"type":"response.completed","response":{"id":"graph-response","status":"completed"}}\n\n',
    { headers: { 'Content-Type': 'text/event-stream' } },
  );
}

it.each(['app', 'agentUser', 'endUserOBO'] as const)('invokes %s with native Graph events and pins mode/runtime until reset', async (mode) => {
  const popup = vi.spyOn(UserManager.prototype, 'signinPopup').mockResolvedValue(assertion());
  const headers: Headers[] = [];
  server.use(http.post(`*${graphAgent.endpoint}`, ({ request }) => {
    headers.push(request.headers);
    return respond();
  }));
  renderAgent();
  expect(await screen.findByText('Graph profile (Built-in)')).toBeInTheDocument();
  expect(screen.getByText('graph-me (native graph_me)')).toBeInTheDocument();
  expect(screen.queryByText('All server tools')).not.toBeInTheDocument();
  const label = { app: 'App', agentUser: 'Agent user', endUserOBO: 'On behalf of me' }[mode];
  expect(screen.getByRole('radio', { name: label })).toBeEnabled();
  fireEvent.click(screen.getByRole('radio', { name: label }));
  await send('First');
  expect(await screen.findByText('Graph reply')).toBeInTheDocument();
  expect(screen.getByText('Tool call: graph_me')).toBeInTheDocument();
  for (const radio of screen.getAllByRole('radio')) expect(radio).toBeDisabled();
  await waitFor(() => expect(screen.queryByRole('button', { name: 'Cancel' })).not.toBeInTheDocument());
  await send('Second');
  await waitFor(() => expect(headers).toHaveLength(2));
  await waitFor(() => expect(screen.queryByRole('button', { name: 'Cancel' })).not.toBeInTheDocument());
  expect(popup).toHaveBeenCalledTimes(mode === 'endUserOBO' ? 2 : 0);
  for (const header of headers) {
    expect(header.get('X-Impersonation-Mode')).toBe(mode);
    expect(header.get('X-Entra-User-Token')).toBe(mode === 'endUserOBO' ? 'entra-assertion' : null);
    expect([...header.keys()].some((key) => key.startsWith('x-client-'))).toBe(false);
  }
  fireEvent.click(screen.getByRole('button', { name: 'New conversation' }));
  expect(screen.getByRole('radio', { name: 'App' })).toBeEnabled();
});

it('rejects the wrong Entra user before sending and leaves the Keycloak principal unchanged', async () => {
  vi.spyOn(UserManager.prototype, 'signinPopup').mockResolvedValue(assertion('wrong-user'));
  const invoke = vi.fn(respond);
  server.use(http.post(`*${graphAgent.endpoint}`, invoke));
  renderAgent();
  await screen.findByText('Graph profile (Built-in)');
  fireEvent.click(screen.getByRole('radio', { name: 'On behalf of me' }));
  await send('Who am I?');
  expect(await screen.findByRole('alert')).toHaveTextContent('does not match');
  expect(invoke).not.toHaveBeenCalled();
  expect(useAuthStore.getState().user).toEqual(linkedUser);
});

it.each(['logout', 'linked user changed', 'red button'] as const)('blocks %s during Entra acquisition', async (change) => {
  let finish!: (result: User) => void;
  const popup = vi.spyOn(UserManager.prototype, 'signinPopup').mockReturnValue(new Promise((resolve) => { finish = resolve; }));
  const invoke = vi.fn(respond);
  server.use(http.post(`*${graphAgent.endpoint}`, invoke));
  renderAgent();
  await screen.findByText('Graph profile (Built-in)');
  fireEvent.click(screen.getByRole('radio', { name: 'On behalf of me' }));
  await send('Who am I?');
  await waitFor(() => expect(popup).toHaveBeenCalledOnce());
  if (change === 'logout') await clearSession();
  else if (change === 'linked user changed') useAuthStore.setState({ user: { ...linkedUser, entra_oid: 'another-user' } });
  else useConnectivityFaultStore.setState({ enabled: true });
  finish(assertion());
  await waitFor(() => expect(screen.getAllByRole('alert').some((alert) => alert.textContent?.includes('changed'))).toBe(true));
  expect(invoke).not.toHaveBeenCalled();
});

it('pins the platform user between turns and requires New conversation after a user change', async () => {
  const invoke = vi.fn(respond);
  server.use(http.post(`*${graphAgent.endpoint}`, invoke));
  renderAgent();
  await screen.findByText('Graph profile (Built-in)');
  await send('First');
  await screen.findByText('Graph reply');
  await waitFor(() => expect(screen.queryByRole('button', { name: 'Cancel' })).not.toBeInTheDocument());
  useAuthStore.setState({ user: { ...linkedUser, sub: 'different-platform-user' } });
  await send('Second');
  expect(await screen.findByRole('alert')).toHaveTextContent('Conversation identity changed');
  expect(invoke).toHaveBeenCalledOnce();
  fireEvent.click(screen.getByRole('button', { name: 'New conversation' }));
  await send('New user');
  await screen.findByText('Graph reply');
  expect(invoke).toHaveBeenCalledTimes(2);
});
