import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { delay, http, HttpResponse } from 'msw';
import { Route, Routes } from 'react-router-dom';
import { vi } from 'vitest';
import { Agent } from '../api/client';
import { server } from '../mocks/server';
import { HostedAgentPlayground } from '../routes/agents/HostedAgentPlayground';
import { PromptAgentPlayground } from '../routes/agents/PromptAgentPlayground';
import { renderWithProviders } from './testUtils';

function agentFixture(label = 'current', type: Agent['type'] = 'prompt'): Agent {
  return {
    name: 'demo', type, phase: 'Ready',
    endpoint: '/agents/demo/responses',
    instructions: `${label} instructions`, model: `${label}-model`,
    identity: { blueprintId: `${label}-blueprint`, entraClientId: `${label}-identity` },
  };
}

function discovery(resolve: () => Agent | Response) {
  return [http.get('*/v1/agents/demo', () => {
    const value = resolve();
    return value instanceof Response ? value : HttpResponse.json(value);
  })];
}

function stream(events: unknown[], terminated = true) {
  return new HttpResponse(events.map((event) => `data: ${JSON.stringify(event)}`).join('\n\n') + (terminated ? '\n\n' : ''), {
    headers: { 'Content-Type': 'text/event-stream' },
  });
}

function completed(id: string) {
  return { type: 'response.completed', response: { id, status: 'completed' } };
}

function renderAgent(type: Agent['type'] = 'prompt') {
  return renderWithProviders(
    <Routes><Route path="/agents/:name" element={type === 'prompt' ? <PromptAgentPlayground /> : <HostedAgentPlayground />} /></Routes>,
    { route: '/agents/demo' },
  );
}

async function send(prompt: string) {
  fireEvent.change(screen.getByRole('textbox', { name: /Message the .*agent/ }), { target: { value: prompt } });
  await waitFor(() => expect(screen.getByRole('button', { name: 'Send' })).toBeEnabled());
  fireEvent.click(screen.getByRole('button', { name: 'Send' }));
}

it.each(['prompt', 'hosted'] as const)('pins the %s runtime through updates and API outage, then resets explicitly', async (type) => {
  let current = agentFixture('first', type);
  let discoveryCalls = 0;
  let outage = false;
  const bodies: unknown[] = [];
  const endpoints: string[] = [];
  server.use(
    ...discovery(() => {
      discoveryCalls += 1;
      return outage ? new HttpResponse(null, { status: 503 }) : current;
    }),
    http.post('*/agents/demo/responses', async ({ request }) => {
      endpoints.push('current');
      bodies.push(await request.json());
      return stream([
        { type: 'response.output_item.added', item: { type: 'function_call', name: 'search' } },
        { type: 'response.output_text.delta', delta: `Reply ${bodies.length}` },
        completed(`resp-${bodies.length}`),
      ]);
    }),
  );
  const { queryClient } = renderAgent(type);
  await send('First');
  expect(await screen.findByText('Reply 1')).toBeInTheDocument();
  await waitFor(() => expect(screen.queryByRole('button', { name: 'Cancel' })).not.toBeInTheDocument());
  expect(screen.getByText('Tool call: search')).toBeInTheDocument();
  const count = discoveryCalls;
  current = agentFixture('updated', type);
  act(() => queryClient.setQueryData(['agent', 'demo'], current));
  if (type === 'prompt') expect(screen.getByLabelText('Instructions')).toHaveValue('first instructions');
  outage = true;
  await send('Second');
  expect(await screen.findByText('Reply 2')).toBeInTheDocument();
  await waitFor(() => expect(screen.queryByRole('button', { name: 'Cancel' })).not.toBeInTheDocument());
  expect(discoveryCalls).toBe(count);
  expect(endpoints).toEqual(['current', 'current']);
  expect(bodies).toEqual([
    { input: 'First', store: false, stream: true },
    { input: 'Second', store: false, stream: true },
  ]);
  outage = false;
  fireEvent.click(screen.getByRole('button', { name: 'New conversation' }));
  await send('Fresh');
  await screen.findByText('Reply 3');
  expect(endpoints).toEqual(['current', 'current', 'current']);
  expect(bodies[2]).toEqual({ input: 'Fresh', store: false, stream: true });
});

it.each([
  ['failed', () => stream([{ type: 'response.failed', response: { error: { message: 'Tool failed' } } }]), 'Tool failed'],
  ['error', () => stream([{ type: 'error', message: 'Native error' }]), 'Native error'],
  ['incomplete', () => stream([{ type: 'response.incomplete', response: { incomplete_details: { reason: 'max_output_tokens' } } }]), 'max_output_tokens'],
  ['truncated', () => stream([{ type: 'response.output_text.delta', delta: 'Partial output' }]), 'without response.completed'],
  ['unfinished event', () => stream([completed('resp-1')], false), 'Truncated event stream'],
  ['invalid completion', () => stream([{ type: 'response.completed', response: { id: 'bad', status: 'failed' } }]), 'Invalid native response completion'],
  ['retired endpoint', () => new HttpResponse(null, { status: 410 }), '410'],
  ['HTML fallback', () => new HttpResponse('<html>SPA</html>', { headers: { 'Content-Type': 'text/html' } }), 'Expected a native Responses'],
] as const)('fails explicitly for %s without retry or fallback', async (_, response, message) => {
  const invoke = vi.fn(response);
  server.use(
    ...discovery(() => agentFixture()),
    http.post('*/agents/demo/responses', invoke),
  );
  renderAgent();
  await send('First');
  expect(await screen.findByRole('alert')).toHaveTextContent(message);
  expect(screen.getByRole('alert')).toHaveTextContent('will not be replayed');
  fireEvent.change(screen.getByRole('textbox', { name: /Message the agent/ }), { target: { value: 'Again' } });
  expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
  fireEvent.submit(screen.getByRole('button', { name: 'Send' }).closest('form')!);
  expect(invoke).toHaveBeenCalledOnce();
});

it('keeps cancelled turns uncertain and requires reset', async () => {
  server.use(
    ...discovery(() => agentFixture()),
    http.post('*/agents/demo/responses', async () => {
      await delay(100);
      return stream([completed('resp-cancelled')]);
    }),
  );
  renderAgent();
  await send('Cancel me');
  fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('Turn cancelled');
  expect(screen.getByRole('alert')).toHaveTextContent('will not be replayed');
});

it('refuses a runtime that becomes unavailable during initial resolution', async () => {
  let calls = 0;
  const invoke = vi.fn();
  server.use(
    ...discovery(() => ++calls === 1 ? agentFixture()
      : { ...agentFixture(), phase: 'Pending', endpoint: null }),
    http.post('*/agents/demo/responses', invoke),
  );
  renderAgent();
  await send('First');
  expect(await screen.findByRole('alert')).toHaveTextContent('Agent runtime is unavailable');
  expect(invoke).not.toHaveBeenCalled();
});
