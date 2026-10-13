import { fireEvent, screen, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { Route, Routes } from 'react-router-dom';
import { server } from '../mocks/server';
import { AgentsList } from '../routes/agents/AgentsList';
import { renderWithProviders } from './testUtils';

describe('AgentsList', () => {
  it('renders native active fields and metadata without inferring readiness from release inventory', async () => {
    server.use(
      http.get('*/v1/agents', () => HttpResponse.json({ object: 'list', data: [{
        name: 'native-agent', type: 'prompt', version: 'effective',
        requestedActiveVersion: 'candidate', activeVersion: 'effective', endpoint: null,
        phase: 'Pending', created: 0, description: 'Captured description',
      }] })),
      http.get('*/v1/agents/native-agent/versions', () => HttpResponse.json({ object: 'list', data: [{
        name: 'native-agent', version: 'candidate', status: 'Available',
        endpoint: '/agents/native-agent/versions/candidate/responses',
        definitionDigest: 'digest', requestedActive: true, active: false,
      }] })),
    );
    renderWithProviders(<AgentsList />, { route: '/agents' });
    const row = (await screen.findByText('native-agent')).closest<HTMLElement>('[role="row"]')!;
    expect(await within(row).findByText('candidate · Available')).toBeInTheDocument();
    expect(within(row).getByText('Pending')).toBeInTheDocument();
    expect(within(row).getByText('candidate')).toBeInTheDocument();
    expect(within(row).getByText('effective')).toBeInTheDocument();
    expect(within(row).getByText('Captured description')).toBeInTheDocument();
    expect(within(row).queryByText('—')).not.toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: 'Active readiness' })).toBeInTheDocument();
  });

  it('shows immutable release readiness even when no active version is projected', async () => {
    server.use(
      http.get('*/v1/agents', () => HttpResponse.json({ object: 'list', data: [{
        name: 'demo', type: 'prompt', version: null, requestedActiveVersion: null, activeVersion: null, endpoint: null,
      }] })),
      http.get('*/v1/agents/demo/versions', () => HttpResponse.json({ object: 'list', data: [{
        name: 'demo', version: 'candidate', status: 'Available', endpoint: '/agents/demo/versions/candidate/responses',
        definitionDigest: null, requestedActive: false, active: false,
      }] })),
    );
    renderWithProviders(<AgentsList />, { route: '/agents' });
    expect(await screen.findByText('candidate · Available')).toBeInTheDocument();
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
