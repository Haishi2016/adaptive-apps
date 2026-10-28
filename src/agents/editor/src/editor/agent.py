"""Invoke writer and auditor through stable native Responses clients."""

from __future__ import annotations

import asyncio
import os
from collections.abc import AsyncIterator, Awaitable
from functools import partial
from typing import Literal, overload
from urllib.parse import urlsplit

from agent_framework import (
    AgentResponse,
    AgentResponseUpdate,
    AgentRunInputs,
    BaseAgent,
    Message,
    ResponseStream,
    normalize_messages,
)
from agent_framework_foundry_hosting import ResponsesHostServer
from azure.ai.agentserver.core import configure_observability
from azure.ai.agentserver.responses import ResponsesServerOptions
from openai import AsyncOpenAI, DefaultAsyncHttpxClient
from openai.types.responses import ResponseInputItemParam
from opentelemetry.propagate import inject

from editor.oauth import KeycloakTokenProvider

_token_provider: KeycloakTokenProvider | None = None
_token_provider_lock = asyncio.Lock()


async def _keycloak_token() -> str:
    global _token_provider
    provider = _token_provider
    if provider is None:
        async with _token_provider_lock:
            if _token_provider is None:
                _token_provider = KeycloakTokenProvider.from_env()
            provider = _token_provider
    return await provider()


async def edit(messages: list[Message]) -> AgentResponse:
    specialists = [
        (
            os.environ[f"{prefix}_NAME"],
            os.environ[f"{prefix}_RESPONSES_BASE_URL"],
        )
        for prefix in ("WRITER", "AUDITOR")
    ]
    for name, endpoint in specialists:
        url = urlsplit(endpoint)
        if (
            url.scheme not in ("http", "https")
            or not url.hostname
            or url.username is not None
            or url.password is not None
            or url.query
            or url.fragment
            or url.path.rstrip("/") != f"/agents/{name}"
        ):
            raise ValueError("Peer endpoint must identify the configured agent")
    context: list[ResponseInputItemParam] = []
    if not messages:
        raise ValueError("Editor requires user and assistant text messages")
    for message in messages:
        if (
            message.role not in ("user", "assistant")
            or not message.text.strip()
            or any(content.type != "text" for content in message.contents)
        ):
            raise ValueError("Editor requires user and assistant text messages")
        role: Literal["user", "assistant"] = "user" if message.role == "user" else "assistant"
        context.append({"role": role, "content": message.text})
    outputs: list[str] = []
    for index, (name, endpoint) in enumerate(specialists):
        if index == 1:
            context.append(
                {
                    "role": "user",
                    "content": (
                        "Audit the preceding draft against the original brief. Return both "
                        "Audit and Final sections with your verdict and corrected draft."
                    ),
                }
            )
        async with AsyncOpenAI(
            base_url=endpoint,
            api_key=_keycloak_token,
            max_retries=0,
            timeout=600.0,
            http_client=DefaultAsyncHttpxClient(trust_env=False),
        ) as specialist:
            headers: dict[str, str] = {}
            inject(headers)
            result = await specialist.responses.create(
                input=context, store=False, extra_headers=headers
            )
        if result.status != "completed" or any(
            item.type
            in ("function_call", "custom_tool_call", "computer_call", "mcp_approval_request")
            for item in result.output
        ):
            raise ValueError(f"{name} did not complete foreground execution")
        if not result.output_text.strip():
            raise ValueError(f"{name} returned no editing result")
        outputs.append(f"## {name}\n\n{result.output_text}")
        context.append({"role": "assistant", "content": result.output_text})
    return AgentResponse(messages=[Message("assistant", ["\n\n".join(outputs)])])


class Editor(BaseAgent):
    @overload
    def run(
        self,
        messages: AgentRunInputs | None = None,
        *,
        stream: Literal[False] = False,
        **kwargs: object,
    ) -> Awaitable[AgentResponse]: ...

    @overload
    def run(
        self,
        messages: AgentRunInputs | None = None,
        *,
        stream: Literal[True],
        **kwargs: object,
    ) -> ResponseStream[AgentResponseUpdate, AgentResponse]: ...

    def run(
        self,
        messages: AgentRunInputs | None = None,
        *,
        stream: bool = False,
        **kwargs: object,
    ) -> Awaitable[AgentResponse] | ResponseStream[AgentResponseUpdate, AgentResponse]:
        context = normalize_messages(messages or [])
        if stream:
            return ResponseStream(self.updates(context), finalizer=AgentResponse.from_updates)
        return edit(context)

    async def updates(self, messages: list[Message]) -> AsyncIterator[AgentResponseUpdate]:
        result = await edit(messages)
        for message in result.messages:
            yield AgentResponseUpdate(
                contents=message.contents,
                role=message.role,
                response_id=result.response_id,
                finish_reason="stop",
            )


def main() -> None:
    ResponsesHostServer(
        Editor(name="editor"),
        history_source="agent",
        options=ResponsesServerOptions(default_fetch_history_count=100),
        configure_observability=partial(
            configure_observability, instrumentation_options={"httpx": {"enabled": True}}
        ),
    ).run(port=int(os.environ.get("PORT", "8088")))


if __name__ == "__main__":
    main()
