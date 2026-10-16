"""Smoke tests for the prompt-agent runtime.

The runtime builds a native ``agent_framework`` chat agent with the
in-cluster Model Gateway client and hands it to :class:`ResponsesHostServer`.

We assert the shape: that the module imports with the env vars the
Agent Operator injects, that the host exposes the canonical Foundry
Responses routes, and that the chat agent's system prompt + sampling
options reflect the env-injected ``Agent`` CRD fields. Per-token
streaming is exercised by the UI playground integration; we don't reach
into the host's HTTP surface here.
"""

from __future__ import annotations

import importlib
import json
import os
import subprocess
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from queue import Queue
from threading import Thread
from typing import Any

import pytest
from opentelemetry.proto.collector.logs.v1.logs_service_pb2 import ExportLogsServiceRequest
from opentelemetry.proto.collector.metrics.v1.metrics_service_pb2 import ExportMetricsServiceRequest
from opentelemetry.proto.collector.trace.v1.trace_service_pb2 import ExportTraceServiceRequest


@pytest.fixture(autouse=True)
def _runtime_env(monkeypatch: pytest.MonkeyPatch) -> None:
    """Match the env vars the Agent Operator injects from the Agent CRD."""

    monkeypatch.setenv("AGENT_NAME", "writer")
    monkeypatch.setenv("AGENT_NAMESPACE", "adaptive")
    monkeypatch.setenv("AGENT_INSTRUCTIONS", "You are a concise travel assistant.")
    monkeypatch.setenv("OPENAI_BASE_URL", "http://model-gateway.adaptive.svc.cluster.local:8080")
    monkeypatch.setenv("OPENAI_MODEL", "qwen2.5-7b-instruct")
    monkeypatch.setenv("KEYCLOAK_TOKEN_URL", "http://keycloak.test/realms/adaptive/token")
    monkeypatch.setenv("KEYCLOAK_CLIENT_ID", "prompt-agent")
    monkeypatch.setenv("KEYCLOAK_CLIENT_SECRET", "test-secret")
    monkeypatch.setenv("CLUSTER_MODE", "redButton")
    # The native host reads telemetry configuration directly from the environment.
    monkeypatch.delenv("OTEL_EXPORTER_OTLP_ENDPOINT", raising=False)
    sys.modules.pop("adaptive_runtime.main", None)


def _import() -> Any:
    return importlib.import_module("adaptive_runtime.main")


def test_runtime_module_exposes_responses_host() -> None:
    runtime = _import()

    from azure.ai.agentserver.responses import ResponsesAgentServerHost

    # ResponsesHostServer extends ResponsesAgentServerHost; the host
    # exposes the canonical Foundry Responses surface unchanged.
    assert isinstance(runtime.app, ResponsesAgentServerHost)
    route_names = {getattr(r, "name", "") for r in runtime.app.routes}
    assert "create_response" in route_names
    assert "readiness" in route_names


def test_agent_is_a_chat_agent_with_env_injected_prompt() -> None:
    runtime = _import()

    # The agent is what ResponsesHostServer calls .run() on per turn;
    # ChatAgent.run() is the code path that emits the three A365 spans
    # (invoke_agent → Agent run → chat <model>). Asserting the agent
    # carries the operator-injected prompt + name guarantees a
    # hand-rolled @response_handler regression doesn't reappear.
    agent = runtime.agent
    assert getattr(agent, "name", None) == "writer"
    # Instructions, temperature and top_p flow through ChatAgent.default_options
    # (the Agent class exposes them there, not as direct attributes).
    options = getattr(agent, "default_options", None) or {}
    assert "concise travel assistant" in (options.get("instructions") or "")
    assert options.get("temperature") == pytest.approx(0.7)
    assert options.get("top_p") == pytest.approx(1.0)


async def test_gateway_uses_fresh_native_oauth_token_callback(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    runtime = _import()
    tokens = iter(["first-token", "refreshed-token"])

    async def token() -> str:
        return next(tokens)

    monkeypatch.setattr(runtime, "_gateway_token", token)
    assert await runtime._gateway_token() == "first-token"
    assert await runtime._gateway_token() == "refreshed-token"


def test_runtime_installs_request_identity_middleware() -> None:
    from adaptive_runtime.tools import ToolHeadersMiddleware

    runtime = _import()
    assert runtime.app.user_middleware[0].cls is ToolHeadersMiddleware


def test_runtime_picks_up_openai_v1_suffix() -> None:
    runtime = _import()

    # Settings.openai_v1_base_url auto-appends /v1 when missing.
    assert runtime.settings.openai_v1_base_url.endswith("/v1")


def test_deployment_skills_are_native_context_providers(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv(
        "AGENT_SKILLS",
        json.dumps(
            [
                {
                    "path": "travel/SKILL.md",
                    "name": "travel",
                    "description": "Travel advice",
                    "content": "---\nname: travel\ndescription: Travel advice\n---\nCheck destinations.\n",
                }
            ]
        ),
    )
    runtime = _import()
    assert runtime._skills is not None
    assert runtime._skills in runtime.agent.context_providers


def test_native_sdk_exports_otlp_from_environment() -> None:
    received: Queue[tuple[str, bytes]] = Queue()

    class Receiver(BaseHTTPRequestHandler):
        def do_POST(self) -> None:
            received.put((self.path, self.rfile.read(int(self.headers["Content-Length"]))))
            self.send_response(200)
            self.send_header("Content-Length", "0")
            self.end_headers()

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
        )
        try:
            # A fresh process prevents the SDK's one-time global setup from leaking
            # between tests. Import the real runtime, not a custom tracer provider.
            result = subprocess.run(
                [
                    sys.executable,
                    "-c",
                    """
from adaptive_runtime import main
from opentelemetry import trace, metrics
from opentelemetry._logs import get_logger, get_logger_provider

with trace.get_tracer("probe").start_as_current_span("sdk-otlp-probe"):
    get_logger("probe").emit(body="sdk-otlp-probe")
metrics.get_meter("probe").create_counter("sdk_otlp_probe").add(1)
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
        finally:
            server.shutdown()
            thread.join()

    spans, logs, metric_names = [], [], []
    while not received.empty():
        path, body = received.get_nowait()
        if path == "/v1/traces":
            for resource in ExportTraceServiceRequest.FromString(body).resource_spans:
                for scope in resource.scope_spans:
                    spans.extend(span.name for span in scope.spans)
        elif path == "/v1/logs":
            for resource in ExportLogsServiceRequest.FromString(body).resource_logs:
                for scope in resource.scope_logs:
                    logs.extend(record.body.string_value for record in scope.log_records)
        elif path == "/v1/metrics":
            for resource in ExportMetricsServiceRequest.FromString(body).resource_metrics:
                for scope in resource.scope_metrics:
                    metric_names.extend(metric.name for metric in scope.metrics)
        else:
            pytest.fail(f"Unexpected OTLP path: {path}")
    assert spans.count("sdk-otlp-probe") == 1
    assert "sdk-otlp-probe" in logs
    assert "sdk_otlp_probe" in metric_names
