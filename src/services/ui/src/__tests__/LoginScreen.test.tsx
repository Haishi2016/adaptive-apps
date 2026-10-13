import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LoginScreen } from '../auth/LoginScreen';
import { useAuthStore } from '../auth/store';
import { useConnectivityFaultStore } from '../state/connectivityFault';
import { renderWithProviders } from './testUtils';

const originalLogin = useAuthStore.getState().login;

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  useAuthStore.setState({ login: originalLogin, status: 'unknown', user: undefined, error: undefined });
});

describe('Keycloak sign-in screen', () => {
  it.each([false, true])('uses the same explicit sign-in with fault injection %s', async (enabled) => {
    const login = vi.fn().mockResolvedValue(undefined);
    useAuthStore.setState({ login });
    useConnectivityFaultStore.setState({ enabled });
    const refresh = vi.spyOn(useConnectivityFaultStore.getState(), 'refresh');
    renderWithProviders(<LoginScreen />);
    expect(screen.getByText('Adaptive AI')).toBeInTheDocument();
    expect(login).not.toHaveBeenCalled();
    expect(refresh).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Sign in' })).toBeEnabled());
    expect(login).toHaveBeenCalledOnce();
    expect(login).toHaveBeenCalledWith();
  });

  it('shows login errors without creating an automatic redirect loop', () => {
    const login = vi.fn();
    useAuthStore.setState({ login, error: 'Login failed' });
    renderWithProviders(<LoginScreen />);
    expect(screen.getByRole('alert')).toHaveTextContent('Login failed');
    expect(login).not.toHaveBeenCalled();
  });
});
