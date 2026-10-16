# Editor

An ordinary hosted Agent Framework image calls stable agent routes through the
OpenAI Responses SDK: writer first, then auditor with the draft and original
request. It returns both results as Markdown sections labelled
with each specialist's name and pinned version, visible in the chat playground.
The auditor receives the writer's text, not display labels.
Failed, incomplete or empty responses abort the sequence; no automatic retries,
fallback, discovery or runtime provisioning are performed.

Required bindings are `WRITER_NAME`, `WRITER_VERSION`, `WRITER_RESPONSES_BASE_URL`,
`AUDITOR_NAME`, `AUDITOR_VERSION` and `AUDITOR_RESPONSES_BASE_URL`.
Each base URL ends in `/agents/{name}/`; the SDK appends
`responses`. Credentials, query strings and unpinned paths are rejected.
Authentication uses direct Keycloak OAuth client credentials configured by
`KEYCLOAK_TOKEN_URL`, `KEYCLOAK_CLIENT_ID` and `KEYCLOAK_CLIENT_SECRET`.
Both calls explicitly disable server-side storage.
Edge supplies identity sidecars and bindings. The Responses host SDK is retained;
no Foundry project or agent client is used. Cloud-specific routing/user delegation
and same-image Foundry hosting remain unqualified.
The image contains no Adaptive client library or Kubernetes/Radius access.

See the [native agent guide](../../../docs/agents/native-radius.md)
for native Radius delivery.
