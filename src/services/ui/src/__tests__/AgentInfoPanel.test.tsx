import { screen } from '@testing-library/react';
import { AgentInfoPanel } from '../components/AgentInfoPanel';
import { useConnectivityFaultStore } from '../state/connectivityFault';
import { renderWithProviders } from './testUtils';

const identity = {
  entraClientId: 'agent-client-id',
  blueprintId: 'agent-blueprint-id',
  keycloakClientId: 'local-client-id',
};

describe('AgentInfoPanel', () => {
  it('shows the actual local client separately from retained Entra configuration', () => {
    useConnectivityFaultStore.setState({ enabled: true });
    renderWithProviders(<AgentInfoPanel identity={identity} />);

    expect(screen.getByText('Local agent identity')).toBeInTheDocument();
    expect(screen.queryByText('Local agent blueprint')).not.toBeInTheDocument();
    expect(screen.getByText('Entra agent blueprint')).toBeInTheDocument();
    expect(screen.getByTestId('agent-identity-value')).toHaveTextContent('local-client-id');
    expect(screen.getByTestId('entra-identity-value')).toHaveTextContent('agent-client-id');
    expect(screen.getByTestId('agent-blueprint-value')).toHaveTextContent('agent-blueprint-id');
    expect(screen.getByText(/Cloud outage injection is enabled/)).toBeInTheDocument();
  });

  it('does not invent an Entra identity or blueprint for a local-only agent', () => {
    renderWithProviders(<AgentInfoPanel identity={{ keycloakClientId: 'local-client-id' }} />);
    expect(screen.getByTestId('agent-identity-value')).toHaveTextContent('local-client-id');
    expect(screen.getByTestId('entra-identity-value')).toHaveTextContent('Not provisioned');
    expect(screen.getByTestId('agent-blueprint-value')).toHaveTextContent('Not provisioned');
  });
});
