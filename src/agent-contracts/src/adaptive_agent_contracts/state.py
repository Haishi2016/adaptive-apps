from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from datetime import datetime
from typing import Protocol


@dataclass(frozen=True)
class ConversationEntry:
    entry_id: str
    role: str
    content: Sequence[Mapping[str, object]]
    created_at: datetime


@dataclass(frozen=True)
class ConversationHistory:
    conversation_id: str
    revision: str
    entries: Sequence[ConversationEntry]


class ConversationHistoryStore(Protocol):
    async def load(self, conversation_id: str) -> ConversationHistory | None: ...

    async def append(
        self,
        conversation_id: str,
        entries: Sequence[ConversationEntry],
        *,
        expected_revision: str | None,
    ) -> ConversationHistory: ...


@dataclass(frozen=True)
class AgentCheckpoint:
    agent_id: str
    checkpoint_id: str
    version: str
    state: Mapping[str, object] = field(default_factory=dict)
    created_at: datetime | None = None


class AgentCheckpointStore(Protocol):
    async def load(self, agent_id: str, checkpoint_id: str) -> AgentCheckpoint | None: ...

    async def save(
        self,
        checkpoint: AgentCheckpoint,
        *,
        expected_version: str | None,
    ) -> AgentCheckpoint: ...
