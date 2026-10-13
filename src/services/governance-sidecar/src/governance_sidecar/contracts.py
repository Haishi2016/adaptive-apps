from __future__ import annotations

import hashlib
import re
from collections.abc import Mapping
from fnmatch import fnmatchcase
from typing import Annotated, Literal
from urllib.parse import urlsplit

from pydantic import (
    AfterValidator,
    BaseModel,
    ConfigDict,
    Field,
    SerializerFunctionWrapHandler,
    model_serializer,
    model_validator,
)

Stage = Literal["pre_input", "pre_tool"]
Mode = Literal["enforce", "audit"]
PROXY_URL = "http://127.0.0.1:8082"
POLICY_LABEL = "adaptive.jplck.io/resource=agent-guardrails"
PLATFORM_POLICY_NAMESPACE = "adaptive-guardrails-platform"
APPLICATION_POLICY_NAMESPACE = "adaptive-guardrails-apps"
POLICY_NAMESPACES = (PLATFORM_POLICY_NAMESPACE, APPLICATION_POLICY_NAMESPACE)
REFERENCE_PATTERN = (
    r"^(adaptive-guardrails-platform|adaptive-guardrails-apps)/"
    r"guardrail-[a-z0-9]{24}@sha256:[a-f0-9]{64}$"
)


def _upstream_url(value: str) -> str:
    url = urlsplit(value)
    if (
        url.scheme not in ("http", "https")
        or not url.hostname
        or url.username is not None
        or url.password is not None
        or url.fragment
        or "\\" in value
        or any(char.isspace() for char in value)
        or (url.hostname in ("localhost", "127.0.0.1", "::1") and url.port == 8082)
    ):
        raise ValueError(
            "Upstream must be an HTTP(S) URL without credentials, fragment or proxy loop"
        )
    return value


UpstreamURL = Annotated[str, Field(max_length=2048), AfterValidator(_upstream_url)]
ToolName = Annotated[str, Field(pattern=r"^[a-z][a-z0-9-]{0,62}$")]


class Contract(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)


class Rule(Contract):
    name: str = Field(min_length=1, max_length=128)
    stage: Stage
    # A deliberately bounded subset of AGT expressions. Reject unsupported
    # syntax instead of letting the upstream parser silently ignore it.
    condition: str = Field(
        pattern=(
            r"^((action|resource) (==|!=) '[A-Za-z0-9_./:*-]{1,200}'"
            r"|(pii|prompt_injection) (==|!=) '(detected|clear)')$"
        ),
        max_length=230,
    )
    action: Literal["allow", "deny", "require_approval"]
    description: str = Field(default="", max_length=512)


class Policy(Contract):
    apiVersion: Literal["governance.toolkit/v1"]
    name: str = Field(min_length=1, max_length=128)
    default_action: Literal["deny"]
    mode: Mode | None = None
    rules: list[Rule] = Field(min_length=1, max_length=200)

    @model_serializer(mode="wrap")
    def serialize(self, handler: SerializerFunctionWrapHandler) -> dict[str, object]:
        values: dict[str, object] = handler(self)
        if self.mode is None:
            values.pop("mode", None)
        return values

    @model_validator(mode="after")
    def unique_rules(self) -> Policy:
        if len({rule.name for rule in self.rules}) != len(self.rules):
            raise ValueError("Policy rule names must be unique")
        return self


class Bundle(Contract):
    policies: list[Policy] = Field(min_length=1, max_length=20)

    @model_validator(mode="after")
    def unique_policies(self) -> Bundle:
        if len({policy.name for policy in self.policies}) != len(self.policies):
            raise ValueError("Policy names must be unique")
        if len(self.canonical().encode()) > 64_000:
            raise ValueError("Policy bundle exceeds 64 KB")
        return self

    def canonical(self) -> str:
        return self.model_dump_json()

    def digest(self) -> str:
        return hashlib.sha256(self.canonical().encode()).hexdigest()


class ToolEndpoint(Contract):
    url: UpstreamURL
    protocol: Literal["mcp", "http"]
    endpoint_env: str | None = Field(default=None, pattern=r"^[A-Z][A-Z0-9_]*_(URL|ENDPOINT)$")


class ProxyConfig(Contract):
    bundle: Bundle
    model_base_url: UpstreamURL
    tools: dict[ToolName, ToolEndpoint] = Field(default_factory=dict, max_length=32)

    @model_validator(mode="after")
    def validate_endpoints(self) -> ProxyConfig:
        if urlsplit(self.model_base_url).query:
            raise ValueError("Model base URL cannot contain a query")
        variables = [tool.endpoint_env for tool in self.tools.values() if tool.endpoint_env]
        if len(set(variables)) != len(variables):
            raise ValueError("Tool endpoint environment variables must be unique")
        if len(self.canonical().encode()) > 96_000:
            raise ValueError("Proxy configuration exceeds 96 KB")
        return self

    def canonical(self) -> str:
        return self.model_dump_json()

    def digest(self) -> str:
        return hashlib.sha256(self.canonical().encode()).hexdigest()


def policy_reference(value: object) -> str | None:
    if value is None:
        return None
    if not isinstance(value, str) or not re.fullmatch(REFERENCE_PATTERN, value):
        raise ValueError("governance policyRef must contain an immutable Radius bundleRef")
    return value


class PolicyDefinition(Bundle):
    targets: list[
        Annotated[
            str,
            Field(pattern=r"^[a-z0-9*][a-z0-9.*-]*/[a-z0-9*][a-z0-9*-]*$", max_length=200),
        ]
    ] = Field(default_factory=list, max_length=100)

    def matches(self, agent_id: str) -> bool:
        return any(fnmatchcase(agent_id, pattern) for pattern in self.targets)


class PolicySnapshot(Contract):
    reference: str = Field(pattern=REFERENCE_PATTERN)
    content: str = Field(max_length=64_000)

    @model_validator(mode="after")
    def validate_content(self) -> PolicySnapshot:
        if (
            self.reference.rsplit("@sha256:", 1)[1]
            != hashlib.sha256(self.content.encode()).hexdigest()
        ):
            raise ValueError("Policy content does not match its immutable reference")
        definition = self.definition
        if self.namespace == APPLICATION_POLICY_NAMESPACE and definition.targets:
            raise ValueError("Application policies cannot declare automatic targets")
        return self

    @property
    def namespace(self) -> str:
        return self.reference.split("/", 1)[0]

    @property
    def definition(self) -> PolicyDefinition:
        return PolicyDefinition.model_validate_json(self.content)


def effective_policies(
    agent_id: str, platform: list[PolicySnapshot], attached: PolicySnapshot | None
) -> list[PolicySnapshot]:
    selected = {
        item.reference: item
        for item in platform
        if item.namespace == PLATFORM_POLICY_NAMESPACE and item.definition.matches(agent_id)
    }
    if attached is not None:
        selected[attached.reference] = attached
    return [selected[key] for key in sorted(selected)]


def compose_bundle(policies: list[PolicySnapshot]) -> Bundle | None:
    if not policies:
        return None
    combined = []
    for snapshot in policies:
        prefix = hashlib.sha256(snapshot.reference.encode()).hexdigest()[:16]
        for index, policy in enumerate(snapshot.definition.policies):
            combined.append(
                policy.model_copy(update={"name": f"{prefix}/{index}:{policy.name[:100]}"})
            )
    return Bundle(policies=combined)


def attached_policy(spec: Mapping[str, object]) -> PolicySnapshot | None:
    definition = spec.get("definition", {})
    if not isinstance(definition, Mapping):
        raise ValueError("Agent governance definition must be an object")
    reference = policy_reference(definition.get("policyRef"))
    captured = spec.get("governance")
    if reference is None:
        if captured is not None:
            raise ValueError("Captured policy has no agent reference")
        return None
    if captured is None:
        raise ValueError("Agent policy reference has no captured immutable policy")
    snapshot = PolicySnapshot.model_validate(captured)
    if snapshot.reference != reference:
        raise ValueError("Captured policy differs from the agent version reference")
    return snapshot


class GovernanceSettings(Contract):
    image: str = Field(pattern=r"^[^\s@]+@sha256:[0-9a-f]{64}$")
    mode: Mode = "enforce"
    tools: dict[ToolName, ToolEndpoint] = Field(default_factory=dict, max_length=32)


class Verdict(Contract):
    decision: Literal["allow", "deny", "require_approval"]
    mode: Mode
    config_sha256: str = Field(pattern=r"^[0-9a-f]{64}$")
    agent_id: str = Field(min_length=1)
    policy_name: str = Field(min_length=1)
    matched_rule: str | None
    reason: str
