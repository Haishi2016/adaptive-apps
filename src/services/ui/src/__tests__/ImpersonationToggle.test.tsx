import { fireEvent, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ImpersonationToggle } from '../components/ImpersonationToggle';
import { renderWithProviders } from './testUtils';

describe('ImpersonationToggle', () => {
  it('explains the requested caller without promising resource delegation and reports changes', () => {
    const onChange = vi.fn();
    renderWithProviders(<ImpersonationToggle value="app" onChange={onChange} allowedModes={['app', 'agentUser']} />);

    expect(screen.getByRole('note')).toHaveTextContent(/Requests the agent’s own app identity/);
    expect(screen.getByText(/downstream execution identity can differ/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('radio', { name: 'Agent user' }));
    expect(onChange).toHaveBeenCalledWith('agentUser');
  });

  it('updates the explainer to the selected identity', () => {
    renderWithProviders(<ImpersonationToggle value="agentUser" onChange={() => {}} />);
    expect(screen.getByRole('note')).toHaveTextContent(/worker identity/);
    expect(screen.getByRole('note')).toHaveTextContent(/Keycloak mirror does not confirm Entra setup/);
  });

  it('disables unsupported tool identities without restricting hosted defaults', () => {
    renderWithProviders(
      <ImpersonationToggle value="app" onChange={() => {}} allowedModes={['app']} />,
    );
    expect(screen.getByRole('radio', { name: 'App' })).toBeEnabled();
    expect(screen.getByRole('radio', { name: 'On behalf of me' })).toBeDisabled();
    expect(screen.getByRole('radio', { name: 'Agent user' })).toBeDisabled();
  });

  it('requires explicit capabilities rather than promising login enables delegation', () => {
    renderWithProviders(
      <ImpersonationToggle value="app" onChange={() => {}} />,
    );
    expect(screen.getByRole('radio', { name: 'On behalf of me' })).toBeDisabled();
    expect(screen.getByText(/OBO requires connected mode/)).toBeInTheDocument();
  });

  it('enables approved OBO and pins every radio once started', () => {
    const onChange = vi.fn();
    const { rerender } = renderWithProviders(
      <ImpersonationToggle value="endUserOBO" onChange={onChange} allowedModes={['app', 'endUserOBO', 'agentUser']} />,
    );
    expect(screen.getByRole('radio', { name: 'On behalf of me' })).toBeEnabled();
    rerender(<ImpersonationToggle value="endUserOBO" onChange={onChange} allowedModes={['app', 'endUserOBO', 'agentUser']} disabled />);
    for (const radio of screen.getAllByRole('radio')) expect(radio).toBeDisabled();
  });
});
