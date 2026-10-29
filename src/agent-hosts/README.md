# Portable agent hosting adapters

This package contains reusable hosting adapters for portable agents. The
current adapters resolve peer agents from deployment environment bindings and
acquire agent credentials from Keycloak.

Portable agent behavior depends only on `adaptive-agent-contracts`. Executable
hosts compose that behavior with this package and a protocol host such as the
Foundry-compatible Responses server.

`KubernetesResponsesHost` is the host-neutral Kubernetes ASGI adapter. Its
current capability set is intentionally limited to non-streaming foreground
Responses calls with `store: false`. It returns an explicit `501` response for
stored responses, background execution and streaming rather than emulating
those semantics. The existing Foundry-compatible adapter remains available for
clients that require those capabilities.
