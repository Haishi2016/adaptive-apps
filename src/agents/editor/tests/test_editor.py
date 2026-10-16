import json

import httpx2 as httpx
import pytest
from agent_framework import Message
from openai import APIStatusError
from opentelemetry.trace import NonRecordingSpan, SpanContext, TraceFlags, use_span

from editor import agent

EXPECTED_TEXT = "## writer\n\nwriter result\n\n## auditor\n\nauditor result"


@pytest.fixture
def pipeline(monkeypatch):
    for prefix, name in (("WRITER", "writer"), ("AUDITOR", "auditor")):
        monkeypatch.setenv(f"{prefix}_NAME", name)
        monkeypatch.setenv(f"{prefix}_RESPONSES_BASE_URL", f"https://example.test/agents/{name}/")
    requests = []
    faults = {}
    tokens = []

    async def get_token():
        tokens.append("requested")
        return "application-token"

    monkeypatch.setattr(agent, "_token_provider", get_token)

    def transport(request):
        name = request.url.path.split("/")[2]
        requests.append(request)
        assert request.method == "POST"
        prefix = next(
            prefix for prefix in ("WRITER", "AUDITOR") if agent.os.environ[f"{prefix}_NAME"] == name
        )
        assert request.url.path == f"/agents/{name}/responses"
        assert request.headers["authorization"] == "Bearer application-token"
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
    return requests, faults, tokens


async def test_sequence_and_request_local_context(pipeline):
    requests, _, tokens = pipeline
    for _ in range(2):
        result = await agent.edit([Message("user", ["Brief"])])
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
    assert [json.loads(request.content)["input"] for request in requests] == [
        writer_input,
        auditor_input,
        writer_input,
        auditor_input,
    ]
    assert tokens == ["requested"] * 4
    assert all(set(json.loads(request.content)) == {"input", "store"} for request in requests)


@pytest.mark.parametrize("prefix", ["WRITER", "AUDITOR"])
@pytest.mark.parametrize(
    "endpoint",
    [
        "https://example.test/agents/other/",
        "https://example.test/agents/writer/versions/v1/",
        "https://user:password@example.test/agents/writer/versions/v1/",
        "https://example.test/agents/writer/?redirect=elsewhere",
        "https://example.test/agents/writer/#fragment",
        "file:///agents/writer/",
    ],
)
async def test_invalid_peer_endpoint_fails_before_credentials_or_network(
    pipeline, monkeypatch, prefix, endpoint
):
    monkeypatch.setenv(f"{prefix}_RESPONSES_BASE_URL", endpoint)
    with pytest.raises(ValueError, match="configured agent"):
        await agent.edit([Message("user", ["Brief"])])
    assert pipeline[0] == []
    assert pipeline[2] == []


@pytest.mark.parametrize("name", ["writer", "auditor"])
@pytest.mark.parametrize("status", [403, 404, 503])
async def test_peer_failure_aborts_without_retry_or_partial_success(pipeline, name, status):
    requests, faults, _ = pipeline
    faults[name] = status
    with pytest.raises(APIStatusError):
        await agent.edit([Message("user", ["Brief"])])
    assert len(requests) == (1 if name == "writer" else 2)


@pytest.mark.parametrize("name", ["writer", "auditor"])
async def test_empty_specialist_output_is_rejected(pipeline, name):
    pipeline[1][name] = {"output": []}
    with pytest.raises(ValueError, match=f"{name} returned no editing result"):
        await agent.edit([Message("user", ["Brief"])])


@pytest.mark.parametrize("status", ["failed", "incomplete", "in_progress"])
async def test_incomplete_response_is_not_success(pipeline, status):
    pipeline[1]["writer"] = {"status": status}
    with pytest.raises(ValueError, match="did not complete"):
        await agent.edit([Message("user", ["Brief"])])
    assert len(pipeline[0]) == 1


async def test_caller_executed_function_is_not_silently_ignored(pipeline):
    pipeline[1]["writer"] = {
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
        await agent.edit([Message("user", ["Brief"])])
    assert len(pipeline[0]) == 1


@pytest.mark.parametrize("message", [Message("system", ["Unsupported"]), Message("user", [" \n "])])
async def test_unsupported_input_is_not_coerced(pipeline, message):
    with pytest.raises(ValueError, match="text messages"):
        await agent.edit([message])
    assert pipeline[0] == []


async def test_empty_input_is_rejected_before_invocation(pipeline):
    with pytest.raises(ValueError, match="text messages"):
        await agent.edit([])
    assert pipeline[0] == []


async def test_labels_and_urls_use_configured_agents(pipeline, monkeypatch):
    for prefix, name in (
        ("WRITER", "draft-writer"),
        ("AUDITOR", "reviewer"),
    ):
        monkeypatch.setenv(f"{prefix}_NAME", name)
        monkeypatch.setenv(
            f"{prefix}_RESPONSES_BASE_URL",
            f"https://example.test/agents/{name}/",
        )
    result = await agent.edit([Message("user", ["Brief"])])
    assert result.text == (
        "## draft-writer\n\ndraft-writer result\n\n"
        "## reviewer\n\nreviewer result"
    )
    assert json.loads(pipeline[0][1].content)["input"][1]["content"] == "draft-writer result"


async def test_trace_context_is_propagated_to_both_peers(pipeline):
    span = NonRecordingSpan(
        SpanContext(
            trace_id=42,
            span_id=43,
            is_remote=False,
            trace_flags=TraceFlags(TraceFlags.SAMPLED),
        )
    )
    with use_span(span, end_on_exit=False):
        await agent.edit([Message("user", ["Brief"])])
    assert all(
        request.headers["traceparent"] == "00-" + f"{42:032x}-{43:016x}-01"
        for request in pipeline[0]
    )


async def test_host_is_request_local_after_failure(pipeline):
    pipeline[1]["writer"] = 503
    host = agent.Editor(name="editor")
    with pytest.raises(APIStatusError):
        await host.run([Message("user", ["Brief"])])
    pipeline[1].clear()
    assert (await host.run([Message("user", ["Brief"])])).text == EXPECTED_TEXT
    stream = host.run([Message("user", ["Brief"])], stream=True)
    updates = [update async for update in stream]
    assert updates[0].text == EXPECTED_TEXT
    assert (await stream.get_final_response()).text == EXPECTED_TEXT
