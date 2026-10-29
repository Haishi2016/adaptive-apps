from __future__ import annotations

from dataclasses import dataclass

from opentelemetry.metrics import Meter
from opentelemetry.trace import Tracer


@dataclass(frozen=True)
class AgentTelemetry:
    tracer: Tracer
    meter: Meter


AGENT_NAME_ATTRIBUTE = "gen_ai.agent.name"
OPERATION_NAME_ATTRIBUTE = "gen_ai.operation.name"
PEER_AGENT_NAME_ATTRIBUTE = "adaptive.peer_agent.name"
