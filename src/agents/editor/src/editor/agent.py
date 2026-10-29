from __future__ import annotations

from collections.abc import AsyncIterator, Awaitable
from typing import Literal, overload

from adaptive_agent_contracts import (
    AgentReference,
    AgentRequirements,
    AgentResolver,
    HostCapability,
    TokenProvider,
)
from agent_framework import (
    AgentResponse,
    AgentResponseUpdate,
    AgentRunInputs,
    BaseAgent,
    Message,
    ResponseStream,
    normalize_messages,
)
from openai import AsyncOpenAI, DefaultAsyncHttpxClient
from openai.types.responses import ResponseInputItemParam
from opentelemetry.propagate import inject

DEFAULT_WRITER = AgentReference("writer")
DEFAULT_AUDITOR = AgentReference("auditor")
EDITOR_REQUIREMENTS = AgentRequirements(
    required=frozenset(
        {
            HostCapability.FOREGROUND_RESPONSES,
            HostCapability.PEER_DISCOVERY,
        }
    )
)


class Editor(BaseAgent):
    def __init__(
        self,
        *,
        name: str,
        resolver: AgentResolver,
        credentials: TokenProvider,
        writer: AgentReference = DEFAULT_WRITER,
        auditor: AgentReference = DEFAULT_AUDITOR,
    ) -> None:
        super().__init__(name=name)
        self._resolver = resolver
        self._credentials = credentials
        self._writer = writer
        self._auditor = auditor

    async def edit(self, messages: list[Message]) -> AgentResponse:
        specialists = [
            await self._resolver.resolve(self._writer),
            await self._resolver.resolve(self._auditor),
        ]
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
            role: Literal["user", "assistant"] = (
                "user" if message.role == "user" else "assistant"
            )
            context.append({"role": role, "content": message.text})
        outputs: list[str] = []
        for index, specialist in enumerate(specialists):
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
                base_url=specialist.responses_base_url,
                api_key=self._credentials,
                max_retries=0,
                timeout=600.0,
                http_client=DefaultAsyncHttpxClient(trust_env=False),
            ) as client:
                headers: dict[str, str] = {}
                inject(headers)
                result = await client.responses.create(
                    input=context, store=False, extra_headers=headers
                )
            if result.status != "completed" or any(
                item.type
                in ("function_call", "custom_tool_call", "computer_call", "mcp_approval_request")
                for item in result.output
            ):
                raise ValueError(f"{specialist.name} did not complete foreground execution")
            if not result.output_text.strip():
                raise ValueError(f"{specialist.name} returned no editing result")
            outputs.append(f"## {specialist.name}\n\n{result.output_text}")
            context.append({"role": "assistant", "content": result.output_text})
        return AgentResponse(messages=[Message("assistant", ["\n\n".join(outputs)])])

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
        return self.edit(context)

    async def updates(self, messages: list[Message]) -> AsyncIterator[AgentResponseUpdate]:
        result = await self.edit(messages)
        for message in result.messages:
            yield AgentResponseUpdate(
                contents=message.contents,
                role=message.role,
                response_id=result.response_id,
                finish_reason="stop",
            )
