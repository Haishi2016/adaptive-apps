"""Bounded native tools from the current prompt-agent bindings."""

from __future__ import annotations

import json
from typing import Annotated, Any, Literal, Self

import httpx
from adaptive_agent_contracts import current_invocation
from agent_framework import tool
from pydantic import BaseModel, ConfigDict, Field, TypeAdapter, model_validator


class BuiltinToolBinding(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True)

    type: Literal["builtin"]
    name: Literal["graph-me"]
    connection_ref: str = Field(
        alias="connectionRef", pattern=r"^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$"
    )
    server_label: Literal["Graph profile"] = Field(alias="serverLabel")
    require_approval: Literal["never"] = Field(alias="requireApproval")
    auth_type: Literal["entra"] = Field(alias="authType")
    audience: Literal["https://graph.microsoft.com"]
    identity_modes: list[Literal["app", "endUserOBO", "agentUser"]] = Field(
        alias="identityModes", min_length=1
    )
    execution_identity: Literal["caller"] = Field(alias="executionIdentity")

    @model_validator(mode="after")
    def validate_modes(self) -> Self:
        if self.identity_modes != ["app", "endUserOBO", "agentUser"]:
            raise ValueError("Graph profile requires the bounded catalogue identity modes")
        return self


def graph_profile_tool(cluster_mode: Literal["connected", "redButton"]) -> Any:
    @tool
    async def graph_me() -> dict[str, str]:
        """Verify the selected user's Graph profile; personal fields are redacted."""
        if cluster_mode != "connected":
            raise PermissionError("Microsoft Graph is unavailable in red-button mode")
        try:
            invocation = current_invocation()
        except RuntimeError:
            raise PermissionError("Graph /me requires an active agent invocation") from None
        mode = invocation.caller_identity.claims.get("identity_mode", "app")
        if mode not in {"endUserOBO", "agentUser"}:
            raise PermissionError("Graph /me requires a user identity, not app identity")
        credential = invocation.delegated_credentials.get("microsoft-graph")
        if (
            credential is None
            or credential.audience != "https://graph.microsoft.com"
        ):
            raise PermissionError("A verified request-local Graph user token is required")
        try:
            async with (
                httpx.AsyncClient(timeout=30, follow_redirects=False, trust_env=False) as client,
                client.stream(
                    "GET",
                    "https://graph.microsoft.com/v1.0/me",
                    params={"$select": "id,displayName,userPrincipalName"},
                    headers={"Authorization": f"Bearer {credential.access_token}"},
                ) as response,
            ):
                response.raise_for_status()
                content = bytearray()
                async for chunk in response.aiter_bytes():
                    if len(content) + len(chunk) > 65536:
                        raise PermissionError("Microsoft Graph profile exceeds 64 KB")
                    content.extend(chunk)
        except httpx.HTTPError:
            raise RuntimeError("Microsoft Graph profile request failed") from None
        try:
            profile = json.loads(content)
        except (ValueError, UnicodeDecodeError):
            raise PermissionError("Microsoft Graph returned an invalid profile") from None
        if (
            not isinstance(profile, dict)
            or profile.get("id") != credential.subject
            or any(
                not isinstance(profile.get(key), str) or len(profile[key]) > 4096
                for key in ("id", "displayName", "userPrincipalName")
            )
        ):
            raise PermissionError("Graph profile does not match the selected verified user")
        return dict.fromkeys(("id", "displayName", "userPrincipalName"), "[REDACTED]") | {
            "identityMode": mode
        }

    return graph_me


def build_agent_tools(
    agent_tools_json: str, cluster_mode: Literal["connected", "redButton"]
) -> list[Any]:
    bindings: list[BuiltinToolBinding] = TypeAdapter(
        Annotated[list[BuiltinToolBinding], Field(max_length=1)]
    ).validate_json(agent_tools_json)
    return [graph_profile_tool(cluster_mode) for _ in bindings]
