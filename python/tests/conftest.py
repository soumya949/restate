"""Session fixture: serve tests/app.py with hypercorn and register it with the Restate server
started by docker-compose.test.yml (which forces a replay after every suspension)."""

from __future__ import annotations

import asyncio
import os
from collections.abc import AsyncIterator
from typing import Any

import httpx
import pytest
import pytest_asyncio

INGRESS = os.environ.get("RESTATE_INGRESS_URL", "http://localhost:8080")
ADMIN = os.environ.get("RESTATE_ADMIN_URL", "http://localhost:9070")


def _service_url() -> str:
    """URL Restate uses to reach this test process (container IP: `compose run` gets no DNS alias)."""
    if "SERVICE_URL" in os.environ:
        return os.environ["SERVICE_URL"]
    import socket

    return f"http://{socket.gethostbyname(socket.gethostname())}:9080"


SERVICE_URL = _service_url()

requires_restate = pytest.mark.skipif(
    "RESTATE_INGRESS_URL" not in os.environ, reason="run via docker-compose.test.yml (needs a Restate server)"
)


@pytest_asyncio.fixture(scope="session")
async def restate_ingress() -> AsyncIterator[str]:
    if "RESTATE_INGRESS_URL" not in os.environ:
        pytest.skip("run via docker-compose.test.yml (needs a Restate server)")
    import hypercorn.asyncio
    from hypercorn.config import Config

    from .app import API_PORT, app, downstream_api

    config = Config()
    config.bind = ["0.0.0.0:9080"]
    config.loglevel = "warning"
    stop = asyncio.Event()
    server = asyncio.create_task(hypercorn.asyncio.serve(app, config, shutdown_trigger=stop.wait))  # type: ignore[arg-type]
    api_config = Config()
    api_config.bind = [f"127.0.0.1:{API_PORT}"]
    api_config.loglevel = "warning"
    api_server = asyncio.create_task(hypercorn.asyncio.serve(downstream_api, api_config, shutdown_trigger=stop.wait))  # type: ignore[arg-type]

    deadline = asyncio.get_running_loop().time() + 90
    last = ""
    async with httpx.AsyncClient(timeout=15) as http:
        while True:  # Restate server + our endpoint both need to be up
            try:
                r = await http.post(f"{ADMIN}/deployments", json={"uri": SERVICE_URL, "force": True})
                if r.status_code < 300:
                    break
                last = f"HTTP {r.status_code}: {r.text[:300]}"
            except httpx.HTTPError as e:
                last = repr(e)
            if asyncio.get_running_loop().time() > deadline:
                stop.set()
                raise RuntimeError(f"could not register {SERVICE_URL} with Restate: {last}")
            await asyncio.sleep(1)
    yield INGRESS
    stop.set()
    await server
    await api_server


@pytest_asyncio.fixture
async def call(restate_ingress: str) -> Any:
    from .app import api_hits, core, counters
    from .p2_app import agent_core, child_core, parent_core, ran

    core.reset()
    counters["tool"] = 0
    api_hits["n"] = 0
    from .p4_app import CORES
    from .p4_app import ran as p4_ran

    for c in (agent_core, parent_core, child_core, *CORES.values()):
        c.reset()
    ran.clear()
    p4_ran.clear()
    async with httpx.AsyncClient(timeout=60) as http:

        async def _call(handler: str, body: Any = None) -> httpx.Response:
            service, _, name = handler.rpartition("/")
            return await http.post(f"{restate_ingress}/{service or 'agent'}/{name}", json=body)

        yield _call
