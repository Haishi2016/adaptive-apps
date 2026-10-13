import { fireEvent, screen, waitFor } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { RedButtonToggle } from '../components/RedButtonToggle';
import { server } from '../mocks/server';
import { useConnectivityFaultStore } from '../state/connectivityFault';
import { renderWithProviders } from './testUtils';

const redButtonState = { enabled: true, policyName: 'demo-cloud-egress', namespace: 'adaptive' };

describe('RedButtonToggle', () => {
  it('requires confirmation before switching to red-button mode and sends a PATCH body', async () => {
    let patchBody: unknown;
    server.use(
      http.patch('*/v1/connectivity-fault', async ({ request }) => {
        patchBody = await request.json();
        return HttpResponse.json(redButtonState);
      }),
      http.get('*/v1/connectivity-fault', () => HttpResponse.json(redButtonState)),
    );
    renderWithProviders(<RedButtonToggle />);

    fireEvent.click(screen.getByRole('switch', { name: /red button/i }));

    expect(useConnectivityFaultStore.getState().enabled).toBe(false);
    expect(await screen.findByText('Simulate cloud outage?')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /simulate outage/i }));

    await waitFor(() => expect(useConnectivityFaultStore.getState().enabled).toBe(true));
    expect(patchBody).toEqual({ enabled: true });
  });

  it('shows an error toast when the mode switch fails', async () => {
    server.use(
      http.patch('*/v1/connectivity-fault', () =>
        HttpResponse.json({ code: 'KubernetesError', message: 'Patch failed' }, { status: 500 }),
      ),
    );
    renderWithProviders(<RedButtonToggle />);

    fireEvent.click(screen.getByRole('switch', { name: /red button/i }));
    fireEvent.click(await screen.findByRole('button', { name: /simulate outage/i }));

    expect(await screen.findByTestId('mode-switch-error-toast')).toHaveTextContent(
      'PATCH /v1/connectivity-fault failed with 500',
    );
  });
});
