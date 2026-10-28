FROM ghcr.io/astral-sh/uv:0.5.11-python3.12-bookworm-slim AS builder

ENV UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy

WORKDIR /workspace
COPY agents/prompt-agent/pyproject.toml agents/prompt-agent/uv.lock agents/prompt-agent/README.md ./agents/prompt-agent/
COPY agents/prompt-agent/src ./agents/prompt-agent/src

WORKDIR /workspace/agents/prompt-agent
RUN uv sync --frozen --no-dev --no-editable

FROM python:3.12-slim AS runtime

ENV PATH="/app/.venv/bin:$PATH" \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1
WORKDIR /app

RUN useradd --create-home --uid 10001 appuser
COPY --from=builder /workspace/agents/prompt-agent/.venv /app/.venv
# NOTE: Foundry cloud's hosted-agent runtime requires the container to run
# as root — it injects observability/identity sidecar files into /app at
# startup and writes the workload-identity token via mount. A non-root
# user causes `ProvisioningError` (https://aka.ms/hostedagents/tsg/provisioning).
# The runtime image is structurally a hosted agent (ResponsesAgentServerHost,
# SPEC §9.4) so it follows the same convention as the samples even though on
# the edge today the Agent Operator does not require a non-root user.

# In-container default bind port is 8088 (azure.ai.agentserver core default).
# On the edge the Agent Operator injects PORT=8080 so the same image binds 8080.
EXPOSE 8088 8080

CMD ["python", "-m", "adaptive_runtime.main"]
