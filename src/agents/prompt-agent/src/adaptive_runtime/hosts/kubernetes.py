from __future__ import annotations

import httpx
from adaptive_agent_contracts import AgentIdentity, HostCapabilities
from adaptive_agent_hosts import (
    GatewayInvocationMiddleware,
    KeycloakTokenProvider,
    KubernetesResponsesHost,
)
from agent_framework_openai import OpenAIChatCompletionClient
from openai import AsyncOpenAI

from adaptive_runtime.agent import agent_requirements, create_agent
from adaptive_runtime.config import Settings
from adaptive_runtime.logging_setup import configure_logging

configure_logging()
settings = Settings()
gateway_token = KeycloakTokenProvider.from_env()
capabilities = HostCapabilities(
    foreground_responses=True,
    delegated_identity=True,
)
agent_requirements(settings).validate(capabilities)
agent_identity = AgentIdentity(
    agent_id=settings.deployment_name,
    subject=settings.agent_name,
    issuer="urn:adaptive:kubernetes",
    hosting_environment="kubernetes",
)
openai_client = AsyncOpenAI(
    api_key=gateway_token,
    base_url=settings.openai_v1_base_url,
    timeout=httpx.Timeout(60.0, connect=10.0),
)
chat_client = OpenAIChatCompletionClient(
    model=settings.openai_model,
    async_client=openai_client,
)
agent = create_agent(settings, chat_client)
app = KubernetesResponsesHost(agent, agent_name=settings.agent_name)
app.add_middleware(
    GatewayInvocationMiddleware,
    agent_identity=agent_identity,
    agent_credentials={"model-gateway": gateway_token},
)
