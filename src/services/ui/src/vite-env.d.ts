/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_AUTH_TOKEN?: string;
  readonly VITE_GATEWAY_URL?: string;
  readonly VITE_MOCK_BACKEND?: string;
  readonly VITE_TENANT_NAME?: string;
  readonly VITE_AUTH_ENABLED?: string;
  readonly VITE_KEYCLOAK_AUTHORITY?: string;
  readonly VITE_KEYCLOAK_CLIENT_ID?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
