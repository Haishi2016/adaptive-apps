# Governance sidecar

The locked Agent Governance Toolkit evaluates bounded default-deny policies
around model traffic. `governance_sidecar.contracts` owns validation,
canonical JSON and SHA-256; the native Radius release captures this exact
configuration and mounts it at `/policies/proxy.json`.
Detector/provider failures fail closed. Decisions retain request trace context
without exporting prompts or authorization headers. Agent source is unchanged.

Run `just lint`, `test` or `image`. See
[native Radius agents](../../../docs/agents/native-radius.md) for bindings and
the distinction between policy declarations, source tests and live enforcement.
