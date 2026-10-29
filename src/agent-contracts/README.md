# Portable agent contracts

This package defines host-neutral contracts used by portable agents:

* logical agent, workload and caller identity values;
* invocation-scoped agent and delegated credentials;
* separate conversation-history and durable-checkpoint stores;
* OpenTelemetry tracer and meter primitives;
* asynchronous token acquisition;
* logical agent references and endpoint resolution; and
* declared and required hosting capabilities.

The package contains no Kubernetes, Foundry, Keycloak, Entra or HTTP-server
implementation. Local agents that are always co-hosted as part of one
application do not need to adopt these contracts.
