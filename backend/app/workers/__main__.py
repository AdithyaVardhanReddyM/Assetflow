"""Standalone worker process: `uv run python -m app.workers`.

The same Supervisor the API embeds in development, so there is no separate code
path to keep in sync — only a different place to run it.
"""

from __future__ import annotations

import asyncio
import contextlib
import signal

from app.config import get_settings
from app.db.session import dispose_engine
from app.logging import configure_logging, get_logger
from app.workers.supervisor import Supervisor

log = get_logger(__name__)


async def main() -> None:
    settings = get_settings()
    configure_logging(level=settings.log_level, json_output=settings.is_production)

    if not settings.db_configured:
        raise SystemExit("DATABASE_URL is not set — the worker has no queue to read.")

    supervisor = Supervisor()
    await supervisor.start()

    stop = asyncio.Event()
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGINT, signal.SIGTERM):
        with contextlib.suppress(NotImplementedError):
            loop.add_signal_handler(sig, stop.set)

    await stop.wait()
    log.info("worker.shutdown_requested")
    await supervisor.stop()
    await dispose_engine()


if __name__ == "__main__":
    with contextlib.suppress(KeyboardInterrupt):
        asyncio.run(main())
