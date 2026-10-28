import { screen, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { ToolsList } from '../routes/tools/ToolsList';
import { server } from '../mocks/server';
import { useConnectivityFaultStore } from '../state/connectivityFault';
import { renderWithProviders } from './testUtils';

it('renders configured builtin Graph tools without MCP endpoints', async () => {
  server.use(http.get('*/v1/tools', () => HttpResponse.json({
    object: 'list', data: [{
      name: 'demo-graph', kind: 'builtin', builtin: 'graph-me',
      displayName: 'Graph profile', description: 'Native Graph profile function',
      authType: 'entra', audience: 'https://graph.microsoft.com',
      identityModes: ['app', 'endUserOBO', 'agentUser'], executionIdentity: 'caller',
    }],
  })));
  renderWithProviders(<ToolsList />);
  const name = await screen.findByText('Graph profile');
  const row = name.closest<HTMLElement>('[role="row"]')!;
  expect(within(row).getByText('Built-in')).toBeInTheDocument();
  expect(within(row).getByText(/Native Graph tool/)).toBeInTheDocument();
  expect(screen.getByText(/with no MCP server or endpoint/)).toBeInTheDocument();
});

it('shows the platform catalogue and native attachment instructions without management actions', async () => {
  const { unmount } = renderWithProviders(<ToolsList />);
  const name = await screen.findByText('generic-mcp');
  const row = name.closest('[role="row"]');
  expect(row).not.toBeNull();
  expect(within(row as HTMLElement).getByText('MCP')).toBeInTheDocument();
  expect(within(row as HTMLElement).getByText('No authentication')).toBeInTheDocument();
  expect(screen.getByText(/chartValues.toolCatalog/)).toBeInTheDocument();
  expect(screen.getByText('project_connection_id')).toBeInTheDocument();
  expect(screen.getByText('Agent Skills')).toBeInTheDocument();
  expect(screen.getByText('definition.skills')).toBeInTheDocument();
  expect(screen.getByText('loadTextContent')).toBeInTheDocument();
  expect(screen.queryByRole('columnheader', { name: 'Endpoint' })).not.toBeInTheDocument();
  expect(screen.queryByRole('button')).not.toBeInTheDocument();
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  unmount();
});

it('distinguishes Entra MCP caller scope from server execution identity and cloud availability', async () => {
  useConnectivityFaultStore.setState({ enabled: true });
  server.use(http.get('*/v1/tools', () => HttpResponse.json({
    object: 'list',
    data: [{
      name: 'azure-mcp',
      kind: 'mcp',
      displayName: 'Azure MCP',
      description: 'Administratively configured Azure MCP server',
      authType: 'entra',
      audience: 'api://azure-mcp',
      identityModes: ['app', 'endUserOBO'],
      executionIdentity: 'server',
    }],
  })));
  const { unmount } = renderWithProviders(<ToolsList />);
  expect(await screen.findByText('Azure MCP')).toBeInTheDocument();
  expect(screen.getByText('Audience: api://azure-mcp')).toBeInTheDocument();
  expect(screen.getByText(/Agent app identity, Signed-in user \(OBO\)/)).toBeInTheDocument();
  expect(screen.getByText(/Downstream server workload identity — no caller delegation/)).toBeInTheDocument();
  expect(screen.getByRole('status')).toHaveTextContent(/Cloud-only tools may fail/i);
  unmount();
});
