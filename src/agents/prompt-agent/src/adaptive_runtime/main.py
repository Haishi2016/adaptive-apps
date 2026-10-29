"""Run the portable prompt agent with the selected Responses host adapter."""

from __future__ import annotations

import os

host_adapter = os.environ.get("AGENT_HOST_ADAPTER", "foundry-compatible")
if host_adapter == "foundry-compatible":
    from adaptive_runtime.hosts.foundry import agent, app, gateway_token, settings
elif host_adapter == "kubernetes":
    from adaptive_runtime.hosts.kubernetes import agent, app, gateway_token, settings
else:
    raise RuntimeError(f"Unsupported agent host adapter: {host_adapter}")

__all__ = ["agent", "app", "gateway_token", "settings"]


def main() -> None:
    app.run(port=int(os.environ.get("PORT", "8080")))


if __name__ == "__main__":
    main()
