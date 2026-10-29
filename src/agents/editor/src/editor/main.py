from __future__ import annotations

import os

host_adapter = os.environ.get("AGENT_HOST_ADAPTER", "foundry-compatible")
if host_adapter == "foundry-compatible":
    from editor.hosts.foundry import app
elif host_adapter == "kubernetes":
    from editor.hosts.kubernetes import app
else:
    raise RuntimeError(f"Unsupported agent host adapter: {host_adapter}")


def main() -> None:
    app.run(port=int(os.environ.get("PORT", "8088")))


if __name__ == "__main__":
    main()
