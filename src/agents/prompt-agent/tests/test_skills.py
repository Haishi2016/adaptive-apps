import json
from unittest.mock import MagicMock

import pytest
from agent_framework import AgentSession, SessionContext

from adaptive_runtime.skills import build_skills_provider


def captured_skill() -> dict[str, str]:
    return {
        "path": "travel-checklist/SKILL.md",
        "name": "travel-checklist",
        "description": "Create a pre-departure checklist.",
        "content": "---\nname: travel-checklist\ndescription: Create a pre-departure checklist.\n---\nAsk for accessibility needs.",
    }


async def test_native_provider_discovers_metadata_and_loads_instructions_only_on_demand() -> None:
    provider = build_skills_provider(json.dumps([captured_skill()]))
    assert provider is not None
    context = SessionContext(input_messages=[])
    await provider.before_run(agent=MagicMock(), session=AgentSession(), context=context, state={})
    discovery = "\n".join(context.instructions)
    assert "travel-checklist" in discovery
    assert "Create a pre-departure checklist." in discovery
    assert "Ask for accessibility needs." not in discovery
    tools = {tool.name: tool for tool in context.tools}
    assert tools["load_skill"].approval_mode == "never_require"
    content = await tools["load_skill"].invoke(arguments={"skill_name": "travel-checklist"})
    assert "Ask for accessibility needs." in content[0].text
    missing = await tools["load_skill"].invoke(arguments={"skill_name": "../unconfigured"})
    assert "not found" in missing[0].text.lower()
    # Native SDK exposes the tool, but an InlineSkill without scripts cannot run code.
    result = await tools["run_skill_script"].invoke(
        arguments={"skill_name": "travel-checklist", "script_name": "run.py"}
    )
    assert "not found" in result[0].text.lower()
    assert tools["run_skill_script"].approval_mode == "always_require"


@pytest.mark.parametrize(
    "files",
    [
        {},
        [captured_skill(), captured_skill()],
        [captured_skill() | {"path": "../SKILL.md"}],
        [captured_skill() | {"name": "Bad--name"}],
        [captured_skill() | {"description": ""}],
        [captured_skill() | {"content": "x" * 8193}],
        [captured_skill() | {"scripts": ["run.py"]}],
    ],
)
def test_invalid_runtime_snapshots_fail_closed(files: object) -> None:
    with pytest.raises(ValueError, match=r"AGENT_SKILLS|[Ii]nvalid|description"):
        build_skills_provider(json.dumps(files))


def test_no_skills_needs_no_provider() -> None:
    assert build_skills_provider("[]") is None
