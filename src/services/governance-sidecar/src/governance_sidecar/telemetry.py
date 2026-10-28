from __future__ import annotations

import logging
import os
from collections.abc import Mapping

from opentelemetry._logs import SeverityNumber
from opentelemetry.context import Context
from opentelemetry.exporter.otlp.proto.http._log_exporter import OTLPLogExporter
from opentelemetry.propagate import extract
from opentelemetry.sdk._logs import LoggerProvider
from opentelemetry.sdk._logs.export import BatchLogRecordProcessor
from opentelemetry.sdk.resources import Resource
from opentelemetry.trace import INVALID_SPAN, set_span_in_context
from opentelemetry.util.types import Attributes

from governance_sidecar.contracts import Mode, Stage, Verdict

logger = logging.getLogger(__name__)


class GuardrailTelemetry:
    def __init__(self, agent_id: str, digest: str, mode: Mode) -> None:
        namespace, _, name = agent_id.partition("/")
        self.digest, self.mode = digest, mode
        self.provider = LoggerProvider(
            resource=Resource(
                {
                    "service.name": "governance-sidecar",
                    "service.namespace": namespace,
                    "k8s.namespace.name": namespace,
                    "adaptive.agent.name": name,
                    "adaptive.agent.version": os.environ.get(
                        "ADAPTIVE_GOVERNANCE_AGENT_VERSION", ""
                    ),
                    "adaptive.agent.deployment": os.environ.get(
                        "ADAPTIVE_GOVERNANCE_DEPLOYMENT", ""
                    ),
                    "agent.id": agent_id,
                }
            )
        )
        endpoint = os.environ.get("OTEL_EXPORTER_OTLP_ENDPOINT")
        if endpoint:
            self.provider.add_log_record_processor(
                BatchLogRecordProcessor(
                    OTLPLogExporter(endpoint=endpoint.rstrip("/") + "/v1/logs", timeout=5),
                    schedule_delay_millis=1000,
                    max_queue_size=2048,
                )
            )
        else:
            logger.warning("Guardrail OTLP export disabled: OTEL_EXPORTER_OTLP_ENDPOINT is unset")
        self.logger = self.provider.get_logger("adaptive.guardrails")

    def decision(
        self,
        headers: Mapping[str, str],
        stage: Stage,
        action: str,
        resource: str,
        verdict: Verdict | None,
    ) -> None:
        decision = verdict.decision if verdict else "error"
        mode = verdict.mode if verdict else self.mode
        enforced = decision != "allow" and (mode == "enforce" or verdict is None)
        attributes: Attributes = {
            "guardrail.stage": stage,
            "guardrail.action": action,
            "guardrail.resource": resource,
            "guardrail.decision": decision,
            "guardrail.mode": mode,
            "guardrail.enforced": enforced,
            "guardrail.config_sha256": self.digest,
            "guardrail.policy": verdict.policy_name if verdict else "",
            "guardrail.rule": (verdict.matched_rule or "") if verdict else "",
        }
        self.logger.emit(
            body="guardrail.decision",
            event_name="guardrail.decision",
            severity_number=SeverityNumber.ERROR
            if verdict is None
            else (SeverityNumber.WARN if decision != "allow" else SeverityNumber.INFO),
            context=extract(headers, context=set_span_in_context(INVALID_SPAN, Context())),
            attributes=attributes,
        )

    def shutdown(self) -> None:
        self.provider.shutdown()
