from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass, field
from typing import Protocol


@dataclass(frozen=True)
class AgentIdentity:
    agent_id: str
    subject: str
    issuer: str
    hosting_environment: str
    attributes: Mapping[str, str] = field(default_factory=dict)


@dataclass(frozen=True)
class WorkloadIdentity:
    workload_id: str
    principal_id: str
    hosting_environment: str


@dataclass(frozen=True)
class CallerIdentity:
    subject: str
    issuer: str
    claims: Mapping[str, object] = field(default_factory=dict)


class TokenProvider(Protocol):
    async def __call__(self) -> str: ...
