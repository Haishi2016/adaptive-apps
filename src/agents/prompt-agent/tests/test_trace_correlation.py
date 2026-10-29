"""Exercise native model HTTP and MCP per-call propagation, not synthetic spans."""

import json
import os
import subprocess
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from queue import Queue
from threading import Thread
from typing import Any

from opentelemetry.proto.collector.trace.v1.trace_service_pb2 import ExportTraceServiceRequest


def test_native_agent_model_and_mcp_calls_share_invocation_trace() -> None:
    received: Queue[tuple[str, dict[str, str], bytes]] = Queue()

    class Receiver(BaseHTTPRequestHandler):
        def do_POST(self) -> None:
            body = self.rfile.read(int(self.headers["Content-Length"]))
            received.put((self.path, dict(self.headers), body))
            result: dict[str, Any] = {}
            status = 200
            if self.path == "/v1/chat/completions":
                request = json.loads(body)
                has_tool_result = any(m["role"] == "tool" for m in request["messages"])
                message = (
                    {"role": "assistant", "content": "Done."}
                    if has_tool_result
                    else {
                        "role": "assistant",
                        "content": None,
                        "tool_calls": [
                            {
                                "id": "call-1",
                                "type": "function",
                                "function": {"name": "get_context", "arguments": "{}"},
                            }
                        ],
                    }
                )
                result = {
                    "id": "chat-1",
                    "object": "chat.completion",
                    "created": 1,
                    "model": "demo",
                    "choices": [
                        {
                            "index": 0,
                            "message": message,
                            "finish_reason": "stop" if has_tool_result else "tool_calls",
                        }
                    ],
                    "usage": {"prompt_tokens": 5, "completion_tokens": 3, "total_tokens": 8},
                }
            elif self.path == "/mcp":
                request = json.loads(body)
                method = request["method"]
                if method == "initialize":
                    value = {
                        "protocolVersion": request["params"]["protocolVersion"],
                        "capabilities": {"tools": {}},
                        "serverInfo": {"name": "test", "version": "1"},
                    }
                elif method == "tools/list":
                    value = {
                        "tools": [
                            {
                                "name": "get_context",
                                "description": "Read context.",
                                "inputSchema": {"type": "object", "properties": {}},
                            }
                        ]
                    }
                elif method == "tools/call":
                    value = {"content": [{"type": "text", "text": "ok"}]}
                else:
                    value = {}
                    status = 200 if "id" in request else 202
                result = {"jsonrpc": "2.0", "id": request.get("id"), "result": value}
            data = json.dumps(result).encode() if status == 200 else b""
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def do_GET(self) -> None:
            self.send_error(405)

        def log_message(self, format: str, *args: Any) -> None:
            pass

    with ThreadingHTTPServer(("127.0.0.1", 0), Receiver) as server:
        thread = Thread(target=server.serve_forever, daemon=True)
        thread.start()
        env = {
            key: value
            for key, value in os.environ.items()
            if not key.startswith(("OTEL_", "APPLICATIONINSIGHTS_", "FOUNDRY_", "AZURE_"))
        }
        env.update(
            OTEL_EXPORTER_OTLP_ENDPOINT=f"http://127.0.0.1:{server.server_port}",
            OTEL_EXPORTER_OTLP_PROTOCOL="http/protobuf",
            OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT="false",
        )
        try:
            result = subprocess.run(
                [
                    sys.executable,
                    "-c",
                    """
import asyncio, os
from functools import partial
from agent_framework import MCPStreamableHTTPTool
from agent_framework_foundry_hosting import ResponsesHostServer
from agent_framework_openai import OpenAIChatCompletionClient
from azure.ai.agentserver.core import configure_observability
from openai import AsyncOpenAI
from opentelemetry import trace, metrics
from opentelemetry._logs import get_logger_provider

endpoint = os.environ["OTEL_EXPORTER_OTLP_ENDPOINT"]
tool = MCPStreamableHTTPTool(name="lookup", url=endpoint + "/mcp")
client = OpenAIChatCompletionClient(
    model="demo", async_client=AsyncOpenAI(api_key="test", base_url=endpoint + "/v1")
)
agent = client.as_agent(name="correlation-agent", tools=[tool])
host = ResponsesHostServer(
    agent,
    configure_observability=partial(
        configure_observability, instrumentation_options={"httpx": {"enabled": True}}
    ),
)
async def run():
    async with tool:
        response = await agent.run("Read context.")
        assert response.text == "Done."
asyncio.run(run())
for provider in (trace.get_tracer_provider(), metrics.get_meter_provider(), get_logger_provider()):
    assert provider.force_flush()
    provider.shutdown()
""",
                ],
                env=env,
                capture_output=True,
                text=True,
                timeout=60,
            )
            assert result.returncode == 0, result.stdout + result.stderr
        except subprocess.TimeoutExpired as exc:
            raise AssertionError((exc.stderr or b"").decode()) from exc
        finally:
            server.shutdown()
            thread.join()

    spans, model_parents, tool_parents = [], [], []
    while not received.empty():
        path, headers, body = received.get_nowait()
        if path == "/v1/traces":
            for resource in ExportTraceServiceRequest.FromString(body).resource_spans:
                for scope in resource.scope_spans:
                    spans.extend(scope.spans)
        elif path == "/v1/chat/completions":
            model_parents.append({k.lower(): v for k, v in headers.items()}.get("traceparent"))
        elif path == "/mcp":
            request = json.loads(body)
            if request["method"] == "tools/call":
                tool_parents.append(request["params"].get("_meta", {}).get("traceparent"))
    invocation = next(s for s in spans if s.name == "invoke_agent correlation-agent")
    trace_id = invocation.trace_id.hex()
    assert len(model_parents) == 2
    assert len(tool_parents) == 1
    assert all(
        parent and parent.split("-")[1] == trace_id for parent in model_parents + tool_parents
    )
    assert any(s.name.startswith("chat ") and s.trace_id == invocation.trace_id for s in spans)
    assert any(
        s.name.startswith("execute_tool ") and s.trace_id == invocation.trace_id for s in spans
    )
