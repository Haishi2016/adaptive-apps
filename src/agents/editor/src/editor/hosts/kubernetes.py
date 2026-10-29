from __future__ import annotations

import os

from adaptive_agent_contracts import AgentIdentity, AgentReference, HostCapabilities
from adaptive_agent_hosts import (
    EnvironmentAgentResolver,
    GatewayInvocationMiddleware,
    KeycloakTokenProvider,
    KubernetesResponsesHost,
)

from editor.agent import EDITOR_REQUIREMENTS, Editor

agent_name = os.environ.get("AGENT_NAME", "editor")
agent_namespace = os.environ.get("AGENT_NAMESPACE", "adaptive")
writer = AgentReference(os.environ.get("WRITER_NAME", "writer"))
auditor = AgentReference(os.environ.get("AUDITOR_NAME", "auditor"))
resolver = EnvironmentAgentResolver.from_env(
    {
        writer.name: "WRITER",
        auditor.name: "AUDITOR",
    }
)
credentials = KeycloakTokenProvider.from_env()
capabilities = HostCapabilities(
    foreground_responses=True,
    peer_discovery=True,
)
EDITOR_REQUIREMENTS.validate(capabilities)
agent = Editor(
    name=agent_name,
    resolver=resolver,
    credentials=credentials,
    writer=writer,
    auditor=auditor,
)
app = KubernetesResponsesHost(agent, agent_name=agent_name)
app.add_middleware(
    GatewayInvocationMiddleware,
    agent_identity=AgentIdentity(
        agent_id=f"{agent_namespace}/{agent_name}",
        subject=agent_name,
        issuer="urn:adaptive:kubernetes",
        hosting_environment="kubernetes",
    ),
    agent_credentials={"peer-agent": credentials},
)
