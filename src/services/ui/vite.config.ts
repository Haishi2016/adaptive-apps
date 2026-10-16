import react from '@vitejs/plugin-react';
import { loadEnv } from 'vite';
import { defineConfig } from 'vitest/config';

// Development uses the same native authorization boundary as the shipped UI.
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const target = env.AGENT_INGRESS_URL ?? 'http://127.0.0.1:8091';
  const embedded = env.VITE_EMBEDDED === 'true';
  return {
    base: embedded ? '/agents/' : '/',
    plugins: [react()],
    server: {
      proxy: {
        '/models/v1': {
          target: env.MODEL_INGRESS_URL ?? 'http://127.0.0.1:8092',
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/models(?=\/v1(?:\/|$))/, ''),
        },
        '^/agents/[^/]+/': {
          target,
          changeOrigin: true,
        },
        '/v1': {
          target,
          changeOrigin: true,
        },
      },
    },
    test: {
      environment: 'jsdom',
      maxWorkers: 2,
      minWorkers: 1,
      setupFiles: './src/setupTests.ts',
      css: true,
      globals: true,
      exclude: ['node_modules', 'dist', 'e2e/**'],
    },
  };
});
