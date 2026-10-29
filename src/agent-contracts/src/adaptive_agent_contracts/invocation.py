from __future__ import annotations

from collections.abc import Iterator, Mapping
from contextlib import contextmanager
from contextvars import ContextVar
from dataclasses import dataclass, field

from adaptive_agent_contracts.identity import (
    AgentIdentity,
    CallerIdentity,
    TokenProvider,
    WorkloadIdentity,
)


@dataclass(frozen=True)
class DelegatedCredential:
    audience: str
    subject: str
    access_token: str = field(repr=False)


@dataclass(frozen=True)
class TraceContext:
    traceparent: str | None = None
    tracestate: str | None = None
    baggage: str | None = None


@dataclass(frozen=True)
class AgentInvocationContext:
    agent_identity: AgentIdentity
    caller_identity: CallerIdentity
    workload_identity: WorkloadIdentity | None = None
    agent_credentials: Mapping[str, TokenProvider] = field(default_factory=dict)
    delegated_credentials: Mapping[str, DelegatedCredential] = field(default_factory=dict)
    trace_context: TraceContext = field(default_factory=TraceContext)


_current_invocation: ContextVar[AgentInvocationContext | None] = ContextVar(
    "agent_invocation", default=None
)


def current_invocation() -> AgentInvocationContext:
    context = _current_invocation.get()
    if context is None:
        raise RuntimeError("No agent invocation context is active")
    return context


@contextmanager
def bind_invocation(context: AgentInvocationContext) -> Iterator[None]:
    token = _current_invocation.set(context)
    try:
        yield
    finally:
        _current_invocation.reset(token)
