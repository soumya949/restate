import asyncio

import hypercorn
import hypercorn.asyncio
import restate

from agent import agent_service

from openbox_restate.instrumentation import enable_openbox_spans  # OPENBOX

if __name__ == "__main__":
    enable_openbox_spans()  # OPENBOX: before serving
    app = restate.app(services=[agent_service])
    conf = hypercorn.Config()
    conf.bind = ["0.0.0.0:9080"]
    asyncio.run(hypercorn.asyncio.serve(app, conf))  # type: ignore[arg-type]
