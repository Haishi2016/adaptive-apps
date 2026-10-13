# Native agent capability

Radius owns this chart through `Radius.Resources/agentPlatforms`; do not run an
independent Helm install over that release. It contains native ingress, local
identity, model gateway, optional diagnostics and native admission policies,
not an agent lifecycle operator or lifecycle CRDs.

See [native Radius agents](../../docs/agents/native-radius.md) for provisioning
inputs, retained ownership, outage behavior and unqualified live gates.
