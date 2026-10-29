FROM ghcr.io/astral-sh/uv:0.5.11-python3.12-bookworm-slim AS builder
WORKDIR /workspace
COPY services/governance-sidecar ./services/governance-sidecar
WORKDIR /workspace/services/governance-sidecar
RUN uv sync --frozen --no-dev --no-editable

FROM python:3.12-slim
ENV PATH="/app/.venv/bin:$PATH" PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1
WORKDIR /app
COPY --from=builder /workspace/services/governance-sidecar/.venv /app/.venv
USER 10001:10001
CMD ["python", "-m", "governance_sidecar.main"]
