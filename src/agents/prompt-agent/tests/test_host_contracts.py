from __future__ import annotations

from datetime import UTC, datetime

import pytest
from adaptive_agent_contracts import (
    AgentCheckpoint,
    AgentRequirements,
    ConversationEntry,
    ConversationHistory,
    HostCapabilities,
    HostCapability,
)


def test_required_host_capabilities_fail_explicitly() -> None:
    requirements = AgentRequirements(
        required=frozenset(
            {
                HostCapability.FOREGROUND_RESPONSES,
                HostCapability.DELEGATED_IDENTITY,
            }
        )
    )

    with pytest.raises(
        RuntimeError,
        match="missing required capabilities: delegated_identity",
    ):
        requirements.validate(HostCapabilities(foreground_responses=True))


def test_capability_cannot_be_required_and_optional() -> None:
    with pytest.raises(ValueError, match="both required and optional"):
        AgentRequirements(
            required=frozenset({HostCapability.STREAMING}),
            optional=frozenset({HostCapability.STREAMING}),
        )


def test_conversation_history_and_checkpoint_have_distinct_semantics() -> None:
    entry = ConversationEntry(
        entry_id="turn-1",
        role="user",
        content=[{"type": "input_text", "text": "Hello"}],
        created_at=datetime.now(UTC),
    )
    history = ConversationHistory(
        conversation_id="conversation-1",
        revision="2",
        entries=[entry],
    )
    checkpoint = AgentCheckpoint(
        agent_id="adaptive/writer",
        checkpoint_id="checkpoint-1",
        version="7",
        state={"cursor": 42},
    )

    assert history.entries == [entry]
    assert checkpoint.state == {"cursor": 42}
