import { fireEvent, screen } from '@testing-library/react';
import { Route, Routes } from 'react-router-dom';
import { http, HttpResponse } from 'msw';
import { HostedAgentPlayground } from '../routes/agents/HostedAgentPlayground';
import { useConnectivityFaultStore } from '../state/connectivityFault';
import { server } from '../mocks/server';
import { renderWithProviders } from './testUtils';

describe('HostedAgentPlayground tabs', () => {
  afterEach(() => {
    localStorage.clear();
    vi.unstubAllEnvs();
  });

  it('limits the embedded playground to chat and monitor', async () => {
    vi.stubEnv('VITE_EMBEDDED', 'true');
    renderWithProviders(
      <Routes><Route path="/:name/hosted" element={<HostedAgentPlayground />} /></Routes>,
      { route: '/trip-scout/hosted' },
    );
    await screen.findByLabelText('Message the hosted agent...');
    expect(screen.getAllByRole('tab')).toHaveLength(2);
    expect(screen.getByRole('tab', { name: 'Chat' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Monitor' })).toBeInTheDocument();
    expect(screen.queryByText('Guardrails')).not.toBeInTheDocument();
    expect(screen.queryByText('A2A')).not.toBeInTheDocument();
  });

  it('preserves chat draft while switching to Monitor and back', async () => {
    renderWithProviders(
      <Routes>
        <Route path="/agents/:name/hosted" element={<HostedAgentPlayground />} />
      </Routes>,
      { route: '/agents/trip-scout/hosted' },
    );

    const composer = await screen.findByLabelText('Message the hosted agent...');
    expect(screen.getAllByRole('tab')).toHaveLength(4);
    for (const name of ['Chat', 'Monitor', 'Guardrails', 'A2A']) {
      expect(screen.getByRole('tab', { name })).toBeInTheDocument();
    }
    fireEvent.change(composer, { target: { value: 'find a beach trip' } });

    fireEvent.click(screen.getByRole('tab', { name: 'Monitor' }));
    fireEvent.click(screen.getByRole('tab', { name: 'Guardrails' }));
    expect(await screen.findByText('Policies: none attached')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('tab', { name: 'Chat' }));

    expect(screen.getByLabelText('Message the hosted agent...')).toHaveValue('find a beach trip');
    expect(screen.getByText(/Hosted-agent tools are defined in the container’s code/)).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'Agent user' })).toBeDisabled();
  });

  it('blocks hosted delegation and calls the native release as app in red-button mode', async () => {
    useConnectivityFaultStore.setState({ enabled: true });
    localStorage.setItem('adaptive.authToken', 'broker-token');
    localStorage.setItem('adaptive.providerToken', 'local-user-token');
    let bearer: string | null = 'not called';
    let identity: string | null = null;
    server.use(http.post('*/agents/trip-scout/responses', ({ request }) => {
      bearer = request.headers.get('X-Adaptive-User-Token');
      identity = request.headers.get('X-Impersonation-Mode');
      return new HttpResponse('data: {"type":"response.output_text.delta","delta":"Local reply"}\n\ndata: {"type":"response.completed","response":{"id":"resp-local","status":"completed"}}\n\n', {
        headers: { 'Content-Type': 'text/event-stream' },
      });
    }));
    const { unmount } = renderWithProviders(
      <Routes><Route path="/agents/:name/hosted" element={<HostedAgentPlayground />} /></Routes>,
      { route: '/agents/trip-scout/hosted' },
    );
    await screen.findAllByText('adaptiveghcracr1.azurecr.io/adaptive/trip-scout:dev');
    expect(screen.getByRole('radio', { name: 'On behalf of me' })).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Message the hosted agent...'), { target: { value: 'Hello locally' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(await screen.findByText('Local reply')).toBeInTheDocument();
    expect(bearer).toBeNull();
    expect(identity).toBe('app');
    unmount();
  });
});
