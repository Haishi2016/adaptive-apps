import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { delay, http, HttpResponse } from 'msw';
import { Route, Routes } from 'react-router-dom';
import { vi } from 'vitest';
import { Agent, getAgent, listAgentVersions } from '../api/client';
import { server } from '../mocks/server';
import { HostedAgentPlayground } from '../routes/agents/HostedAgentPlayground';
import { PromptAgentPlayground } from '../routes/agents/PromptAgentPlayground';
import { renderWithProviders } from './testUtils';

beforeEach(() => {
  server.use(http.get('*/v1/agents/demo/versions', () => HttpResponse.json({ object: 'list', data: [] })));
});

function release(version = 'amber', type: Agent['type'] = 'prompt'): Agent {
  return {
    name: 'demo', type, version, phase: 'Ready',
    requestedActiveVersion: version, activeVersion: version,
    endpoint: `/agents/demo/versions/${version}/responses`,
    instructions: `${version} instructions`, model: `${version}-model`,
    identity: { blueprintId: `${version}-blueprint`, entraClientId: `${version}-identity` },
  };
}

function discovery(resolve: (version?: string) => Agent | Response) {
  return [
    http.get('*/v1/agents/demo', () => {
      const value = resolve();
      return value instanceof Response ? value : HttpResponse.json(value);
    }),
    http.get('*/v1/agents/demo/versions/:version', ({ params }) => {
      const value = resolve(String(params.version));
      return value instanceof Response ? value : HttpResponse.json(value);
    }),
  ];
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

it.each(['prompt', 'hosted'] as const)('pins %s release through promotion and API outage, then resets explicitly', async (type) => {
  let current = release('amber', type);
  let discoveryCalls = 0;
  let outage = false;
  const bodies: unknown[] = [];
  const endpoints: string[] = [];
  server.use(
    ...discovery(() => {
      discoveryCalls += 1;
      return outage ? new HttpResponse(null, { status: 503 }) : current;
    }),
    http.post('*/agents/demo/versions/:version/responses', async ({ params, request }) => {
      endpoints.push(String(params.version));
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
  current = release('birch', type);
  act(() => queryClient.setQueryData(['agent', 'demo'], current));
  expect(screen.getByText(/Conversation release/)).toHaveTextContent(type === 'prompt' ? 'amber' : 'Conversation release');
  if (type === 'prompt') expect(screen.getByLabelText('Instructions')).toHaveValue('amber instructions');
  outage = true;
  await send('Second');
  expect(await screen.findByText('Reply 2')).toBeInTheDocument();
  await waitFor(() => expect(screen.queryByRole('button', { name: 'Cancel' })).not.toBeInTheDocument());
  expect(discoveryCalls).toBe(count);
  expect(endpoints).toEqual(['amber', 'amber']);
  expect(bodies).toEqual([
    { input: 'First', store: false, stream: true },
    { input: 'Second', store: false, stream: true },
  ]);
  outage = false;
  fireEvent.click(screen.getByRole('button', { name: 'New conversation' }));
  await send('Fresh');
  await screen.findByText('Reply 3');
  expect(endpoints).toEqual(['amber', 'amber', 'birch']);
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
    ...discovery(() => release()),
    http.post('*/agents/demo/versions/amber/responses', invoke),
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
    ...discovery(() => release()),
    http.post('*/agents/demo/versions/amber/responses', async () => {
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

it('refuses a release that becomes unavailable during initial resolution', async () => {
  let calls = 0;
  const invoke = vi.fn();
  server.use(
    ...discovery(() => ++calls === 1 ? release()
      : { ...release(), phase: 'Pending', endpoint: null }),
    http.post('*/agents/demo/versions/amber/responses', invoke),
  );
  renderAgent();
  await send('First');
  expect(await screen.findByRole('alert')).toHaveTextContent('Selected release is unavailable');
  expect(invoke).not.toHaveBeenCalled();
});

it.each(['prompt', 'hosted'] as const)('selects an explicit ready %s release without declaring promotion', async (type) => {
  const selected = { ...release('candidate', type), activeVersion: null, requestedActiveVersion: null };
  const bodies: unknown[] = [];
  server.use(
    ...discovery((version) =>
      version === 'candidate'
        ? selected : { ...selected, version: null, endpoint: null, phase: 'Pending' },
    ),
    http.get('*/v1/agents/demo/versions', () => HttpResponse.json({ object: 'list', data: [
        { name: 'demo', version: 'candidate', status: 'Available', endpoint: selected.endpoint,
          definitionDigest: 'digest', requestedActive: false, active: false },
        { name: 'demo', version: 'not-ready', status: 'Progressing', endpoint: null,
          definitionDigest: null, requestedActive: false, active: false },
      ] })),
    http.post('*/agents/demo/versions/candidate/responses', async ({ request }) => {
      bodies.push(await request.json());
      return stream([{ type: 'response.output_text.delta', delta: 'Candidate reply' }, completed('resp-candidate')]);
    }),
  );
  renderAgent(type);
  const selector = await screen.findByLabelText('Invocation release');
  await waitFor(() => expect(selector).toBeEnabled());
  expect(screen.getByRole('option', { name: 'not-ready · Progressing' })).toBeDisabled();
  await waitFor(() => expect(selector).toHaveValue('candidate'));
  expect(screen.getByText(/UI-selected candidate/)).toHaveTextContent('No active promotion');
  await send('Independent turn');
  expect(await screen.findByText('Candidate reply')).toBeInTheDocument();
  expect(bodies).toEqual([{ input: 'Independent turn', store: false, stream: true }]);
  expect(selector).toBeDisabled();
  expect(screen.getByText(/Stateless requests/)).toHaveTextContent('display-only');
  await waitFor(() => expect(screen.queryByRole('button', { name: 'Cancel' })).not.toBeInTheDocument());
  fireEvent.click(screen.getByRole('button', { name: 'New conversation' }));
  expect(selector).toBeEnabled();
});

it('does not invoke a different release returned for an exact selection', async () => {
  const invoke = vi.fn();
  server.use(
    ...discovery(() => release('other')),
    http.post('*/agents/demo/versions/other/responses', invoke),
  );
  renderWithProviders(
    <Routes><Route path="/agents/:name" element={<PromptAgentPlayground />} /></Routes>,
    { route: '/agents/demo?version=requested' },
  );
  await send('First');
  expect(await screen.findByRole('alert')).toHaveTextContent('Selected release is unavailable');
  expect(invoke).not.toHaveBeenCalled();
});

it('requests exact opaque releases and preserves retained inventory order/status', async () => {
  let requested: string | null = null;
  server.use(
    ...discovery((version) => {
      requested = version ?? null;
      return new HttpResponse(null, { status: 404 });
    }),
    http.get('*/v1/agents/demo/versions', () => HttpResponse.json({ object: 'list',
      data: ['zebra', 'amber'].map((version, index) => ({
        name: 'demo', version, created_at: 1, status: index ? 'Available' : 'Retired',
        endpoint: index ? release().endpoint : null, definitionDigest: 'digest',
        requestedActive: false, active: Boolean(index),
      })),
    })),
  );
  await expect(getAgent('demo', 'opaque-release')).rejects.toThrow('404');
  expect(requested).toBe('opaque-release');
  const versions = await listAgentVersions('demo');
  expect(versions.map((version) => [version.version, version.status])).toEqual([['zebra', 'Retired'], ['amber', 'Available']]);
});
