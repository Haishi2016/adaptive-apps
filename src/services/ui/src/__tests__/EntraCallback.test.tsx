import { screen, waitFor } from '@testing-library/react';
import { UserManager } from 'oidc-client-ts';
import { afterEach, beforeEach, vi } from 'vitest';
import { App } from '../App';
import { useAuthStore } from '../auth/store';
import { linkedUser } from './graphFixtures';
import { renderWithProviders } from './testUtils';

beforeEach(() => {
  vi.stubEnv('VITE_KEYCLOAK_AUTHORITY', linkedUser.iss);
  useAuthStore.setState({ status: 'authenticated', user: linkedUser });
});

afterEach(() => {
  vi.mocked(UserManager.prototype.signinPopupCallback).mockRestore();
  vi.unstubAllEnvs();
  useAuthStore.setState({ status: 'unknown', user: undefined });
});

it('uses the native popup transport outside the auth gate without replacing Keycloak login', async () => {
  const callback = vi.spyOn(UserManager.prototype, 'signinPopupCallback').mockResolvedValue();
  renderWithProviders(<App />, { route: '/auth/entra-callback' });
  expect(screen.getByText('Completing Entra sign-in…')).toBeInTheDocument();
  await waitFor(() => expect(callback).toHaveBeenCalledWith(window.location.href));
  expect(useAuthStore.getState().user).toEqual(linkedUser);
});

it('shows an honest callback failure without redirecting to Keycloak login', async () => {
  vi.spyOn(UserManager.prototype, 'signinPopupCallback').mockRejectedValue(new Error('No popup opener'));
  renderWithProviders(<App />, { route: '/auth/entra-callback' });
  expect(await screen.findByRole('alert')).toHaveTextContent('No popup opener');
  expect(useAuthStore.getState().status).toBe('authenticated');
});
