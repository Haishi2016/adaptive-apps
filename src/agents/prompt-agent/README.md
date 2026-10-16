# Prompt Agent

Native prompt-agent Responses host. The Dockerfile's source paths use
`agents/prompt-agent`.
The native Radius recipe creates a configured singleton for each prompt agent, just as it
spawns hosted agents. There is no shared prompt service or operational API hop.
Deployment supplies instructions, model binding, supported tools and direct Keycloak
client-credentials configuration through `KEYCLOAK_TOKEN_URL`, `KEYCLOAK_CLIENT_ID`
and `KEYCLOAK_CLIENT_SECRET`. Prompt MCP and skills are currently rejected.

The built-in `graph_me` verifies the real profile against the request's selected
user, then returns `[REDACTED]` for the ID, display name and username/email.
Personal profile values are not included in the model-visible tool result.

Run `just lint`, `just test` or `just image` here, or
`just --justfile src/Justfile image prompt-agent` from the repository root.
See [native agents](../../../docs/agents/native-radius.md)
for native Radius delivery.
