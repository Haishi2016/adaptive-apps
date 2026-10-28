import { FluentProvider } from '@fluentui/react-components';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { App } from './App';
import { embeddedMode } from './auth/config';
import './styles.css';
import { adaptiveTheme } from './theme';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      refetchOnWindowFocus: false,
    },
  },
});

async function enableMocking(): Promise<void> {
  if (import.meta.env.VITE_MOCK_BACKEND === 'true') {
    const { worker } = await import('./mocks/browser');
    await worker.start({ onUnhandledRequest: 'bypass' });
  }
}

void enableMocking().then(() => {
  ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
    <React.StrictMode>
      <FluentProvider theme={adaptiveTheme}>
        <QueryClientProvider client={queryClient}>
          <BrowserRouter basename={embeddedMode() ? '/agents' : undefined}>
            <App />
          </BrowserRouter>
        </QueryClientProvider>
      </FluentProvider>
    </React.StrictMode>,
  );
});
