from __future__ import annotations

from typing import Literal

import httpx
import pytest
from adaptive_agent_hosts import KubernetesResponsesHost
from agent_framework import AgentResponse, AgentRunInputs, Message, normalize_messages


class FakeAgent:
    def __init__(self) -> None:
        self.calls: list[list[Message]] = []

    async def run(
        self,
        messages: AgentRunInputs | None = None,
        *,
        stream: Literal[False] = False,
    ) -> AgentResponse:
        assert stream is False
        normalized = normalize_messages(messages)
        self.calls.append(normalized)
        return AgentResponse(
            response_id="resp_test",
            messages=[Message("assistant", ["Portable response"], message_id="msg_test")],
        )


@pytest.fixture
def host() -> tuple[KubernetesResponsesHost, FakeAgent]:
    agent = FakeAgent()
    return KubernetesResponsesHost(agent, agent_name="writer"), agent


async def test_kubernetes_host_serves_foreground_responses(
    host: tuple[KubernetesResponsesHost, FakeAgent],
) -> None:
    app, agent = host
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://test"
    ) as client:
        response = await client.post(
            "/agents/writer/responses",
            json={
                "input": [{"role": "user", "content": "Hello"}],
                "store": False,
            },
        )

    assert response.status_code == 200
    assert response.headers["x-platform-server"] == "adaptive-kubernetes-responses/0.1.0"
    assert response.json() == {
        "id": "resp_test",
        "object": "response",
        "created_at": response.json()["created_at"],
        "status": "completed",
        "output": [
            {
                "id": "msg_test",
                "type": "message",
                "role": "assistant",
                "status": "completed",
                "content": [
                    {
                        "type": "output_text",
                        "text": "Portable response",
                        "annotations": [],
                    }
                ],
            }
        ],
    }
    assert agent.calls[0][0].text == "Hello"


@pytest.mark.parametrize(
    ("payload", "status", "message"),
    [
        ({"input": "Hello", "store": True}, 501, "Stored responses"),
        ({"input": "Hello", "background": True}, 501, "Background execution"),
        ({"input": "Hello", "stream": True}, 501, "Streaming"),
        ({"input": "Hello", "previous_response_id": "resp_1"}, 400, "Unsupported"),
        ({"store": False}, 400, "input is required"),
    ],
)
async def test_kubernetes_host_fails_unsupported_semantics(
    host: tuple[KubernetesResponsesHost, FakeAgent],
    payload: dict[str, object],
    status: int,
    message: str,
) -> None:
    app, agent = host
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://test"
    ) as client:
        response = await client.post("/responses", json=payload)

    assert response.status_code == status
    assert message in response.json()["error"]["message"]
    assert agent.calls == []


async def test_kubernetes_host_rejects_wrong_agent_route(
    host: tuple[KubernetesResponsesHost, FakeAgent],
) -> None:
    app, agent = host
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://test"
    ) as client:
        response = await client.post(
            "/agents/auditor/responses",
            json={"input": "Hello", "store": False},
        )

    assert response.status_code == 404
    assert agent.calls == []
