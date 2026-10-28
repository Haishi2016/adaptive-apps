from __future__ import annotations

import asyncio
import json
import logging
import os
from collections.abc import AsyncIterator, Mapping
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any
from urllib.parse import parse_qsl

import httpx
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse, Response, StreamingResponse
from starlette.background import BackgroundTask

from governance_sidecar.contracts import Mode, ProxyConfig, Stage
from governance_sidecar.policy import Policies
from governance_sidecar.telemetry import GuardrailTelemetry

logger = logging.getLogger(__name__)
MAX_BODY = 8 * 1024 * 1024
MODEL_OPERATIONS = {
    "responses",
    "chat/completions",
    "completions",
    "embeddings",
    "images/generations",
}
MCP_CONTROL = {
    "initialize",
    "ping",
    "tools/list",
    "notifications/initialized",
    "notifications/cancelled",
    "notifications/progress",
}
HOP_HEADERS = {
    "connection",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
    "host",
    # Each request's credentials belong only to its configured upstream.
    "cookie",
    "set-cookie",
    "x-http-method-override",
    "x-method-override",
    "x-http-method",
}


def _headers(headers: Mapping[str, str]) -> dict[str, str]:
    excluded = HOP_HEADERS | {
        name.strip().lower() for name in headers.get("connection", "").split(",")
    }
    return {key: value for key, value in headers.items() if key.lower() not in excluded}


async def _body(request: Request) -> bytes:
    body = bytearray()
    async for chunk in request.stream():
        body.extend(chunk)
        if len(body) > MAX_BODY:
            raise HTTPException(413, "Outbound request exceeds 8 MiB")
    return bytes(body)


def _parse_json(body: bytes) -> Any:
    def pairs(items: list[tuple[str, Any]]) -> dict[str, Any]:
        result = {}
        for key, value in items:
            if key in result:
                raise ValueError("Duplicate JSON field")
            result[key] = value
        return result

    def constant(value: str) -> None:
        raise ValueError("Non-finite JSON number")

    try:
        return json.loads(body, object_pairs_hook=pairs, parse_constant=constant)
    except (ValueError, RecursionError) as exc:
        raise HTTPException(400, "Expected unambiguous JSON") from exc


def _json(body: bytes) -> dict[str, Any]:
    result = _parse_json(body)
    if not isinstance(result, dict):
        raise HTTPException(400, "JSON arrays/batches are not supported")
    return result


def _content_text(value: object) -> str:
    pending = [value]
    parts = []
    while pending:
        item = pending.pop()
        if isinstance(item, dict):
            pending.extend(reversed(list(item.values())))
            pending.extend(reversed(list(item.keys())))
        elif isinstance(item, (list, tuple)):
            pending.extend(reversed(item))
        elif item is not None:
            parts.append(str(item))
    return "\n".join(parts)


def _http_content(request: Request, body: bytes) -> object:
    try:
        query = parse_qsl(request.scope["query_string"].decode("ascii"), errors="strict")
    except UnicodeError as exc:
        raise HTTPException(400, "Content checks require UTF-8 query parameters") from exc
    if not body:
        return query
    if request.headers.get("content-encoding", "identity").lower() != "identity":
        raise HTTPException(415, "Content checks require an uncompressed request")
    media_type = request.headers.get("content-type", "").split(";", 1)[0].strip().lower()
    if media_type == "application/json" or media_type.endswith("+json"):
        return [query, _parse_json(body)]
    if media_type in ("text/plain", "application/x-www-form-urlencoded"):
        try:
            text = body.decode("utf-8")
            return [
                query,
                parse_qsl(text, errors="strict")
                if media_type.endswith("form-urlencoded")
                else text,
            ]
        except UnicodeError as exc:
            raise HTTPException(400, "Content checks require UTF-8 text") from exc
    raise HTTPException(415, "Content checks support JSON, UTF-8 text and form requests")


def create_app(path: Path, digest: str, agent_id: str, mode: Mode) -> FastAPI:
    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        raw = await asyncio.to_thread(path.read_bytes)
        if len(raw) > 96_000:
            raise ValueError("Proxy configuration exceeds 96 KB")
        config = ProxyConfig.model_validate_json(raw)
        if config.digest() != digest or not agent_id:
            raise ValueError("Proxy configuration digest or workload binding is invalid")
        app.state.config = config
        app.state.policies = Policies(config.bundle, digest, agent_id, mode)
        telemetry = GuardrailTelemetry(agent_id, digest, mode)
        app.state.telemetry = telemetry
        async with httpx.AsyncClient(
            timeout=httpx.Timeout(120, connect=10),
            trust_env=False,
            follow_redirects=False,
        ) as client:
            app.state.client = client
            app.state.ready = True
            try:
                yield
            finally:
                app.state.ready = False
                await asyncio.to_thread(telemetry.shutdown)

    app = FastAPI(
        lifespan=lifespan, docs_url=None, redoc_url=None, openapi_url=None, redirect_slashes=False
    )

    @app.exception_handler(HTTPException)
    async def error(request: Request, exc: HTTPException) -> JSONResponse:
        logger.warning("Outbound proxy rejected request: status=%d", exc.status_code)
        return JSONResponse(
            {"error": {"message": exc.detail, "type": "governance_error", "code": exc.status_code}},
            status_code=exc.status_code,
        )

    @app.get("/readyz")
    def ready() -> dict[str, str]:
        if not getattr(app.state, "ready", False):
            raise HTTPException(503, "Proxy configuration is not loaded")
        return {"config_sha256": digest, "agent_id": agent_id}

    async def authorize(
        request: Request,
        stage: Stage,
        action: str,
        resource: str,
        content: object,
        trace_carrier: Mapping[str, str] | None = None,
    ) -> None:
        if not getattr(app.state, "ready", False):
            raise HTTPException(503, "Proxy configuration is not loaded")
        carrier = request.headers if trace_carrier is None else trace_carrier
        try:
            policies: Policies = app.state.policies
            # Keep detector work off the event loop; never truncate inspected text.
            verdict = await asyncio.to_thread(
                policies.evaluate,
                stage,
                action,
                resource,
                _content_text(content) if policies.content_checks[stage] else "",
            )
        except Exception as exc:
            # Never forward after an evaluator failure, including audit mode.
            logger.error("AGT evaluation failed: %s", type(exc).__name__)
            app.state.telemetry.decision(carrier, stage, action, resource, None)
            raise HTTPException(503, "Policy evaluation failed") from exc
        app.state.telemetry.decision(carrier, stage, action, resource, verdict)
        if verdict.decision != "allow" and verdict.mode == "enforce":
            raise HTTPException(403, f"AGT {verdict.decision}")

    async def forward(request: Request, url: str, body: bytes) -> StreamingResponse:
        headers = _headers(request.headers)
        headers.pop("content-length", None)
        headers["accept-encoding"] = "identity"
        target = httpx.URL(url)
        query = request.scope["query_string"]
        if query:
            target = target.copy_with(query=target.query + (b"&" if target.query else b"") + query)
        # Construct directly: do not inherit cookies from another tool's response.
        outgoing = httpx.Request(request.method, target, headers=headers, content=body)
        try:
            upstream = await app.state.client.send(outgoing, stream=True)
        except httpx.HTTPError as exc:
            logger.error("Governed upstream failed: %s", type(exc).__name__)
            raise HTTPException(502, "Governed upstream unavailable") from exc
        if 300 <= upstream.status_code < 400:
            await upstream.aclose()
            raise HTTPException(502, "Upstream redirects are not permitted")

        async def relay() -> AsyncIterator[bytes]:
            try:
                async for chunk in upstream.aiter_raw():
                    yield chunk
            except httpx.HTTPError as exc:
                logger.error("Governed stream failed: %s", type(exc).__name__)
                raise
            finally:
                await upstream.aclose()

        return StreamingResponse(
            relay(),
            status_code=upstream.status_code,
            headers=_headers(upstream.headers),
            background=BackgroundTask(upstream.aclose),
        )

    @app.api_route("/v1/{operation:path}", methods=["GET", "POST"])
    @app.api_route("/openai/v1/{operation:path}", methods=["GET", "POST"])
    async def model(request: Request, operation: str) -> StreamingResponse:
        body = await _body(request)
        content: object = None
        if request.method == "GET" and operation == "models":
            action, resource = "list_models", "models"
        elif request.method == "POST" and operation in MODEL_OPERATIONS:
            parsed = _json(body)
            model_name = parsed.get("model")
            if not isinstance(model_name, str) or not model_name or len(model_name) > 200:
                raise HTTPException(400, "A bounded model name is required")
            resource = model_name
            if (
                len(request.headers.getlist("x-ai-eg-model")) > 1
                or request.headers.get("x-ai-eg-model", resource) != resource
            ):
                raise HTTPException(400, "Model header and body must agree")
            action = operation
            content = parsed
        else:
            raise HTTPException(404, "Unsupported model operation")
        await authorize(request, "pre_input", action, resource, content)
        config: ProxyConfig = app.state.config
        base = config.model_base_url.rstrip("/")
        return await forward(request, f"{base}/{operation}", body)

    @app.api_route("/tools/{name}", methods=["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"])
    async def tool(request: Request, name: str) -> Response:
        config: ProxyConfig = app.state.config
        endpoint = config.tools.get(name)
        if endpoint is None:
            raise HTTPException(404, "Unknown tool endpoint")
        body = await _body(request)
        action, resource = request.method, name
        content: object = None
        rpc_id: str | int | None = None
        trace_carrier: dict[str, str] | None = None
        if endpoint.protocol == "mcp":
            if request.method == "POST":
                rpc = _json(body)
                method = rpc.get("method")
                if rpc.get("jsonrpc") != "2.0" or not isinstance(method, str):
                    raise HTTPException(400, "Expected MCP JSON-RPC request")
                if not method.startswith("notifications/"):
                    rpc_id = rpc.get("id")
                    if not isinstance(rpc_id, (str, int)) or isinstance(rpc_id, bool):
                        raise HTTPException(400, "MCP request ID is required")
                if method == "tools/call":
                    params = rpc.get("params")
                    if not isinstance(params, dict):
                        raise HTTPException(400, "MCP tool parameters must be an object")
                    tool_name = params.get("name")
                    if not isinstance(tool_name, str) or not tool_name or len(tool_name) > 128:
                        raise HTTPException(400, "MCP tool name is required")
                    action, resource = "tool", f"{name}/{tool_name}"
                    content = params.get("arguments", {})
                    # Native MCP clients propagate each tool call's context in
                    # _meta; the session transport can run in a separate task.
                    meta = params.get("_meta")
                    if isinstance(meta, dict) and isinstance(meta.get("traceparent"), str):
                        trace_carrier = {
                            key: meta[key]
                            for key in ("traceparent", "tracestate")
                            if isinstance(meta.get(key), str)
                        }
                elif method in MCP_CONTROL:
                    action = method
                else:
                    raise HTTPException(400, "Unsupported MCP method")
            elif request.method not in ("GET", "DELETE"):
                raise HTTPException(405, "Unsupported MCP transport method")
        try:
            if endpoint.protocol == "http" and app.state.policies.content_checks["pre_tool"]:
                content = _http_content(request, body)
            await authorize(request, "pre_tool", action, resource, content, trace_carrier)
        except HTTPException as exc:
            if rpc_id is None:
                raise
            # A transport-level 403 closes native MCP sessions. A JSON-RPC
            # error denies this operation without killing unrelated calls.
            return JSONResponse(
                {
                    "jsonrpc": "2.0",
                    "id": rpc_id,
                    "error": {
                        "code": -32003 if exc.status_code == 403 else -32603,
                        "message": exc.detail,
                    },
                }
            )
        return await forward(request, endpoint.url, body)

    return app


def main() -> None:
    import uvicorn

    logging.basicConfig(level=logging.INFO)
    mode = os.environ["ADAPTIVE_GOVERNANCE_MODE"]
    if mode not in ("enforce", "audit"):
        raise ValueError("Governance mode must be enforce or audit")
    app = create_app(
        Path("/policies/proxy.json"),
        os.environ["ADAPTIVE_GOVERNANCE_SHA256"],
        os.environ["ADAPTIVE_GOVERNANCE_AGENT_ID"],
        "audit" if mode == "audit" else "enforce",
    )
    uvicorn.run(app, host="127.0.0.1", port=8082)


if __name__ == "__main__":
    main()
