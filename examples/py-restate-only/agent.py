"""Restate durable agent (no framework) governed by OpenBox.

Based on restatedev/ai-examples ``python-restate-only/template``. OpenBox changes are marked ``# OPENBOX``:
  1. the handler is decorated with ``@openbox_handler``
  2. each tool call goes through ``governed_call`` (policy check → maybe wait for
     human approval → run → report); a blocked call is fed back to the LLM as
     the tool result instead of crashing the agent.
  3. ``enable_openbox_spans()`` (in __main__.py) reports the HTTP calls each
     tool makes as spans of that tool's activity (each span gets a verdict).
"""

from __future__ import annotations

import json
import os
from typing import Any

import httpx
import restate
from litellm import acompletion
from litellm.types.utils import Message
from pydantic import BaseModel

from openbox_restate import governed_call, is_blocked, openbox_handler, report_llm_call  # OPENBOX


class LlmResult(BaseModel):
    """The journaled LLM step: the message plus what OpenBox's Model Usage needs."""

    message: Message
    model: str | None = None
    input_tokens: int | None = None
    output_tokens: int | None = None


class Prompt(BaseModel):
    message: str = "What is the weather in San Francisco?"


# TOOL IMPLEMENTATIONS — one per sandbox policy (architecture §22.1); each journals its side effect
async def get_weather(city: str) -> str:
    async with httpx.AsyncClient(timeout=15) as http:
        geo = (await http.get("https://geocoding-api.open-meteo.com/v1/search", params={"name": city, "count": 1})).json()
        place = (geo.get("results") or [None])[0]
        if place is None:
            return json.dumps({"error": f"unknown city {city}"})
        wx = await http.get(
            "https://api.open-meteo.com/v1/forecast",
            params={
                "latitude": place["latitude"],
                "longitude": place["longitude"],
                "current": "temperature_2m,wind_speed_10m",
            },
        )
        return json.dumps({"city": place["name"], **wx.json().get("current", {})})


async def send_email(to: str, subject: str = "", body: str = "") -> str:
    # Stand-in for a real email API: the POST shows up as an http_request span.
    async with httpx.AsyncClient(timeout=15) as http:
        r = await http.post("https://httpbin.org/post", json={"to": to, "subject": subject, "body": body})
        return json.dumps({"sent": r.is_success, "to": to})


async def delete_records(table: str) -> str:
    return json.dumps({"deleted": 42, "table": table})


async def wire_money(account: str, amount: float) -> str:
    return json.dumps({"wired": amount, "account": account})


IMPLS = {"get_weather": get_weather, "send_email": send_email, "delete_records": delete_records, "wire_money": wire_money}


def _fn(name: str, description: str, props: dict[str, Any], required: list[str]) -> dict[str, Any]:
    return {
        "type": "function",
        "function": {
            "name": name,
            "description": description,
            "parameters": {"type": "object", "properties": props, "required": required},
        },
    }


TOOLS = [
    _fn("get_weather", "Get the current weather for a city", {"city": {"type": "string"}}, ["city"]),
    _fn(
        "send_email",
        "Send an email",
        {"to": {"type": "string"}, "subject": {"type": "string"}, "body": {"type": "string"}},
        ["to"],
    ),
    _fn("delete_records", "Delete records from a database table", {"table": {"type": "string"}}, ["table"]),
    _fn("wire_money", "Wire money to an account", {"account": {"type": "string"}, "amount": {"type": "number"}}, ["account", "amount"]),
]

# <start_here>
agent_service = restate.Service("agent")


@agent_service.handler()
@openbox_handler(agent_name="py-restate-only-agent", prompt_from=lambda p: p.message)  # OPENBOX
async def run(ctx: restate.Context, prompt: Prompt) -> str | None:
    """Handle a user message, calling tools until a final answer is ready."""
    messages: list[dict[str, Any]] = [
        {"role": "system", "content": "You are a helpful assistant. Use the tools when asked."},
        {"role": "user", "content": prompt.message},
    ]

    while True:

        async def call_llm() -> LlmResult:
            resp = await acompletion(model=os.environ.get("OPENAI_MODEL", "gpt-5.4"), messages=messages, tools=TOOLS)
            usage = getattr(resp, "usage", None)
            return LlmResult(
                message=resp.choices[0].message,
                model=resp.model,
                input_tokens=getattr(usage, "prompt_tokens", None),
                output_tokens=getattr(usage, "completion_tokens", None),
            )

        llm = await ctx.run_typed("LLM call", call_llm)
        response = llm.message
        await report_llm_call(  # OPENBOX: feeds Model Usage / LLM Calls
            ctx,
            model=llm.model,
            prompt=prompt.message,
            completion=response.content,
            input_tokens=llm.input_tokens,
            output_tokens=llm.output_tokens,
            has_tool_calls=bool(response.tool_calls),
        )
        messages.append(response.model_dump())
        if not response.tool_calls:
            return response.content  # type: ignore[no-any-return]

        # Tool calls are governed one at a time, in the order the model emitted them.
        for tool_call in response.tool_calls:
            name = tool_call.function.name or ""
            args = json.loads(tool_call.function.arguments or "{}")
            impl = IMPLS.get(name)

            async def run_tool(a: dict[str, Any], impl: Any = impl, name: str = name) -> str:
                if impl is None:
                    return f"Tool not found: {name}"
                return await ctx.run_typed(f"{name}", impl, **a)

            result = await governed_call(  # OPENBOX
                ctx, tool_name=name, tool_call_id=tool_call.id, arguments=args, run=run_tool
            )
            content = str(result) if is_blocked(result) else result
            messages.append({"role": "tool", "tool_call_id": tool_call.id, "content": content})
# <end_here>
