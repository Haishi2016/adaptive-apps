from __future__ import annotations

import time
from collections.abc import Awaitable, Mapping
from json import JSONDecodeError
from typing import Any, Literal, Protocol
from uuid import uuid4

import uvicorn
from agent_framework import AgentResponse, AgentRunInputs, Message
from starlette.applications import Starlette
from starlette.exceptions import HTTPException
from starlette.requests import Request
from starlette.responses import JSONResponse, Response
from starlette.routing import Route


class ForegroundAgent(Protocol):
    def run(
        self,
        messages: AgentRunInputs | None = None,
        *,
        stream: Literal[False] = False,
    ) -> Awaitable[AgentResponse[Any]]: ...


class KubernetesResponsesHost(Starlette):
    def __init__(self, agent: ForegroundAgent, *, agent_name: str) -> None:
        self.agent = agent
        self.agent_name = agent_name
        super().__init__(
            routes=[
                Route("/readiness", self.readiness, methods=["GET"], name="readiness"),
                Route("/responses", self.create_response, methods=["POST"]),
                Route(
                    "/agents/{agent_name:str}/responses",
                    self.create_response,
                    methods=["POST"],
                    name="create_response",
                ),
            ],
            exception_handlers={HTTPException: self._http_exception},
        )

    async def _http_exception(self, request: Request, exc: Exception) -> Response:
        if not isinstance(exc, HTTPException):
            raise exc
        return JSONResponse(
            {
                "error": {
                    "message": str(exc.detail),
                    "type": "invalid_request_error",
                }
            },
            status_code=exc.status_code,
        )

    async def readiness(self, request: Request) -> Response:
        return JSONResponse({"status": "ready"})

    async def create_response(self, request: Request) -> Response:
        route_name = request.path_params.get("agent_name")
        if route_name is not None and route_name != self.agent_name:
            raise HTTPException(status_code=404, detail="Agent not found")
        try:
            payload = await request.json()
        except JSONDecodeError:
            raise HTTPException(status_code=400, detail="Request body must be valid JSON") from None
        if not isinstance(payload, dict):
            raise HTTPException(status_code=400, detail="Request body must be an object")
        unsupported = sorted(
            set(payload) - {"input", "store", "background", "stream"}
        )
        if unsupported:
            raise HTTPException(
                status_code=400,
                detail=f"Unsupported Responses fields: {', '.join(unsupported)}",
            )
        if payload.get("store") is True:
            raise HTTPException(
                status_code=501,
                detail="Stored responses are not available in this hosting environment",
            )
        if payload.get("background") is True:
            raise HTTPException(
                status_code=501,
                detail="Background execution is not available in this hosting environment",
            )
        if payload.get("stream") is True:
            raise HTTPException(
                status_code=501,
                detail="Streaming is not available in this hosting environment",
            )
        if "input" not in payload:
            raise HTTPException(status_code=400, detail="Responses input is required")

        messages = self._messages(payload["input"])
        result = await self.agent.run(messages, stream=False)
        response_id = result.response_id or f"resp_{uuid4().hex}"
        output = []
        for message in result.messages:
            if message.role != "assistant":
                raise RuntimeError("Portable agent returned a non-assistant response message")
            text = message.text
            if not text:
                continue
            output.append(
                {
                    "id": message.message_id or f"msg_{uuid4().hex}",
                    "type": "message",
                    "role": message.role,
                    "status": "completed",
                    "content": [
                        {
                            "type": "output_text",
                            "text": text,
                            "annotations": [],
                        }
                    ],
                }
            )
        if not output:
            raise RuntimeError("Portable agent returned no text response")
        return JSONResponse(
            {
                "id": response_id,
                "object": "response",
                "created_at": int(time.time()),
                "status": "completed",
                "output": output,
            },
            headers={"x-platform-server": "adaptive-kubernetes-responses/0.1.0"},
        )

    @classmethod
    def _messages(cls, value: object) -> list[Message]:
        if isinstance(value, str):
            if not value.strip():
                raise HTTPException(status_code=400, detail="Responses input cannot be empty")
            return [Message("user", [value])]
        if not isinstance(value, list) or not value:
            raise HTTPException(
                status_code=400,
                detail="Responses input must be text or a non-empty message list",
            )
        return [cls._message(item) for item in value]

    @staticmethod
    def _message(value: object) -> Message:
        if not isinstance(value, Mapping):
            raise HTTPException(status_code=400, detail="Input item must be an object")
        unsupported = set(value) - {"type", "role", "content"}
        if unsupported or value.get("type", "message") != "message":
            raise HTTPException(status_code=400, detail="Unsupported input item")
        role = value.get("role")
        if role not in {"user", "assistant", "system", "developer"}:
            raise HTTPException(status_code=400, detail="Unsupported input role")
        content = value.get("content")
        if isinstance(content, str):
            if not content.strip():
                raise HTTPException(status_code=400, detail="Input content cannot be empty")
            return Message(role, [content])
        if not isinstance(content, list) or not content:
            raise HTTPException(status_code=400, detail="Input content must contain text")
        text: list[str] = []
        for part in content:
            if (
                not isinstance(part, Mapping)
                or part.get("type") not in {"input_text", "output_text"}
                or not isinstance(part.get("text"), str)
                or not str(part["text"]).strip()
            ):
                raise HTTPException(status_code=400, detail="Unsupported input content")
            text.append(str(part["text"]))
        return Message(role, text)

    def run(self, *, port: int) -> None:
        uvicorn.run(self, host="0.0.0.0", port=port)
