import pytest
from opentelemetry._logs import SeverityNumber
from opentelemetry.sdk._logs.export import InMemoryLogRecordExporter, SimpleLogRecordProcessor
from opentelemetry.sdk.trace import TracerProvider

from governance_sidecar.contracts import Verdict
from governance_sidecar.telemetry import GuardrailTelemetry


@pytest.mark.parametrize(
    ("mode", "decision", "blocked"),
    [
        ("enforce", "allow", False),
        ("enforce", "deny", True),
        ("enforce", "require_approval", True),
        ("audit", "deny", False),
        ("audit", "require_approval", False),
        ("audit", None, True),
    ],
)
def test_structured_decisions_preserve_context_without_sensitive_data(
    monkeypatch,
    mode,
    decision,
    blocked,
) -> None:
    monkeypatch.delenv("OTEL_EXPORTER_OTLP_ENDPOINT", raising=False)
    monkeypatch.setenv("ADAPTIVE_GOVERNANCE_AGENT_VERSION", "3")
    monkeypatch.setenv("ADAPTIVE_GOVERNANCE_DEPLOYMENT", "demo-v3")
    telemetry = GuardrailTelemetry("adaptive/demo", "a" * 64, mode)
    exporter = InMemoryLogRecordExporter()
    telemetry.provider.add_log_record_processor(SimpleLogRecordProcessor(exporter))
    verdict = (
        Verdict(
            decision=decision,
            mode=mode,
            config_sha256="a" * 64,
            agent_id="adaptive/demo",
            policy_name="baseline",
            matched_rule="read-only",
            reason="not exported",
        )
        if decision
        else None
    )
    telemetry.decision(
        {
            "traceparent": "00-" + "1" * 32 + "-" + "2" * 16 + "-01",
            "authorization": "Bearer secret",
            "baggage": "prompt=private",
        },
        "pre_tool",
        "tool",
        "booking/get_booking",
        verdict,
    )
    records = exporter.get_finished_logs()
    assert len(records) == 1
    record = records[0].log_record
    assert record.body == "guardrail.decision"
    assert record.trace_id == int("1" * 32, 16)
    assert record.span_id == int("2" * 16, 16)
    assert record.attributes["guardrail.enforced"] is blocked
    assert record.attributes["guardrail.decision"] == (decision or "error")
    assert records[0].resource.attributes["adaptive.agent.version"] == "3"
    assert records[0].resource.attributes["adaptive.agent.name"] == "demo"
    assert "secret" not in str(record.attributes)
    assert "private" not in str(record.attributes)
    assert "not exported" not in str(record.attributes)
    if decision is None:
        assert record.severity_number == SeverityNumber.ERROR
    telemetry.decision({}, "pre_input", "responses", "multi-model", verdict)
    uncorrelated = exporter.get_finished_logs()[1].log_record
    assert not uncorrelated.trace_id
    assert not uncorrelated.span_id
    telemetry.shutdown()


@pytest.mark.parametrize(
    ("headers", "trace_id", "span_id"),
    [
        ({}, 0, 0),
        ({"traceparent": "invalid"}, 0, 0),
        (
            {"traceparent": "00-" + "1" * 32 + "-" + "2" * 16 + "-01"},
            int("1" * 32, 16),
            int("2" * 16, 16),
        ),
    ],
)
def test_caller_context_never_inherits_unrelated_proxy_span(
    monkeypatch, headers, trace_id, span_id
) -> None:
    monkeypatch.delenv("OTEL_EXPORTER_OTLP_ENDPOINT", raising=False)
    telemetry = GuardrailTelemetry("adaptive/demo", "a" * 64, "enforce")
    exporter = InMemoryLogRecordExporter()
    telemetry.provider.add_log_record_processor(SimpleLogRecordProcessor(exporter))
    provider = TracerProvider()
    with provider.get_tracer("proxy").start_as_current_span("POST /v1/responses"):
        telemetry.decision(headers, "pre_input", "responses", "multi-model", None)
    record = exporter.get_finished_logs()[0].log_record
    assert record.trace_id == trace_id
    assert record.span_id == span_id
    telemetry.shutdown()
    provider.shutdown()
