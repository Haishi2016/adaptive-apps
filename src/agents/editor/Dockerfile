FROM ghcr.io/astral-sh/uv:0.5.29-python3.12-bookworm-slim AS builder
ENV UV_COMPILE_BYTECODE=1 UV_LINK_MODE=copy
WORKDIR /workspace
COPY agent-contracts ./agent-contracts
COPY agent-hosts ./agent-hosts
COPY agents/editor/pyproject.toml agents/editor/uv.lock agents/editor/README.md ./agents/editor/
COPY agents/editor/src ./agents/editor/src
WORKDIR /workspace/agents/editor
RUN uv sync --frozen --no-dev --no-editable

FROM python:3.12-slim
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PATH="/app/.venv/bin:${PATH}"
WORKDIR /app
COPY --from=builder /workspace/agents/editor/.venv /app/.venv
EXPOSE 8088 8080
CMD ["python", "-m", "editor.main"]
