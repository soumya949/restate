"""Restate + OpenAI Agents SDK agent governed by OpenBox.

Based on restatedev/ai-examples ``openai-agents/template``. OpenBox changes are marked ``# OPENBOX``:
  1. the handler is decorated with ``@openbox_handler``
  2. the agent passed to ``DurableRunner.run`` goes through ``govern_agent(...)``
  3. ``enable_openbox_spans()`` (in __main__.py) reports each tool's HTTP calls as spans
"""

from __future__ import annotations

import httpx
import restate
from agents import Agent
from pydantic import BaseModel
from restate.ext.openai import DurableRunner, durable_function_tool, restate_context

from openbox_restate import openbox_handler  # OPENBOX
from openbox_restate.openai import govern_agent  # OPENBOX


class Prompt(BaseModel):
    message: str = "What is the weather in San Francisco?"


# TOOLS — one per sandbox policy; each journals its side effect with run_typed
@durable_function_tool
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


@durable_function_tool
async def send_email(to: str, subject: str, body: str) -> dict:
    """Send an email."""

    async def call_email_api() -> dict:
        # Stand-in for a real email API: the POST shows up as an http_request span.
        async with httpx.AsyncClient(timeout=15) as http:
            r = await http.post("https://httpbin.org/post", json={"to": to, "subject": subject, "body": body})
            return {"sent": r.is_success, "to": to}

    return await restate_context().run_typed("Send email", call_email_api)


@durable_function_tool
async def delete_records(table: str) -> dict:
    """Delete records from a database table."""

    async def delete() -> dict:
        return {"deleted": 42, "table": table}

    return await restate_context().run_typed("Delete records", delete)


@durable_function_tool
async def wire_money(account: str, amount: float) -> dict:
    """Wire money to an account."""

    async def wire() -> dict:
        return {"wired": amount, "account": account}

    return await restate_context().run_typed("Wire money", wire)


# AGENT
assistant = Agent(
    name="Assistant",
    instructions="You are a helpful assistant. Use the tools when asked.",
    tools=[get_weather, send_email, delete_records, wire_money],
)


# AGENT SERVICE
agent_service = restate.Service("agent")


@agent_service.handler()
@openbox_handler(agent_name="openai-agents-agent", prompt_from=lambda p: p.message)  # OPENBOX
async def run(_ctx: restate.Context, req: Prompt) -> str:
    # Runner that persists the agent execution for recoverability
    result = await DurableRunner.run(govern_agent(assistant), req.message)  # OPENBOX: govern_agent(...)
    return str(result.final_output)
