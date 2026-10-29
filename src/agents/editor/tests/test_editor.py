import json
from dataclasses import dataclass
from typing import Any

import httpx2 as httpx
import pytest
from adaptive_agent_contracts import AgentReference
from adaptive_agent_hosts import EnvironmentAgentResolver
from agent_framework import Message
from openai import APIStatusError
from opentelemetry.trace import NonRecordingSpan, SpanContext, TraceFlags, use_span

from editor import agent

EXPECTED_TEXT = "## writer\n\nwriter result\n\n## auditor\n\nauditor result"


@dataclass
class Pipeline:
    editor: agent.Editor
    requests: list[Any]
    faults: dict[str, Any]
    tokens: list[str]


@pytest.fixture
def pipeline(monkeypatch: pytest.MonkeyPatch) -> Pipeline:
    requests: list[Any] = []
    faults: dict[str, Any] = {}
    tokens: list[str] = []

    async def get_token() -> str:
        tokens.append("requested")
        return "application-token"

    def transport(request: Any) -> httpx.Response:
        name = request.url.path.split("/")[2]
        requests.append(request)
        assert request.method == "POST"
        assert request.url.path == f"/agents/{name}/responses"
        assert request.headers["authorization"].startswith("Bearer ")
        assert json.loads(request.content)["store"] is False
        if name in faults and isinstance(faults[name], int):
            return httpx.Response(faults[name], json={"detail": "Invocation failed"})
        payload = {
            "id": "resp-" + name,
            "object": "response",
            "created_at": 1,
            "status": "completed",
            "output": [
                {
                    "id": "msg-" + name,
                    "type": "message",
                    "role": "assistant",
                    "status": "completed",
                    "content": [
                        {
                            "type": "output_text",
                            "text": name + " result",
                            "annotations": [],
                        }
                    ],
                }
            ],
        }
        payload.update(faults.get(name, {}))
        return httpx.Response(200, json=payload)

    client = agent.DefaultAsyncHttpxClient
    monkeypatch.setattr(
        agent,
        "DefaultAsyncHttpxClient",
        lambda **kwargs: client(transport=httpx.MockTransport(transport), **kwargs),
    )
    resolver = EnvironmentAgentResolver(
        {
            "writer": "https://example.test/agents/writer/",
            "auditor": "https://example.test/agents/auditor/",
        }
    )
    return Pipeline(
        editor=agent.Editor(name="editor", resolver=resolver, credentials=get_token),
        requests=requests,
        faults=faults,
        tokens=tokens,
    )


async def test_sequence_and_request_local_context(pipeline: Pipeline) -> None:
    for _ in range(2):
        result = await pipeline.editor.edit([Message("user", ["Brief"])])
        assert result.text == EXPECTED_TEXT
    writer_input = [{"role": "user", "content": "Brief"}]
    auditor_input = [
        *writer_input,
        {"role": "assistant", "content": "writer result"},
        {
            "role": "user",
            "content": "Audit the preceding draft against the original brief. Return both "
            "Audit and Final sections with your verdict and corrected draft.",
        },
    ]
    assert [json.loads(request.content)["input"] for request in pipeline.requests] == [
        writer_input,
        auditor_input,
        writer_input,
        auditor_input,
    ]
    assert pipeline.tokens == ["requested"] * 4
    assert all(
        set(json.loads(request.content)) == {"input", "store"}
        for request in pipeline.requests
    )


@pytest.mark.parametrize("name", ["writer", "auditor"])
@pytest.mark.parametrize("status", [403, 404, 503])
async def test_peer_failure_aborts_without_retry_or_partial_success(
    pipeline: Pipeline, name: str, status: int
) -> None:
    pipeline.faults[name] = status
    with pytest.raises(APIStatusError):
        await pipeline.editor.edit([Message("user", ["Brief"])])
    assert len(pipeline.requests) == (1 if name == "writer" else 2)


@pytest.mark.parametrize("name", ["writer", "auditor"])
async def test_empty_specialist_output_is_rejected(pipeline: Pipeline, name: str) -> None:
    pipeline.faults[name] = {"output": []}
    with pytest.raises(ValueError, match=f"{name} returned no editing result"):
        await pipeline.editor.edit([Message("user", ["Brief"])])


@pytest.mark.parametrize("status", ["failed", "incomplete", "in_progress"])
async def test_incomplete_response_is_not_success(pipeline: Pipeline, status: str) -> None:
    pipeline.faults["writer"] = {"status": status}
    with pytest.raises(ValueError, match="did not complete"):
        await pipeline.editor.edit([Message("user", ["Brief"])])
    assert len(pipeline.requests) == 1


async def test_caller_executed_function_is_not_silently_ignored(
    pipeline: Pipeline,
) -> None:
    pipeline.faults["writer"] = {
        "output": [
            {
                "type": "function_call",
                "id": "fc-test",
                "call_id": "call-test",
                "name": "external_tool",
                "arguments": "{}",
            }
        ]
    }
    with pytest.raises(ValueError, match="did not complete"):
        await pipeline.editor.edit([Message("user", ["Brief"])])
    assert len(pipeline.requests) == 1


@pytest.mark.parametrize(
    "message", [Message("system", ["Unsupported"]), Message("user", [" \n "])]
)
async def test_unsupported_input_is_not_coerced(
    pipeline: Pipeline, message: Message
) -> None:
    with pytest.raises(ValueError, match="text messages"):
        await pipeline.editor.edit([message])
    assert pipeline.requests == []


async def test_empty_input_is_rejected_before_invocation(pipeline: Pipeline) -> None:
    with pytest.raises(ValueError, match="text messages"):
        await pipeline.editor.edit([])
    assert pipeline.requests == []


async def test_labels_and_urls_use_configured_agents(pipeline: Pipeline) -> None:
    resolver = EnvironmentAgentResolver(
        {
            "draft-writer": "https://example.test/agents/draft-writer/",
            "reviewer": "https://example.test/agents/reviewer/",
        }
    )
    configured = agent.Editor(
        name="editor",
        resolver=resolver,
        credentials=pipeline.editor._credentials,
        writer=AgentReference("draft-writer"),
        auditor=AgentReference("reviewer"),
    )
    result = await configured.edit([Message("user", ["Brief"])])
    assert result.text == (
        "## draft-writer\n\ndraft-writer result\n\n"
        "## reviewer\n\nreviewer result"
    )
    assert (
        json.loads(pipeline.requests[1].content)["input"][1]["content"]
        == "draft-writer result"
    )


async def test_trace_context_is_propagated_to_both_peers(pipeline: Pipeline) -> None:
    span = NonRecordingSpan(
        SpanContext(
            trace_id=42,
            span_id=43,
            is_remote=False,
            trace_flags=TraceFlags(TraceFlags.SAMPLED),
        )
    )
    with use_span(span, end_on_exit=False):
        await pipeline.editor.edit([Message("user", ["Brief"])])
    assert all(
        request.headers["traceparent"] == "00-" + f"{42:032x}-{43:016x}-01"
        for request in pipeline.requests
    )


async def test_host_is_request_local_after_failure(pipeline: Pipeline) -> None:
    pipeline.faults["writer"] = 503
    with pytest.raises(APIStatusError):
        await pipeline.editor.run([Message("user", ["Brief"])])
    pipeline.faults.clear()
    assert (await pipeline.editor.run([Message("user", ["Brief"])])).text == EXPECTED_TEXT
    stream = pipeline.editor.run([Message("user", ["Brief"])], stream=True)
    updates = [update async for update in stream]
    assert updates[0].text == EXPECTED_TEXT
    assert (await stream.get_final_response()).text == EXPECTED_TEXT
