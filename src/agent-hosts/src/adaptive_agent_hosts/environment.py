from __future__ import annotations

import os
from collections.abc import Mapping
from urllib.parse import urlsplit

from adaptive_agent_contracts import AgentEndpoint, AgentReference


class EnvironmentAgentResolver:
    def __init__(self, endpoints: Mapping[str, str]) -> None:
        self._endpoints = {
            name: _validate_endpoint(name, endpoint) for name, endpoint in endpoints.items()
        }

    @classmethod
    def from_env(cls, names: Mapping[str, str]) -> EnvironmentAgentResolver:
        endpoints = {
            name: _required_env(f"{prefix}_RESPONSES_BASE_URL") for name, prefix in names.items()
        }
        return cls(endpoints)

    async def resolve(self, reference: AgentReference) -> AgentEndpoint:
        try:
            endpoint = self._endpoints[reference.name]
        except KeyError:
            raise LookupError(f"Agent {reference.name!r} is not configured") from None
        return AgentEndpoint(name=reference.name, responses_base_url=endpoint)


def _validate_endpoint(name: str, endpoint: str) -> str:
    url = urlsplit(endpoint)
    if (
        url.scheme not in ("http", "https")
        or not url.hostname
        or url.username is not None
        or url.password is not None
        or url.query
        or url.fragment
        or url.path.rstrip("/") != f"/agents/{name}"
    ):
        raise ValueError("Peer endpoint must identify the configured agent")
    return endpoint.rstrip("/") + "/"


def _required_env(name: str) -> str:
    value = os.environ.get(name)
    if value is None or not value.strip():
        raise RuntimeError(f"{name} is required")
    return value
