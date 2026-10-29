import asyncio
from urllib.parse import parse_qs

import httpx
import pytest
import respx

from adaptive_runtime.oauth import KeycloakTokenProvider

TOKEN_URL = "https://keycloak.test/realms/adaptive/protocol/openid-connect/token"


@respx.mock
async def test_concurrent_calls_share_cached_client_credentials_token() -> None:
    route = respx.post(TOKEN_URL).mock(
        return_value=httpx.Response(
            200,
            json={"access_token": "token", "token_type": "Bearer", "expires_in": 300},
        )
    )
    provider = KeycloakTokenProvider(TOKEN_URL, "client", "secret")

    assert await asyncio.gather(*(provider() for _ in range(10))) == ["token"] * 10
    assert route.call_count == 1
    request = route.calls[0].request
    assert parse_qs(request.content.decode()) == {
        "grant_type": ["client_credentials"],
        "client_id": ["client"],
        "client_secret": ["secret"],
    }


@respx.mock
async def test_expired_cache_refreshes_once() -> None:
    route = respx.post(TOKEN_URL).mock(
        side_effect=[
            httpx.Response(
                200,
                json={"access_token": "first", "token_type": "Bearer", "expires_in": 300},
            ),
            httpx.Response(
                200,
                json={"access_token": "second", "token_type": "bearer", "expires_in": 300},
            ),
        ]
    )
    provider = KeycloakTokenProvider(TOKEN_URL, "client", "secret")
    assert await provider() == "first"
    provider._refresh_at = 0
    assert await provider() == "second"
    assert route.call_count == 2


@pytest.mark.parametrize(
    "payload",
    [
        {},
        {"access_token": "", "token_type": "Bearer", "expires_in": 300},
        {"access_token": "token", "token_type": "MAC", "expires_in": 300},
        {"access_token": "token", "token_type": "Bearer", "expires_in": "300"},
        {"access_token": "token", "token_type": "Bearer", "expires_in": True},
        {"access_token": "token", "token_type": "Bearer", "expires_in": 0},
        ["not", "an", "object"],
    ],
)
@respx.mock
async def test_invalid_token_responses_fail_explicitly(payload: object) -> None:
    route = respx.post(TOKEN_URL).mock(return_value=httpx.Response(200, json=payload))
    provider = KeycloakTokenProvider(TOKEN_URL, "client", "secret")
    with pytest.raises(RuntimeError, match="Keycloak token"):
        await provider()
    assert route.call_count == 1


@respx.mock
async def test_endpoint_failure_is_not_retried() -> None:
    route = respx.post(TOKEN_URL).mock(return_value=httpx.Response(503))
    provider = KeycloakTokenProvider(TOKEN_URL, "client", "secret")
    with pytest.raises(httpx.HTTPStatusError):
        await provider()
    assert route.call_count == 1
