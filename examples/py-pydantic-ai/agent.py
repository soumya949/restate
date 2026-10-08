"""Restate + Pydantic AI agent governed by OpenBox.

Based on restatedev/ai-examples ``pydantic-ai/template``. OpenBox changes are marked ``# OPENBOX``:
  1. ``RestateAgent(agent)`` is replaced by ``OpenBoxRestateAgent(agent)`` (same durability + governance)
  2. the handler is decorated with ``@openbox_handler``
  3. ``enable_openbox_spans()`` (in __main__.py) reports tool and LLM HTTP calls as spans
"""

from __future__ import annotations

import os

import httpx
import restate
from pydantic import BaseModel
from pydantic_ai import Agent
from restate.ext.pydantic import restate_context

from openbox_restate import openbox_handler  # OPENBOX
from openbox_restate.pydantic_ai import OpenBoxRestateAgent  # OPENBOX


class WeatherPrompt(BaseModel):
    message: str = "What is the weather in San Francisco?"


# TOOLS — one per sandbox policy; each journals its side effect with run_typed.
# get_weather and send_email make real HTTP calls, so they show up as spans.
async def get_weather(city: str) -> dict:
    """Get the current weather for a given city."""

    async def call_weather_api() -> dict:
        async with httpx.AsyncClient(timeout=15) as http:
            geo = (
                await http.get("https://geocoding-api.open-meteo.com/v1/search", params={"name": city, "count": 1})
            ).json()
            place = (geo.get("results") or [None])[0]
            if place is None:
                return {"error": f"unknown city {city}"}
            wx = await http.get(
                "https://api.open-meteo.com/v1/forecast",
                params={
                    "latitude": place["latitude"],
                    "longitude": place["longitude"],
                    "current": "temperature_2m,wind_speed_10m",
                },
            )
            return {"city": place["name"], **wx.json().get("current", {})}

    return await restate_context().run_typed(f"Get weather {city}", call_weather_api)


async def send_email(to: str, subject: str, body: str) -> dict:
    """Send an email."""

    async def call_email_api() -> dict:
        # Stand-in for a real email API: the POST shows up as an http_request span.
        async with httpx.AsyncClient(timeout=15) as http:
            r = await http.post("https://httpbin.org/post", json={"to": to, "subject": subject, "body": body})
            return {"sent": r.is_success, "to": to}

    return await restate_context().run_typed("Send email", call_email_api)


async def delete_records(table: str) -> dict:
    """Delete records from a database table."""

    async def delete() -> dict:
        return {"deleted": 42, "table": table}

    return await restate_context().run_typed("Delete records", delete)


async def wire_money(account: str, amount: float) -> dict:
    """Wire money to an account."""

    async def wire() -> dict:
        return {"wired": amount, "account": account}

    return await restate_context().run_typed("Wire money", wire)


# <start_here>
# AGENT
assistant = Agent(
    "openai:" + os.environ.get("OPENAI_MODEL", "gpt-5.4"),
    system_prompt="You are a helpful assistant. Use the tools when asked.",
)
for _tool in (get_weather, send_email, delete_records, wire_money):
    assistant.tool_plain(_tool)

# AGENT SERVICE
restate_agent = OpenBoxRestateAgent(assistant)  # OPENBOX: was RestateAgent(assistant)
agent_service = restate.Service("agent")


@agent_service.handler()
@openbox_handler(agent_name="pydantic-ai-agent", prompt_from=lambda r: r.message)  # OPENBOX
async def run(_ctx: restate.Context, req: WeatherPrompt) -> str:
    result = await restate_agent.run(req.message)
    return str(result.output)
# <end_here>
