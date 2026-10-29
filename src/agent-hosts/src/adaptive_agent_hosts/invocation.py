from __future__ import annotations

from collections.abc import Mapping

from adaptive_agent_contracts import (
    AgentIdentity,
    AgentInvocationContext,
    CallerIdentity,
    DelegatedCredential,
    TokenProvider,
    TraceContext,
    WorkloadIdentity,
    bind_invocation,
)
from starlette.types import ASGIApp, Receive, Scope, Send

_TRUSTED_IDENTITY_HEADERS = {
    b"x-client-identity-mode",
    b"x-client-microsoft-graph-access-token",
    b"x-client-graph-user-id",
}
_STRIPPED_CREDENTIAL_HEADERS = _TRUSTED_IDENTITY_HEADERS | {
    b"authorization",
    b"x-entra-user-token",
}


class GatewayInvocationMiddleware:
    def __init__(
        self,
        app: ASGIApp,
        *,
        agent_identity: AgentIdentity,
        workload_identity: WorkloadIdentity | None = None,
        agent_credentials: Mapping[str, TokenProvider] | None = None,
        caller_issuer: str = "urn:adaptive:gateway",
    ) -> None:
        self.app = app
        self.agent_identity = agent_identity
        self.workload_identity = workload_identity
        self.agent_credentials = dict(agent_credentials or {})
        self.caller_issuer = caller_issuer

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        headers = self._headers(scope)
        identity_mode = headers.get("x-client-identity-mode", "app")
        if identity_mode not in {"app", "endUserOBO", "agentUser"}:
            await self._reject(send, "Unsupported caller identity mode")
            return

        graph_subject = headers.get("x-client-graph-user-id")
        graph_token = headers.get("x-client-microsoft-graph-access-token")
        delegated_credentials: dict[str, DelegatedCredential] = {}
        if graph_subject and graph_token:
            delegated_credentials["microsoft-graph"] = DelegatedCredential(
                audience="https://graph.microsoft.com",
                subject=graph_subject,
                access_token=graph_token,
            )

        caller = CallerIdentity(
            subject=graph_subject or identity_mode,
            issuer=self.caller_issuer,
            claims={"identity_mode": identity_mode},
        )
        invocation = AgentInvocationContext(
            agent_identity=self.agent_identity,
            workload_identity=self.workload_identity,
            caller_identity=caller,
            agent_credentials=self.agent_credentials,
            delegated_credentials=delegated_credentials,
            trace_context=TraceContext(
                traceparent=headers.get("traceparent"),
                tracestate=headers.get("tracestate"),
                baggage=headers.get("baggage"),
            ),
        )
        child_scope = dict(scope)
        child_scope["headers"] = [
            (key, value)
            for key, value in scope["headers"]
            if key.lower() not in _STRIPPED_CREDENTIAL_HEADERS
        ]
        with bind_invocation(invocation):
            await self.app(child_scope, receive, send)

    @staticmethod
    def _headers(scope: Scope) -> dict[str, str]:
        headers: dict[str, str] = {}
        for raw_name, raw_value in scope["headers"]:
            name = raw_name.decode("latin-1").lower()
            if name in headers and raw_name.lower() in _TRUSTED_IDENTITY_HEADERS:
                raise ValueError(f"Duplicate trusted request header: {name}")
            headers[name] = raw_value.decode("latin-1")
        return headers

    @staticmethod
    async def _reject(send: Send, message: str) -> None:
        body = message.encode("utf-8")
        await send(
            {
                "type": "http.response.start",
                "status": 400,
                "headers": [
                    (b"content-type", b"text/plain; charset=utf-8"),
                    (b"content-length", str(len(body)).encode("ascii")),
                ],
            }
        )
        await send({"type": "http.response.body", "body": body})
