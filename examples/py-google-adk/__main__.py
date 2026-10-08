import asyncio
import os

import hypercorn
import hypercorn.asyncio
import restate

from agent import agent_service

from openbox_restate.instrumentation import enable_openbox_spans  # OPENBOX

if __name__ == "__main__":
    enable_openbox_spans()  # OPENBOX: before serving
    # Restate Cloud: accept only requests signed by your environment (comma-separated publickeyv1_… keys).
    identity_keys = [k for k in os.environ.get("RESTATE_IDENTITY_KEYS", "").split(",") if k]
    app = restate.app(services=[agent_service], identity_keys=identity_keys or None)
    conf = hypercorn.Config()
    conf.bind = ["0.0.0.0:9080"]
    asyncio.run(hypercorn.asyncio.serve(app, conf))  # type: ignore[arg-type]
