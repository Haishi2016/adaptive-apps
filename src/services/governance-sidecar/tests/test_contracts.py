import pytest
from pydantic import ValidationError

from governance_sidecar.contracts import ProxyConfig, ToolEndpoint


def config() -> dict:
    return {
        "model_base_url": "http://gateway/v1",
        "tools": {"booking": {"url": "https://booking/mcp", "protocol": "mcp"}},
        "bundle": {
            "policies": [
                {
                    "apiVersion": "governance.toolkit/v1",
                    "name": "baseline",
                    "default_action": "deny",
                    "rules": [
                        {
                            "name": "model",
                            "stage": "pre_input",
                            "condition": "resource == 'multi-model'",
                            "action": "allow",
                        }
                    ],
                }
            ]
        },
    }


def test_config_digest_covers_routes_and_policy_with_stable_rollback() -> None:
    original = ProxyConfig.model_validate(config())
    for field in ("route", "policy"):
        changed = original.model_copy(deep=True)
        if field == "route":
            changed.tools["booking"].url = "https://other/mcp"
        else:
            changed.bundle.policies[0].rules[0].action = "deny"
        assert changed.digest() != original.digest()
    assert ProxyConfig.model_validate_json(original.canonical()).digest() == original.digest()
    assert ProxyConfig.model_validate(config()).digest() == original.digest()


def test_policy_mode_is_optional_and_part_of_configuration_digest() -> None:
    original = ProxyConfig.model_validate(config())
    assert '"mode"' not in original.canonical()
    assert "mode" not in original.bundle.policies[0].model_dump(exclude={"mode"})
    changed = original.model_copy(deep=True)
    changed.bundle.policies[0].mode = "audit"
    assert changed.digest() != original.digest()
    assert ProxyConfig.model_validate_json(changed.canonical()).bundle.policies[0].mode == "audit"
    value = config()
    value["bundle"]["policies"][0]["mode"] = "disabled"
    with pytest.raises(ValidationError):
        ProxyConfig.model_validate(value)


@pytest.mark.parametrize(
    "url",
    [
        "file:///policies/proxy.json",
        "https://user:password@host/mcp",
        "/relative",
        "http://127.0.0.1:8082/tools/booking",
        "http://localhost:8082/",
        "https://host/mcp#fragment",
        "https://host\\@other/",
        "https://host/has space",
    ],
)
def test_unsafe_upstreams_rejected(url: str) -> None:
    with pytest.raises(ValidationError):
        ToolEndpoint(url=url, protocol="mcp")


@pytest.mark.parametrize("fault", ["stage", "extra", "duplicate", "query", "env"])
def test_invalid_contract_rejected(fault: str) -> None:
    value = config()
    if fault == "stage":
        value["bundle"]["policies"][0]["rules"][0]["stage"] = "pre_model"
    elif fault == "extra":
        value["bundle"]["policies"][0]["context"] = {}
    elif fault == "duplicate":
        value["bundle"]["policies"].append(value["bundle"]["policies"][0])
    elif fault == "query":
        value["model_base_url"] += "?model=untrusted"
    else:
        value["tools"]["booking"]["endpoint_env"] = "BOOKING_URL"
        value["tools"]["another"] = dict(value["tools"]["booking"])
    with pytest.raises(ValidationError):
        ProxyConfig.model_validate(value)
