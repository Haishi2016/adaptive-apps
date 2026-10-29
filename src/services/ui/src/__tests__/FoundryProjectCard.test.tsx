import { fireEvent, screen } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { FoundryProjectCard } from '../components/FoundryProjectCard';
import { server } from '../mocks/server';
import { renderWithProviders } from './testUtils';

const endpoint = 'https://myproj.services.ai.azure.com/api/projects/edge-prod';

describe('FoundryProjectCard', () => {
  it.each([true, false])('shows configured project state, enabled=%s, without mutations', async (enabled) => {
    server.use(http.get('*/v1/environment', () => HttpResponse.json({
      name: 'default-edge',
      clusterMode: 'connected',
      cloud: { enabled, foundryProjectEndpoint: enabled ? endpoint : null },
    })));
    renderWithProviders(<FoundryProjectCard />);
    expect(await screen.findByText(enabled ? 'edge-prod' : 'No cloud project')).toBeInTheDocument();
    expect(screen.getByText(enabled ? 'Cloud' : 'Edge-only')).toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    if (enabled) {
      const trigger = screen.getByText('edge-prod').parentElement;
      expect(trigger).not.toBeNull();
      fireEvent.focus(trigger as HTMLElement);
      expect(await screen.findByRole('tooltip')).toHaveTextContent(endpoint);
    }
  });

  it('surfaces environment-read failures instead of claiming edge-only state', async () => {
    server.use(http.get('*/v1/environment', () => new HttpResponse(null, { status: 500 })));
    renderWithProviders(<FoundryProjectCard />);
    expect(await screen.findByText('Environment unavailable')).toBeInTheDocument();
    expect(screen.queryByText('Edge-only')).not.toBeInTheDocument();
  });
});
