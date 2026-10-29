from __future__ import annotations

import ast
from pathlib import Path

import pytest
from adaptive_agent_contracts import AgentReference
from adaptive_agent_hosts import EnvironmentAgentResolver


def test_portable_editor_has_no_host_or_identity_imports() -> None:
    source = Path("src/editor/agent.py").read_text(encoding="utf-8")
    imports = {
        alias.name
        for node in ast.walk(ast.parse(source))
        if isinstance(node, ast.Import)
        for alias in node.names
    } | {
        node.module or ""
        for node in ast.walk(ast.parse(source))
        if isinstance(node, ast.ImportFrom)
    }
    assert not any(
        name.startswith(
            (
                "adaptive_agent_hosts",
                "agent_framework_foundry_hosting",
                "azure.ai.agentserver",
            )
        )
        for name in imports
    )


async def test_environment_resolver_returns_validated_agent_endpoint() -> None:
    resolver = EnvironmentAgentResolver(
        {"writer": "https://agents.example/agents/writer/"}
    )
    endpoint = await resolver.resolve(AgentReference("writer"))
    assert endpoint.name == "writer"
    assert endpoint.responses_base_url == "https://agents.example/agents/writer/"


@pytest.mark.parametrize(
    "endpoint",
    [
        "https://agents.example/agents/other/",
        "https://agents.example/agents/writer/versions/v1/",
        "https://user:secret@agents.example/agents/writer/",
        "https://agents.example/agents/writer/?redirect=elsewhere",
        "https://agents.example/agents/writer/#fragment",
        "file:///agents/writer/",
    ],
)
def test_environment_resolver_rejects_invalid_agent_endpoint(endpoint: str) -> None:
    with pytest.raises(ValueError, match="configured agent"):
        EnvironmentAgentResolver({"writer": endpoint})
