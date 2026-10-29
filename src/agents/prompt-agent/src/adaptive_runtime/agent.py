from __future__ import annotations

from typing import Any

from adaptive_agent_contracts import (
    AgentRequirements,
    HostCapability,
)
from agent_framework import Agent
from agent_framework_openai import OpenAIChatCompletionClient

from adaptive_runtime.config import Settings
from adaptive_runtime.skills import build_skills_provider
from adaptive_runtime.tools import build_agent_tools


def agent_requirements(settings: Settings) -> AgentRequirements:
    required = {HostCapability.FOREGROUND_RESPONSES}
    if settings.agent_tools != "[]":
        required.add(HostCapability.DELEGATED_IDENTITY)
    return AgentRequirements(required=frozenset(required))


def create_agent(
    settings: Settings, chat_client: OpenAIChatCompletionClient
) -> Agent[Any]:
    tools = build_agent_tools(settings.agent_tools, settings.cluster_mode)
    skills = build_skills_provider(settings.agent_skills)
    return chat_client.as_agent(
        name=settings.agent_name,
        instructions=settings.agent_instructions,
        tools=tools or None,
        context_providers=[skills] if skills is not None else None,
        default_options={
            "temperature": settings.temperature,
            "top_p": settings.top_p,
        },
    )
