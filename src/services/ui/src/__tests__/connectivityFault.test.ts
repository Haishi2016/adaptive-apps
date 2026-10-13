import { waitFor } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { server } from '../mocks/server';
import { useConnectivityFaultStore } from '../state/connectivityFault';

const redButtonState = { enabled: true, policyName: 'demo-cloud-egress', namespace: 'adaptive' };

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolvePromise: (() => void) | undefined;
  const promise = new Promise<void>((resolve) => {
    resolvePromise = resolve;
  });
  return { promise, resolve: () => resolvePromise?.() };
}

describe('demo connectivity fault store', () => {
  it('reads fault configuration, not actual connectivity', async () => {
    server.use(
      http.get('*/v1/connectivity-fault', () => HttpResponse.json(redButtonState)),
    );
    await useConnectivityFaultStore.getState().refresh();
    expect(useConnectivityFaultStore.getState().enabled).toBe(true);
    expect(useConnectivityFaultStore.getState().error).toBeUndefined();
  });

  it('keeps the observed mode until PATCH succeeds and re-fetches confirmation', async () => {
    let getCalled = false;
    server.use(
      http.patch('*/v1/connectivity-fault', () => HttpResponse.json(redButtonState)),
      http.get('*/v1/connectivity-fault', () => {
        getCalled = true;
        return HttpResponse.json(redButtonState);
      }),
    );

    const switchPromise = useConnectivityFaultStore.getState().setEnabled(true);

    expect(useConnectivityFaultStore.getState().enabled).toBe(false);
    expect(useConnectivityFaultStore.getState().isLoading).toBe(true);

    await switchPromise;

    expect(getCalled).toBe(true);
    expect(useConnectivityFaultStore.getState().enabled).toBe(true);
    expect(useConnectivityFaultStore.getState().isLoading).toBe(false);
  });

  it('keeps the observed mode when PATCH fails', async () => {
    const patchGate = deferred();
    server.use(
      http.patch('*/v1/connectivity-fault', async () => {
        await patchGate.promise;
        return HttpResponse.json({ code: 'Conflict', message: 'Conflict' }, { status: 409 });
      }),
    );

    const switchPromise = useConnectivityFaultStore.getState().setEnabled(true);

    expect(useConnectivityFaultStore.getState().enabled).toBe(false);
    expect(useConnectivityFaultStore.getState().isLoading).toBe(true);

    patchGate.resolve();

    await expect(switchPromise).rejects.toThrow('PATCH /v1/connectivity-fault failed with 409');
    await waitFor(() => expect(useConnectivityFaultStore.getState().enabled).toBe(false));
    expect(useConnectivityFaultStore.getState().isLoading).toBe(false);
    expect(useConnectivityFaultStore.getState().error).toBe(
      'PATCH /v1/connectivity-fault failed with 409: Conflict',
    );
  });
});
