import hashlib
import json

import pytest
from test_contracts import config

from governance_sidecar.contracts import (
    APPLICATION_POLICY_NAMESPACE,
    PLATFORM_POLICY_NAMESPACE,
    GovernanceSettings,
    PolicySnapshot,
    attached_policy,
    compose_bundle,
    effective_policies,
)


def snapshot(targets: list[str], namespace: str = PLATFORM_POLICY_NAMESPACE) -> PolicySnapshot:
    content = json.dumps({**config()["bundle"], "targets": targets})
    return PolicySnapshot(
        reference=f"{namespace}/guardrail-{'a' * 24}@sha256:{hashlib.sha256(content.encode()).hexdigest()}",
        content=content,
    )


@pytest.mark.parametrize("pattern", ["adaptive/*", "*/travel-helper", "*/*", "adaptive/travel-*"])
def test_wildcards_select_existing_and_future_agents(pattern: str) -> None:
    source = snapshot([pattern])
    assert effective_policies("adaptive/travel-helper", [source], None) == [source]
    assert not effective_policies("other/booking-manager", [snapshot(["adaptive/*"])], None)


@pytest.mark.parametrize("pattern", ["*", "adaptive/?", "adaptive/[ab]", "adaptive/*/x", "/agent"])
def test_selectors_reject_unsupported_syntax(pattern: str) -> None:
    with pytest.raises(ValueError, match="pattern"):
        snapshot([pattern])


def test_single_schema_composition_and_snapshot_retention() -> None:
    first, second = snapshot(["adaptive/*"]), snapshot(["adaptive/travel-*"])
    own = snapshot([], APPLICATION_POLICY_NAMESPACE)
    selected = effective_policies("adaptive/travel-helper", [second, first], own)
    assert compose_bundle(selected) == compose_bundle(
        effective_policies("adaptive/travel-helper", [first, second], own)
    )
    assert len(compose_bundle(selected).policies) == 3
    assert len(compose_bundle(effective_policies("other/demo", [], own)).policies) == 1
    assert compose_bundle(effective_policies("other/demo", [first], None)) is None
    assert effective_policies("adaptive/demo", [first], first) == [first]
    assert (
        attached_policy(
            {"definition": {"policyRef": own.reference}, "governance": own.model_dump()}
        )
        == own
    )
    with pytest.raises(ValueError, match="captured"):
        attached_policy({"definition": {"policyRef": own.reference}})
    with pytest.raises(ValueError, match="does not match"):
        PolicySnapshot(reference=own.reference, content=first.content)


def test_application_source_cannot_escalate_using_targets() -> None:
    with pytest.raises(ValueError, match="cannot declare automatic targets"):
        snapshot(["*/*"], APPLICATION_POLICY_NAMESPACE)


def test_radius_native_policy_names_are_opaque_dns_characters() -> None:
    source = snapshot([], APPLICATION_POLICY_NAMESPACE)
    reference = source.reference.replace(
        "guardrail-" + "a" * 24, "guardrail-zmwinvr4m6nm2dd3t7zyxh3c"
    )
    assert (
        PolicySnapshot(reference=reference, content=source.content).definition == source.definition
    )
    with pytest.raises(ValueError, match="pattern"):
        PolicySnapshot(
            reference=reference.replace("guardrail-z", "guardrail-Z"), content=source.content
        )


def test_old_chart_policy_settings_are_rejected() -> None:
    with pytest.raises(ValueError, match="Extra inputs"):
        GovernanceSettings.model_validate(
            {
                "image": "example/sidecar@sha256:" + "a" * 64,
                "bundle": config()["bundle"],
            }
        )
