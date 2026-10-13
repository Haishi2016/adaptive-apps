"""Removal-plan gates against the pinned, unmodified native storage providers."""

import asyncio
from pathlib import Path

import httpx
import pytest
from azure.ai.agentserver.core import (
    FoundryAgentRequestContext,
    reset_request_context,
    set_request_context,
)
from azure.ai.agentserver.core.storage import FoundryStateStore
from azure.ai.agentserver.responses import (
    CreateResponse,
    ResponseContext,
    ResponsesAgentServerHost,
    TextResponse,
)
from azure.ai.agentserver.responses.store._file import FileResponseStore


@pytest.fixture
def state_root(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    monkeypatch.setenv("AGENTSERVER_STATE_ROOT", str(tmp_path))
    monkeypatch.delenv("FOUNDRY_HOSTING_ENVIRONMENT", raising=False)
    return tmp_path


def native_host(root: Path) -> ResponsesAgentServerHost:
    host = ResponsesAgentServerHost(store=FileResponseStore(root / "responses"))

    @host.response_handler
    async def handle(
        request: CreateResponse, context: ResponseContext, cancellation_signal: asyncio.Event
    ) -> TextResponse:
        return TextResponse(context, request, text="Owner's private response.")

    return host


@pytest.mark.xfail(
    strict=True,
    raises=AssertionError,
    reason="Deferred gap G1: SDK 2.2.0 file responses discard persisted caller ownership",
)
@pytest.mark.parametrize("operation", ["retrieve", "input_items", "delete", "continue"])
async def test_reopened_native_host_denies_other_caller(state_root: Path, operation: str) -> None:
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=native_host(state_root)), base_url="http://native.test"
    ) as client:
        created = await client.post(
            "/responses",
            headers={"x-agent-user-id": "owner"},
            json={"input": "Private input", "store": True},
        )
        if created.status_code != 200:
            pytest.fail(f"Native create failed: {created.status_code} {created.text}")
        response_id = created.json()["id"]

    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=native_host(state_root)), base_url="http://native.test"
    ) as client:
        path = f"/responses/{response_id}"
        owner = await client.get(path, headers={"x-agent-user-id": "owner"})
        if owner.status_code != 200:
            pytest.fail(f"Native owner retrieval failed: {owner.status_code} {owner.text}")
        headers = {"x-agent-user-id": "another-caller"}
        if operation == "continue":
            result = await client.post(
                "/responses",
                headers=headers,
                json={"input": "Continue", "previous_response_id": response_id, "store": True},
            )
        elif operation == "delete":
            result = await client.delete(path, headers=headers)
        else:
            suffix = "/input_items" if operation == "input_items" else ""
            result = await client.get(path + suffix, headers=headers)

    if result.status_code not in (200, 404):
        pytest.fail(f"Unexpected native {operation} result: {result.status_code} {result.text}")
    assert result.status_code == 404, (
        f"Native {operation} accepted a different caller after reopening the persistent store: "
        f"HTTP {result.status_code}"
    )


@pytest.mark.xfail(
    strict=True,
    raises=AssertionError,
    reason="Deferred gap G1: native local state does not enforce user_isolation=True",
)
@pytest.mark.parametrize("store_name", ["agent_sessions", "function_approvals"])
async def test_native_session_and_approval_state_isolates_callers(
    state_root: Path, store_name: str
) -> None:
    token = set_request_context(FoundryAgentRequestContext(user_id="owner"))
    try:
        async with await FoundryStateStore.get_or_create(store_name, user_isolation=True) as store:
            await store.set_item("private-item", {"content": "Owner's private state"})
    finally:
        reset_request_context(token)

    token = set_request_context(FoundryAgentRequestContext(user_id="another-caller"))
    try:
        async with await FoundryStateStore.get_or_create(
            store_name, user_isolation=True
        ) as reopened:
            item = await reopened.get_item("private-item")
    finally:
        reset_request_context(token)

    assert item is None, "Native local state returned another caller's item"


@pytest.mark.parametrize("store_name", ["agent_sessions", "function_approvals"])
async def test_native_precreated_store_retains_no_expiry(
    state_root: Path, monkeypatch: pytest.MonkeyPatch, store_name: str
) -> None:
    monkeypatch.setattr("azure.ai.agentserver.core.storage._local_state._now", lambda: 100)
    async with await FoundryStateStore.get_or_create(
        store_name, user_isolation=True, item_ttl_seconds=-1
    ) as store:
        await store.set_item("retained-item", {"content": "Retained state"})

    monkeypatch.setattr(
        "azure.ai.agentserver.core.storage._local_state._now", lambda: 100 + 31 * 24 * 60 * 60
    )
    async with await FoundryStateStore.get_or_create(store_name, user_isolation=True) as reopened:
        item = await reopened.get_item("retained-item")
        assert item is not None
        assert item.value == {"content": "Retained state"}
        metadata = await reopened.get()
        assert metadata.item_ttl_seconds == -1
