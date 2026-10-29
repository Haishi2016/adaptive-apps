# Prompt Agent

Portable prompt-agent behavior with selectable Responses hosting adapters. The
host-neutral factory is in `adaptive_runtime/agent.py`; it knows
about instructions, tools, skills and a supplied model client, but not
Kubernetes, Foundry hosting, Keycloak, telemetry exporters or server lifecycle.

The executable selects `foundry-compatible` by default or `kubernetes` through
`AGENT_HOST_ADAPTER`. Both compose the same agent with Keycloak credentials.
The Kubernetes adapter currently supports foreground, non-streaming calls with
`store: false`; it rejects stored, background and streaming requests explicitly.
The Radius Kubernetes recipe still uses the compatibility default until its
clients are qualified against this narrower capability set. There is no shared
prompt service, lifecycle operator or operational API hop.

The built-in `graph_me` verifies the real profile against the request's selected
user, then returns `[REDACTED]` for the ID, display name and username/email.
Personal profile values are not included in the model-visible tool result.

Run `just lint`, `just test` or `just image` here, or
`just --justfile src/Justfile image prompt-agent` from the repository root.
See [portable agents](../../../docs/agents/native-radius.md)
for Radius delivery.
