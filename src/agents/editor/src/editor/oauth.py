"""Direct Keycloak client-credentials token acquisition."""

from __future__ import annotations

import asyncio
import os
import time
from typing import cast
from urllib.parse import urlsplit

import httpx


class KeycloakTokenProvider:
    """Concurrency-safe async bearer-token provider for OpenAI clients."""

    def __init__(self, token_url: str, client_id: str, client_secret: str) -> None:
        url = urlsplit(token_url)
        if (
            url.scheme not in ("http", "https")
            or not url.hostname
            or url.username is not None
            or url.password is not None
            or url.query
            or url.fragment
        ):
            raise ValueError("KEYCLOAK_TOKEN_URL must be an HTTP(S) URL without credentials")
        if not client_id.strip():
            raise ValueError("KEYCLOAK_CLIENT_ID must not be empty")
        if not client_secret:
            raise ValueError("KEYCLOAK_CLIENT_SECRET must not be empty")
        self._token_url = token_url
        self._client_id = client_id
        self._client_secret = client_secret
        self._token: str | None = None
        self._refresh_at = 0.0
        self._lock = asyncio.Lock()

    @classmethod
    def from_env(cls) -> KeycloakTokenProvider:
        return cls(
            _required_env("KEYCLOAK_TOKEN_URL"),
            _required_env("KEYCLOAK_CLIENT_ID"),
            _required_env("KEYCLOAK_CLIENT_SECRET"),
        )

    async def __call__(self) -> str:
        now = time.monotonic()
        if self._token is not None and now < self._refresh_at:
            return self._token
        async with self._lock:
            now = time.monotonic()
            if self._token is not None and now < self._refresh_at:
                return self._token
            return await self._refresh()

    async def _refresh(self) -> str:
        requested_at = time.monotonic()
        async with httpx.AsyncClient(timeout=10.0, trust_env=False) as client:
            response = await client.post(
                self._token_url,
                data={
                    "grant_type": "client_credentials",
                    "client_id": self._client_id,
                    "client_secret": self._client_secret,
                },
                headers={"Accept": "application/json"},
            )
        response.raise_for_status()
        try:
            payload = cast(object, response.json())
        except ValueError:
            raise RuntimeError("Keycloak token endpoint returned invalid JSON") from None
        if not isinstance(payload, dict):
            raise RuntimeError("Keycloak token endpoint returned a non-object response")
        token = payload.get("access_token")
        token_type = payload.get("token_type")
        expires_in = payload.get("expires_in")
        if not isinstance(token, str) or not token.strip():
            raise RuntimeError("Keycloak token response has no valid access_token")
        if not isinstance(token_type, str) or token_type.lower() != "bearer":
            raise RuntimeError("Keycloak token response has invalid token_type")
        if isinstance(expires_in, bool) or not isinstance(expires_in, int) or expires_in <= 0:
            raise RuntimeError("Keycloak token response has invalid expires_in")
        refresh_skew = min(expires_in / 2, max(1.0, min(30.0, expires_in * 0.1)))
        refresh_at = requested_at + expires_in - refresh_skew
        if refresh_at <= time.monotonic():
            raise RuntimeError("Keycloak token expired before it could be used")
        self._token = token
        self._refresh_at = refresh_at
        return token


def _required_env(name: str) -> str:
    value = os.environ.get(name)
    if value is None or not value.strip():
        raise RuntimeError(f"{name} is required")
    return value
