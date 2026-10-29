from __future__ import annotations

from functools import partial

import httpx
from adaptive_agent_contracts import AgentIdentity, HostCapabilities
from adaptive_agent_hosts import GatewayInvocationMiddleware, KeycloakTokenProvider
from agent_framework_foundry_hosting import ResponsesHostServer
from agent_framework_openai import OpenAIChatCompletionClient
from azure.ai.agentserver.core import configure_observability
from azure.ai.agentserver.responses import ResponsesServerOptions
from openai import AsyncOpenAI

from adaptive_runtime.agent import agent_requirements, create_agent
from adaptive_runtime.config import Settings
from adaptive_runtime.logging_setup import configure_logging

configure_logging()
settings = Settings()
gateway_token = KeycloakTokenProvider.from_env()
capabilities = HostCapabilities(
    foreground_responses=True,
    streaming=True,
    stored_responses=True,
    background_execution=True,
    delegated_identity=True,
    durable_state=True,
)
agent_requirements(settings).validate(capabilities)
agent_identity = AgentIdentity(
    agent_id=settings.deployment_name,
    subject=settings.agent_name,
    issuer="urn:adaptive:kubernetes",
    hosting_environment="kubernetes-foundry-compatible",
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

app = ResponsesHostServer(
    agent,
    options=ResponsesServerOptions(default_fetch_history_count=100),
    configure_observability=partial(
        configure_observability, instrumentation_options={"httpx": {"enabled": True}}
    ),
)
app.add_middleware(
    GatewayInvocationMiddleware,
    agent_identity=agent_identity,
    agent_credentials={"model-gateway": gateway_token},
)
