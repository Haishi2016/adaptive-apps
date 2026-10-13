"""Exercise protocol-2 context forwarding through the native HTTP host."""

import asyncio
from types import SimpleNamespace
from unittest.mock import AsyncMock

import httpx
import pytest
from azure.ai.agentserver.responses import (
    CreateResponse,
    FoundryStorageProvider,
    FoundryStorageSettings,
    ResponseContext,
    ResponsesAgentServerHost,
    TextResponse,
)


async def test_inbound_call_id_reaches_foundry_history(monkeypatch: pytest.MonkeyPatch) -> None:
    provider = FoundryStorageProvider(
        AsyncMock(), FoundryStorageSettings.from_endpoint("https://foundry.test")
    )
    send = AsyncMock(return_value=SimpleNamespace(text=lambda: "[]"))
    monkeypatch.setattr(provider, "_send_storage_request", send)
    server = ResponsesAgentServerHost(store=provider)

    @server.response_handler
    async def handle(
        request: CreateResponse, context: ResponseContext, cancellation_signal: asyncio.Event
    ) -> TextResponse:
        assert await context.get_history() == ()
        return TextResponse(context, request, text="Protocol two.")

    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=server), base_url="http://test"
    ) as client:
        response = await client.post(
            "/responses",
            json={"input": "Hello", "conversation": "conv_test", "store": False},
            headers={"x-agent-foundry-call-id": "call_test", "x-agent-user-id": "user_test"},
        )

    assert response.status_code == 200, response.text
    assert response.json()["status"] == "completed"
    assert "azure-ai-agentserver-responses/2.2.0" in response.headers["x-platform-server"]
    send.assert_awaited_once()
    request = send.await_args.args[0]
    assert "/storage/history/item_ids?" in request.url
    assert request.headers["x-agent-foundry-call-id"] == "call_test"
    assert "x-agent-user-id" not in request.headers
    await provider.aclose()
