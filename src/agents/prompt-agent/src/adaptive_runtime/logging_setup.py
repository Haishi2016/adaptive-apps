from __future__ import annotations

import logging
import sys


def configure_logging() -> None:
    """Configure stdlib logging to stdout in JSON-friendly key=value form.

    The Foundry Responses host (``azure-ai-agentserver-responses``) uses
    stdlib ``logging`` for its own output and emits A365 spans via OTel.
    Standard output is readable through ``kubectl logs`` and the Collector's
    log pipeline.
    """

    root = logging.getLogger()
    if root.handlers:
        return
    logging.basicConfig(
        format="%(asctime)s %(levelname)s %(name)s %(message)s",
        stream=sys.stdout,
        level=logging.INFO,
    )
