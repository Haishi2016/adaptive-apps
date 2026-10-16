import { fireEvent, screen, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { Route, Routes } from 'react-router-dom';
import { server } from '../mocks/server';
import { AgentsList } from '../routes/agents/AgentsList';
import { renderWithProviders } from './testUtils';

describe('AgentsList', () => {
  it('renders current runtime readiness and metadata', async () => {
    server.use(
      http.get('*/v1/agents', () => HttpResponse.json({ object: 'list', data: [{
        name: 'native-agent', type: 'prompt', endpoint: null,
        phase: 'Pending', created: 0, description: 'Current description',
      }] })),
    );
    renderWithProviders(<AgentsList />, { route: '/agents' });
    const row = (await screen.findByText('native-agent')).closest<HTMLElement>('[role="row"]')!;
    expect(within(row).getByText('Pending')).toBeInTheDocument();
    expect(within(row).getByText('Current description')).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: 'Runtime readiness' })).toBeInTheDocument();
  });
  it('shows existing agents without management actions', async () => {
    renderWithProviders(<AgentsList />, { route: '/agents' });
    expect(await screen.findByText('handoff-service')).toBeInTheDocument();
    expect(screen.getByText('trip-scout')).toBeInTheDocument();
    expect(screen.getByText(/Manage deployments through Radius/)).toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it.each(['handoff-service', 'trip-scout'])('opens the playground for %s', async (name) => {
    renderWithProviders(
      <Routes>
        <Route path="/agents" element={<AgentsList />} />
        <Route path="/agents/:name/:kind" element={<div>Agent playground</div>} />
      </Routes>,
      { route: '/agents' },
    );
    fireEvent.click(await screen.findByText(name));
    expect(await screen.findByText('Agent playground')).toBeInTheDocument();
  });
});
