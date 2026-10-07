"""Restate + Google ADK agent governed by OpenBox.

Based on restatedev/ai-examples ``google-adk/template``. OpenBox changes are marked ``# OPENBOX``:
  1. ``RestatePlugin()`` is replaced by ``OpenBoxRestatePlugin()`` (same durability + governance)
  2. the handler is decorated with ``@openbox_handler``
  3. ``enable_openbox_spans()`` (in __main__.py) reports tool and LLM HTTP calls as spans
The template uses Gemini; this example uses OpenAI through ADK's LiteLLM adapter (OPENAI_API_KEY).
"""

from __future__ import annotations

import os

import httpx
import restate
from google.adk import Runner
from google.adk.agents.llm_agent import Agent
from google.adk.apps import App
from google.adk.models.lite_llm import LiteLlm
from google.adk.sessions import InMemorySessionService
from google.genai.types import Content, Part
from pydantic import BaseModel
from restate.ext.adk import restate_context

from openbox_restate import openbox_handler  # OPENBOX
from openbox_restate.adk import OpenBoxRestatePlugin  # OPENBOX


class WeatherPrompt(BaseModel):
    user_id: str = "user-123"
    message: str = "What is the weather like in San Francisco?"


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
agent = Agent(
    model=LiteLlm(model="openai/" + os.environ.get("OPENAI_MODEL", "gpt-5.4")),
    name="assistant",
    instruction="You are a helpful assistant. Use the tools when asked.",
    tools=[get_weather, send_email, delete_records, wire_money],
)

APP_NAME = "agents"
app = App(name=APP_NAME, root_agent=agent, plugins=[OpenBoxRestatePlugin()])  # OPENBOX: was RestatePlugin()
session_service = InMemorySessionService()

# AGENT SERVICE + HANDLER
agent_service = restate.Service("agent")


@agent_service.handler()
@openbox_handler(agent_name="google-adk-agent", prompt_from=lambda r: r.message)  # OPENBOX
async def run(ctx: restate.Context, req: WeatherPrompt) -> str | None:
    session_id = str(ctx.uuid())
    session = await session_service.get_session(app_name=APP_NAME, user_id=req.user_id, session_id=session_id)
    if not session:
        await session_service.create_session(app_name=APP_NAME, user_id=req.user_id, session_id=session_id)

    runner = Runner(app=app, session_service=session_service)
    events = runner.run_async(
        user_id=req.user_id,
        session_id=session_id,
        new_message=Content(role="user", parts=[Part.from_text(text=req.message)]),
    )
    final_response = None
    async for event in events:
        if event.is_final_response() and event.content and event.content.parts:
            if event.content.parts[0].text:
                final_response = event.content.parts[0].text
    return final_response
# <end_here>
