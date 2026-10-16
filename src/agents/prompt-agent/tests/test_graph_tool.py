"""Bounded Graph profile execution consumes only request-local verified identity."""

import asyncio
import json
import traceback
from typing import Any

import httpx
import pytest
from pydantic import ValidationError

from adaptive_runtime.tools import ToolHeadersMiddleware, _headers, build_agent_tools


def descriptor(**overrides: Any) -> dict[str, Any]:
    return {
        "type": "builtin",
        "name": "graph-me",
        "connectionRef": "profile",
        "serverLabel": "Graph profile",
        "requireApproval": "never",
        "authType": "entra",
        "audience": "https://graph.microsoft.com",
        "identityModes": ["app", "endUserOBO", "agentUser"],
        "executionIdentity": "caller",
        **overrides,
    }


def graph_tool(mode: str = "connected") -> Any:
    return build_agent_tools(json.dumps([descriptor()]), mode)[0]


async def invoke(tool: Any, mode: str, token: str | None, user: str | None) -> Any:
    result: Any = None

    async def app(scope: Any, *args: Any) -> None:
        nonlocal result
        assert scope["headers"] == [(b"content-type", b"application/json")]
        await asyncio.sleep(0)
        result = await tool.func()

    async def unused(*args: Any) -> Any:
        raise AssertionError("Unexpected ASGI receive/send")

    headers = [
        (b"content-type", b"application/json"),
        (b"x-client-identity-mode", mode.encode()),
        (b"authorization", b"browser-secret"),
        (b"x-entra-user-token", b"entra-secret"),
    ]
    if token:
        headers.append((b"x-client-microsoft-graph-access-token", token.encode()))
    if user:
        headers.append((b"x-client-graph-user-id", user.encode()))
    await ToolHeadersMiddleware(app)({"type": "http", "headers": headers}, unused, unused)
    return result


async def test_verified_graph_users_are_request_local(monkeypatch: pytest.MonkeyPatch) -> None:
    requests: list[httpx.Request] = []

    def transport(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        user = request.headers["authorization"].removeprefix("Bearer ")
        return httpx.Response(
            200, json={"id": user, "displayName": user, "userPrincipalName": f"{user}@test"}
        )

    client = httpx.AsyncClient

    def build_client(**kwargs: Any) -> httpx.AsyncClient:
        assert kwargs == {"timeout": 30, "follow_redirects": False, "trust_env": False}
        return client(transport=httpx.MockTransport(transport), **kwargs)

    monkeypatch.setattr(httpx, "AsyncClient", build_client)
    tool = graph_tool()
    alice, bob = await asyncio.gather(
        invoke(tool, "endUserOBO", "alice", "alice"),
        invoke(tool, "agentUser", "bob", "bob"),
    )
    assert alice == {
        "id": "[REDACTED]",
        "displayName": "[REDACTED]",
        "userPrincipalName": "[REDACTED]",
        "identityMode": "endUserOBO",
    }
    assert bob == {
        "id": "[REDACTED]",
        "displayName": "[REDACTED]",
        "userPrincipalName": "[REDACTED]",
        "identityMode": "agentUser",
    }
    assert {request.headers["authorization"] for request in requests} == {
        "Bearer alice",
        "Bearer bob",
    }
    assert _headers.get() is None
    assert all(str(r.url).startswith("https://graph.microsoft.com/v1.0/me?") for r in requests)
    assert all(r.url.params["$select"] == "id,displayName,userPrincipalName" for r in requests)
    with pytest.raises(PermissionError, match="app identity"):
        await tool.func()


@pytest.mark.parametrize("mode", ["endUserOBO", "agentUser"])
async def test_graph_personal_fields_are_redacted_before_return(
    monkeypatch: pytest.MonkeyPatch, mode: str
) -> None:
    profile = {
        "id": "11111111-2222-3333-4444-555555555555",
        "displayName": "Recorded User",
        "userPrincipalName": "recorded.user@example.invalid",
    }
    client = httpx.AsyncClient
    monkeypatch.setattr(
        httpx,
        "AsyncClient",
        lambda **kwargs: client(
            transport=httpx.MockTransport(lambda request: httpx.Response(200, json=profile)),
            **kwargs,
        ),
    )
    result = await invoke(graph_tool(), mode, "private-token", profile["id"])
    assert result["identityMode"] == mode
    assert all(result[key] == "[REDACTED]" for key in profile)
    serialized = json.dumps(result)
    assert all(value not in serialized for value in profile.values())
    assert "private-token" not in serialized
    assert _headers.get() is None


@pytest.mark.parametrize(
    ("cluster_mode", "identity_mode", "token", "user", "message"),
    [
        ("redButton", "endUserOBO", "token", "alice", "red-button"),
        ("connected", "app", "token", "alice", "app identity"),
        ("connected", "unsupported", "token", "alice", "app identity"),
        ("connected", "endUserOBO", None, "alice", "request-local"),
        ("connected", "agentUser", "token", None, "request-local"),
    ],
)
async def test_graph_denies_without_app_fallback(
    monkeypatch: pytest.MonkeyPatch,
    cluster_mode: str,
    identity_mode: str,
    token: str | None,
    user: str | None,
    message: str,
) -> None:
    def forbidden(**kwargs: Any) -> Any:
        raise AssertionError("Denied invocation must not construct HTTP or delegation clients")

    monkeypatch.setattr(httpx, "AsyncClient", forbidden)
    monkeypatch.setattr("azure.identity.DefaultAzureCredential", forbidden)
    with pytest.raises(PermissionError, match=message):
        await invoke(graph_tool(cluster_mode), identity_mode, token, user)
    assert _headers.get() is None


@pytest.mark.parametrize(
    "response",
    [
        {"id": "other", "displayName": "Other", "userPrincipalName": "other@test"},
        {"id": "alice", "displayName": None, "userPrincipalName": "alice@test"},
        ["not", "a", "profile"],
    ],
)
async def test_graph_result_must_match_verified_user(
    monkeypatch: pytest.MonkeyPatch, response: Any
) -> None:
    client = httpx.AsyncClient
    monkeypatch.setattr(
        httpx,
        "AsyncClient",
        lambda **kwargs: client(
            transport=httpx.MockTransport(lambda request: httpx.Response(200, json=response)),
            **kwargs,
        ),
    )
    with pytest.raises(PermissionError, match="verified user"):
        await invoke(graph_tool(), "endUserOBO", "token", "alice")
    assert _headers.get() is None


@pytest.mark.parametrize(
    "overrides",
    [
        {"name": "graph-files"},
        {"serverUrl": "https://evil.test"},
        {"audience": "https://evil.test"},
        {"executionIdentity": "server"},
        {"requireApproval": "always"},
        {"serverLabel": "Other"},
        {"identityModes": ["app"]},
    ],
)
def test_builtin_binding_is_exactly_bounded(overrides: dict[str, Any]) -> None:
    with pytest.raises(ValidationError):
        build_agent_tools(json.dumps([descriptor(**overrides)]), "connected")


@pytest.mark.parametrize("raw", ["not-json", "{}", "[null]", '[{"type":"mcp"}]'])
def test_unsupported_tools_fail_startup(raw: str) -> None:
    with pytest.raises(ValidationError):
        build_agent_tools(raw, "connected")


def test_only_one_bounded_tool_can_be_configured() -> None:
    assert build_agent_tools("[]", "connected") == []
    with pytest.raises(ValidationError):
        build_agent_tools(
            json.dumps([descriptor(), descriptor(connectionRef="another-profile")]), "connected"
        )


@pytest.mark.parametrize("status", [302, 401, 500])
async def test_graph_http_errors_are_sanitized(
    monkeypatch: pytest.MonkeyPatch, status: int
) -> None:
    client = httpx.AsyncClient
    monkeypatch.setattr(
        httpx,
        "AsyncClient",
        lambda **kwargs: client(
            transport=httpx.MockTransport(
                lambda request: httpx.Response(
                    status,
                    headers={"location": "https://untrusted.test/secret"},
                    text="downstream-secret",
                )
            ),
            **kwargs,
        ),
    )
    private_token = "private-token"
    with pytest.raises(RuntimeError, match="profile request failed") as error:
        await invoke(graph_tool(), "endUserOBO", private_token, "alice")
    details = "".join(traceback.format_exception(error.value))
    assert "private-token" not in details
    assert "downstream-secret" not in details
    assert "untrusted.test" not in details
    assert _headers.get() is None


@pytest.mark.parametrize(
    ("content", "message"),
    [
        (b"x" * 65537, "exceeds 64 KB"),
        (b"not JSON", "invalid profile"),
        (
            json.dumps(
                {"id": "alice", "displayName": "x" * 4097, "userPrincipalName": "alice@test"}
            ).encode(),
            "verified user",
        ),
    ],
)
async def test_graph_profile_body_and_fields_are_bounded(
    monkeypatch: pytest.MonkeyPatch, content: bytes, message: str
) -> None:
    client = httpx.AsyncClient
    monkeypatch.setattr(
        httpx,
        "AsyncClient",
        lambda **kwargs: client(
            transport=httpx.MockTransport(lambda request: httpx.Response(200, content=content)),
            **kwargs,
        ),
    )
    with pytest.raises(PermissionError, match=message):
        await invoke(graph_tool(), "agentUser", "private-token", "alice")
    assert _headers.get() is None


async def test_middleware_restores_ambient_context_after_sdk_failure() -> None:
    outer = {"x-client-identity-mode": "app"}
    token = _headers.set(outer)

    async def failed_sdk(scope: Any, *args: Any) -> None:
        assert scope["headers"] == []
        assert _headers.get() == {
            "x-client-identity-mode": "agentUser",
            "x-client-microsoft-graph-access-token": "request-secret",
            "x-client-graph-user-id": "worker",
        }
        raise RuntimeError("SDK failed")

    async def unused(*args: Any) -> Any:
        raise AssertionError("Unexpected ASGI receive/send")

    scope = {
        "type": "http",
        "headers": [
            (b"X-Client-Identity-Mode", b"agentUser"),
            (b"X-Client-Microsoft-Graph-Access-Token", b"request-secret"),
            (b"X-Client-Graph-User-Id", b"worker"),
            (b"Authorization", b"browser-secret"),
            (b"X-Entra-User-Token", b"upstream-secret"),
        ],
    }
    try:
        with pytest.raises(RuntimeError, match="SDK failed"):
            await ToolHeadersMiddleware(failed_sdk)(scope, unused, unused)
        assert _headers.get() is outer
        assert len(scope["headers"]) == 5
    finally:
        _headers.reset(token)
    assert _headers.get() is None
