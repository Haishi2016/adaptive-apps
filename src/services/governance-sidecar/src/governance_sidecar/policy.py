from __future__ import annotations

import logging
from typing import Any

from agent_os.credential_redactor import CredentialRedactor
from agent_os.prompt_injection import PromptInjectionDetector
from agentmesh.governance.policy import Policy, PolicyEngine

from governance_sidecar.contracts import Bundle, Mode, Stage, Verdict

logger = logging.getLogger(__name__)


class Policies:
    def __init__(self, bundle: Bundle, digest: str, agent_id: str, mode: Mode) -> None:
        self.digest, self.agent_id, self.mode = digest, agent_id, mode
        self.content_checks = {
            stage: {
                rule.condition.split(" ", 1)[0]
                for definition in bundle.policies
                for rule in definition.rules
                if rule.stage == stage
                and rule.condition.split(" ", 1)[0] in ("pii", "prompt_injection")
            }
            for stage in ("pre_input", "pre_tool")
        }
        self.injection_detector = (
            PromptInjectionDetector()
            if any("prompt_injection" in checks for checks in self.content_checks.values())
            else None
        )
        self.engines: list[tuple[str, Any, Mode]] = []
        for definition in bundle.policies:
            engine = PolicyEngine(conflict_strategy="deny_overrides")
            engine.load_policy(
                Policy.model_validate(
                    {
                        **definition.model_dump(exclude={"mode"}),
                        "agents": [agent_id],
                        "rules": [
                            {
                                **rule.model_dump(),
                                "priority": 1 if rule.action == "require_approval" else 0,
                            }
                            for rule in definition.rules
                        ],
                    }
                )
            )
            self.engines.append((definition.name, engine, definition.mode or mode))
        if not self.engines or not agent_id:
            raise ValueError("No policy applies to the configured workload")

    def evaluate(self, stage: Stage, action: str, resource: str, content: str = "") -> Verdict:
        context = {"action": action, "resource": resource}
        if "pii" in self.content_checks[stage]:
            detected = CredentialRedactor.contains_pii(content)
            if not isinstance(detected, bool):
                raise RuntimeError("AGT PII detector returned an invalid result")
            context["pii"] = "detected" if detected else "clear"
        if "prompt_injection" in self.content_checks[stage]:
            if self.injection_detector is None:
                raise RuntimeError("Prompt-injection detector is not configured")
            result = self.injection_detector.detect(content, source=self.agent_id)
            if (
                not isinstance(result.is_injection, bool)
                or not isinstance(result.matched_patterns, list)
                or not all(isinstance(pattern, str) for pattern in result.matched_patterns)
                or "detection_error" in result.matched_patterns
            ):
                raise RuntimeError("AGT prompt-injection detector failed")
            context["prompt_injection"] = "detected" if result.is_injection else "clear"
        decisions: list[Verdict] = []
        for name, engine, policy_mode in self.engines:
            result = engine.evaluate(
                agent_did=self.agent_id,
                context=context,
                stage=stage,
            )
            decisions.append(
                Verdict(
                    decision=result.action,
                    mode=policy_mode,
                    config_sha256=self.digest,
                    agent_id=self.agent_id,
                    policy_name=name,
                    matched_rule=result.matched_rule,
                    reason=result.reason,
                )
            )
        verdict = max(
            decisions,
            key=lambda d: (
                d.mode == "enforce" and d.decision != "allow",
                d.decision == "deny",
                d.decision == "require_approval",
            ),
        )
        logger.log(
            logging.INFO if verdict.decision == "allow" else logging.WARNING,
            "AGT decision=%s mode=%s agent=%s config=%s policy=%s rule=%s",
            verdict.decision,
            verdict.mode,
            self.agent_id,
            self.digest,
            verdict.policy_name,
            verdict.matched_rule,
        )
        return verdict
