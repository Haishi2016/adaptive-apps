from __future__ import annotations

import ast
from pathlib import Path


def test_portable_agent_has_no_host_or_identity_imports() -> None:
    source = Path("src/adaptive_runtime/agent.py").read_text(encoding="utf-8")
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


def test_portable_tools_do_not_parse_host_headers() -> None:
    source = Path("src/adaptive_runtime/tools.py").read_text(encoding="utf-8")
    assert "x-client-" not in source
    assert "x-entra-user-token" not in source
