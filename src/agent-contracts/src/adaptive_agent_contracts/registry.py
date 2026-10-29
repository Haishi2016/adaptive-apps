from __future__ import annotations

from dataclasses import dataclass
from typing import Protocol


@dataclass(frozen=True)
class AgentReference:
    name: str


@dataclass(frozen=True)
class AgentEndpoint:
    name: str
    responses_base_url: str
    identity_audience: str | None = None


class AgentResolver(Protocol):
    async def resolve(self, reference: AgentReference) -> AgentEndpoint: ...
