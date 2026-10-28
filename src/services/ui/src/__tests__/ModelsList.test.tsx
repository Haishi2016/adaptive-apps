import { screen } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { ModelsList } from '../routes/models/ModelsList';
import { server } from '../mocks/server';
import { renderWithProviders } from './testUtils';

describe('ModelsList', () => {
  it.each([503, 'invalid'] as const)('reports gateway discovery failure (%s) without API fallback', async (failure) => {
    let apiCalls = 0;
    server.use(
      http.get('*/models/v1/models', () => failure === 'invalid'
        ? HttpResponse.json({ data: [{}] })
        : HttpResponse.json({ message: 'Unavailable' }, { status: failure })),
      http.get('*/v1/models', () => {
        apiCalls += 1;
        return HttpResponse.json({ object: 'list', data: [] });
      }),
    );
    renderWithProviders(<ModelsList />, { route: '/models' });
    expect(await screen.findByRole('alert')).toHaveTextContent('Failed to load models.');
    expect(screen.queryByText(/No models are configured/i)).not.toBeInTheDocument();
    expect(apiCalls).toBe(0);
  });

  it('renders models from the gateway', async () => {
    renderWithProviders(<ModelsList />, { route: '/models' });

    expect(await screen.findByText('qwen2.5-7b-instruct')).toBeInTheDocument();
    expect(screen.getByText('gpt-5.4-mini')).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Playground' })).toHaveLength(2);
    expect(screen.queryByRole('button', { name: /add|create|delete/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
  });

  it('shows an empty state when the cluster has no models', async () => {
    server.use(
      http.get('*/models/v1/models', () => HttpResponse.json({ object: 'list', data: [] })),
    );
    renderWithProviders(<ModelsList />, { route: '/models' });

    expect(await screen.findByText(/No models are configured/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /add model/i })).not.toBeInTheDocument();
  });

  it('shows a live download indicator while a local model provisions', async () => {
    // A local model still downloading weights must read as active work, not a
    // dead "Provisioning" label — a spinner (progressbar) sits next to it.
    server.use(
      http.get('*/models/v1/models', () =>
        HttpResponse.json({
          object: 'list',
          data: [
            {
              id: 'gpt-oss-20b',
              object: 'model',
              provider: 'huggingface',
              kind: 'single',
              status: 'Provisioning',
              owned_by: 'adaptive',
            },
          ],
        }),
      ),
    );
    renderWithProviders(<ModelsList />, { route: '/models' });

    expect(await screen.findByText('gpt-oss-20b')).toBeInTheDocument();
    expect(screen.getByText('Provisioning')).toBeInTheDocument();
    expect(screen.getByRole('progressbar')).toBeInTheDocument();
  });

  it('renders gateway-only models with no provider hint as a neutral badge', async () => {
    // Gateway discovery does not establish backend readiness.
    server.use(
      http.get('*/models/v1/models', () =>
        HttpResponse.json({
          object: 'list',
          data: [{ id: 'mystery-model', object: 'model', owned_by: 'Envoy AI Gateway' }],
        }),
      ),
    );
    renderWithProviders(<ModelsList />, { route: '/models' });

    expect(await screen.findByText('mystery-model')).toBeInTheDocument();
    expect(screen.getByText('gateway')).toBeInTheDocument();
    expect(screen.getByText('Unknown')).toBeInTheDocument();
    expect(screen.queryByText('Ready')).not.toBeInTheDocument();
  });
});
