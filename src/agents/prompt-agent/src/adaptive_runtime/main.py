"""Prompt agents on the native Foundry Responses host and Model Gateway."""

from __future__ import annotations

import os
from functools import partial

import httpx
from agent_framework_foundry_hosting import ResponsesHostServer
from agent_framework_openai import OpenAIChatCompletionClient
from azure.ai.agentserver.core import configure_observability
from azure.ai.agentserver.responses import ResponsesServerOptions
from openai import AsyncOpenAI

from adaptive_runtime.config import Settings
from adaptive_runtime.logging_setup import configure_logging
from adaptive_runtime.oauth import KeycloakTokenProvider
from adaptive_runtime.skills import build_skills_provider
from adaptive_runtime.tools import ToolHeadersMiddleware, build_agent_tools

configure_logging()
settings = Settings()

_gateway_token = KeycloakTokenProvider.from_env()


_async_openai = AsyncOpenAI(
    api_key=_gateway_token,
    base_url=settings.openai_v1_base_url,
    timeout=httpx.Timeout(60.0, connect=10.0),
)
_chat_client = OpenAIChatCompletionClient(
    model=settings.openai_model,
    async_client=_async_openai,
)
_tools = build_agent_tools(
    settings.agent_tools,
    settings.cluster_mode,
)
_skills = build_skills_provider(settings.agent_skills)

agent = _chat_client.as_agent(
    name=settings.agent_name,
    instructions=settings.agent_instructions,
    tools=_tools or None,
    context_providers=[_skills] if _skills is not None else None,
    default_options={
        "temperature": settings.temperature,
        "top_p": settings.top_p,
    },
)

# Keep the SDK-owned protocol, storage and Agent-365 telemetry pipeline.
app = ResponsesHostServer(
    agent,
    options=ResponsesServerOptions(default_fetch_history_count=100),
    configure_observability=partial(
        configure_observability, instrumentation_options={"httpx": {"enabled": True}}
    ),
)
app.add_middleware(ToolHeadersMiddleware)


def main() -> None:
    app.run(port=int(os.environ.get("PORT", "8080")))


if __name__ == "__main__":
    main()
