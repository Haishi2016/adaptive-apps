import { screen, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { App } from '../App';
import { server } from '../mocks/server';
import { renderWithProviders } from './testUtils';

describe('App', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('shows only supported navigation and defaults unknown routes to Models', async () => {
    renderWithProviders(<App />, { route: '/evaluations/new' });

    expect(await screen.findByText('qwen2.5-7b-instruct')).toBeInTheDocument();
    expect(screen.getByText('Adaptive AI')).toBeInTheDocument();
    const links = within(screen.getByRole('navigation', { name: 'Primary' })).getAllByRole('link');
    expect(links.map((link) => link.textContent)).toEqual(['Agents', 'Tools', 'Models', 'Guardrails']);
    expect(screen.queryByText(/evaluation/i)).not.toBeInTheDocument();
    expect(links.find((link) => link.textContent === 'Models')).toHaveAttribute('aria-current', 'page');
  });

  it('does not report a healthy fault configuration after the API fails', async () => {
    server.use(http.get('*/v1/connectivity-fault', () => new HttpResponse(null, { status: 503 })));
    const { unmount } = renderWithProviders(<App />);
    expect(await screen.findByText('Fault status unavailable')).toBeInTheDocument();
    expect(screen.queryByText('No outage injected')).not.toBeInTheDocument();
    unmount();
  });

  it('uses the trading shell in embedded mode without independent controls', async () => {
    vi.stubEnv('VITE_EMBEDDED', 'true');
    renderWithProviders(<App />);

    expect(await screen.findByText('Trading Agents')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Back to Trading/ })).toHaveAttribute('href', '/');
    const links = within(screen.getByRole('navigation', { name: 'Primary' })).getAllByRole('link');
    expect(links.map((link) => link.textContent)).toEqual(['Agents']);
    expect(screen.queryByText('Models')).not.toBeInTheDocument();
    expect(screen.queryByText('Tools')).not.toBeInTheDocument();
    expect(screen.queryByText('Guardrails')).not.toBeInTheDocument();
    expect(screen.queryByText(/outage/i)).not.toBeInTheDocument();
  });
});
