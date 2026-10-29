from __future__ import annotations

from dataclasses import dataclass
from enum import StrEnum


class HostCapability(StrEnum):
    FOREGROUND_RESPONSES = "foreground_responses"
    STREAMING = "streaming"
    STORED_RESPONSES = "stored_responses"
    BACKGROUND_EXECUTION = "background_execution"
    DELEGATED_IDENTITY = "delegated_identity"
    DURABLE_STATE = "durable_state"
    PEER_DISCOVERY = "peer_discovery"


@dataclass(frozen=True)
class HostCapabilities:
    foreground_responses: bool = True
    streaming: bool = False
    stored_responses: bool = False
    background_execution: bool = False
    delegated_identity: bool = False
    durable_state: bool = False
    peer_discovery: bool = False

    def supports(self, capability: HostCapability) -> bool:
        return bool(getattr(self, capability.value))


@dataclass(frozen=True)
class AgentRequirements:
    required: frozenset[HostCapability] = frozenset()
    optional: frozenset[HostCapability] = frozenset()

    def __post_init__(self) -> None:
        overlap = self.required & self.optional
        if overlap:
            names = ", ".join(sorted(capability.value for capability in overlap))
            raise ValueError(f"Capabilities cannot be both required and optional: {names}")

    def validate(self, capabilities: HostCapabilities) -> None:
        missing = sorted(
            capability.value
            for capability in self.required
            if not capabilities.supports(capability)
        )
        if missing:
            raise RuntimeError(
                f"Hosting environment is missing required capabilities: {', '.join(missing)}"
            )
