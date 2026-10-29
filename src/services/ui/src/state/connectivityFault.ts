import { create } from 'zustand';
import { getConnectivityFault, patchConnectivityFault } from '../api/client';

type ConnectivityFaultState = {
  enabled: boolean;
  isLoading: boolean;
  error?: string;
  refresh: () => Promise<void>;
  setEnabled: (next: boolean) => Promise<void>;
  start: () => void;
  stop: () => void;
};

let pollHandle: number | undefined;

export const useConnectivityFaultStore = create<ConnectivityFaultState>((set, get) => ({
  enabled: false,
  isLoading: false,
  error: undefined,

  refresh: async () => {
    set({ isLoading: true });
    try {
      const state = await getConnectivityFault();
      set({ enabled: state.enabled, isLoading: false, error: undefined });
    } catch (error) {
      set({ isLoading: false, error: error instanceof Error ? error.message : 'Fault status unavailable' });
    }
  },

  setEnabled: async (next: boolean) => {
    set({ isLoading: true, error: undefined });

    try {
      const accepted = await patchConnectivityFault(next);
      set({ enabled: accepted.enabled });
    } catch (error) {
      set({
        isLoading: false,
        error: error instanceof Error ? error.message : 'Fault injection failed',
      });
      throw error;
    }

    try {
      const state = await getConnectivityFault();
      set({ enabled: state.enabled, isLoading: false, error: undefined });
    } catch (error) {
      set({ isLoading: false, error: error instanceof Error ? error.message : 'Fault status unavailable' });
      throw error;
    }
  },

  start: () => {
    void get().refresh();
    if (pollHandle === undefined && typeof window !== 'undefined') {
      pollHandle = window.setInterval(() => {
        void get().refresh();
      }, 10_000);
    }
  },

  stop: () => {
    if (pollHandle !== undefined) {
      window.clearInterval(pollHandle);
      pollHandle = undefined;
    }
  },
}));
