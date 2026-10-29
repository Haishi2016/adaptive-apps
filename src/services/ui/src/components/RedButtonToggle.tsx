import {
  Button,
  Dialog,
  DialogActions,
  DialogBody,
  DialogContent,
  DialogSurface,
  DialogTitle,
  DialogTrigger,
  Spinner,
  Switch,
  Text,
  Toast,
  ToastTitle,
  Toaster,
  useToastController,
} from '@fluentui/react-components';
import { useState } from 'react';
import { useConnectivityFaultStore } from '../state/connectivityFault';

const toasterId = 'red-button-toggle-toaster';

function modeSwitchErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Mode switch failed';
}

export function RedButtonToggle(): JSX.Element {
  const mode = useConnectivityFaultStore((state) => state.enabled);
  const isLoading = useConnectivityFaultStore((state) => state.isLoading);
  const error = useConnectivityFaultStore((state) => state.error);
  const setEnabled = useConnectivityFaultStore((state) => state.setEnabled);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const { dispatchToast } = useToastController(toasterId);

  const showModeSwitchError = (caught: unknown): void => {
    const message = modeSwitchErrorMessage(caught);
    dispatchToast(
      <Toast data-testid="mode-switch-error-toast">
        <ToastTitle>{message}</ToastTitle>
      </Toast>,
      { intent: 'error' },
    );
  };

  const switchToConnected = (): void => {
    void setEnabled(false).catch(showModeSwitchError);
  };

  const confirmRedButton = (): void => {
    void setEnabled(true)
      .then(() => setConfirmOpen(false))
      .catch(showModeSwitchError);
  };

  return (
    <>
      <div className="red-button-toggle">
        <Switch
          aria-label="Red button"
          checked={mode}
          disabled={isLoading}
          onChange={(_, data) => {
            if (data.checked) {
              setConfirmOpen(true);
            } else {
              switchToConnected();
            }
          }}
        />
        <Text size={200}>Red button</Text>
        {isLoading ? <Spinner size="tiny" /> : null}
        {error ? <Text role="alert" className="error-text">{error}</Text> : null}
      </div>
      <Dialog open={confirmOpen} onOpenChange={(_, data) => setConfirmOpen(data.open)}>
        <DialogSurface>
          <DialogBody>
            <DialogTitle>Simulate cloud outage?</DialogTitle>
            <DialogContent>
              Block new cloud HTTPS connections for agent workloads and the model gateway.
              Local identity and configured local models remain available. No Pods are restarted.
              Existing connections may persist until the network plugin applies the policy.
              {error ? <Text className="error-text">{error}</Text> : null}
            </DialogContent>
            <DialogActions>
              <DialogTrigger disableButtonEnhancement>
                <Button appearance="secondary">Cancel</Button>
              </DialogTrigger>
              <Button appearance="primary" onClick={confirmRedButton} disabled={isLoading}>
                Simulate outage
              </Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>
      <Toaster toasterId={toasterId} position="top-end" />
    </>
  );
}
