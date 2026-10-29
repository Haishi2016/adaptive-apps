import { fireEvent, screen } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { A2APanel } from '../routes/agents/A2APanel';
import { server } from '../mocks/server';
import { renderWithProviders } from './testUtils';

describe('A2APanel', () => {
  it('shows read-only configuration and retains live validation and calls', async () => {
    renderWithProviders(<A2APanel name="trip-scout" />);
    await screen.findByTestId('a2a-resolved-card');
    expect(screen.getByLabelText('Public well-known URL')).toHaveAttribute('readonly');
    expect(screen.queryByRole('switch')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /save|add|remove/i })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Validate live card' }));
    expect(await screen.findByText('Live card matches declared card.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(await screen.findByTestId('a2a-test-result')).toHaveTextContent('Mock peer reply');
  });

  it('surfaces failed validation and test calls', async () => {
    server.use(
      http.post('*/v1/agents/:name/agent-card/validate', () => new HttpResponse(null, { status: 502 })),
      http.post('*/v1/agents/:name/a2a/test-call', () => new HttpResponse(null, { status: 503 })),
    );
    renderWithProviders(<A2APanel name="trip-scout" />);
    await screen.findByTestId('a2a-resolved-card');
    fireEvent.click(screen.getByRole('button', { name: 'Validate live card' }));
    expect(await screen.findByText(/502/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(await screen.findByText(/503/)).toBeInTheDocument();
  });

  it('does not offer test calls without configured peers', async () => {
    server.use(http.get('*/v1/agents/:name/agent-card', () => HttpResponse.json({
      enabled: false, declared: {}, resolved: {}, resolvedCardHash: 'none',
      allowedCallers: [], peers: [],
    })));
    renderWithProviders(<A2APanel name="trip-scout" />);
    await screen.findByTestId('a2a-resolved-card');
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
    expect(screen.getByText('No configured peers')).toBeInTheDocument();
  });
});
