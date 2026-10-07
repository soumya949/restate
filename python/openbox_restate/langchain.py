"""``openbox_restate.langchain`` — govern LangChain ``create_agent`` agents on Restate (architecture §22.6).

One diff on top of Restate's ``langchain-python`` template: replace ``RestateMiddleware()`` with
``OpenBoxRestateMiddleware()`` and decorate the handler with ``@openbox_handler``::

    agent = create_agent(model=..., tools=[...], middleware=[OpenBoxRestateMiddleware()])

``OpenBoxRestateMiddleware`` IS a ``RestateMiddleware`` (journaled model calls, turn-ordered
tools), plus:

* **Tools.** Restate's ``awrap_tool_call`` waits for the call's turn, runs the handler, then
  releases the next call; OpenBox passes it a *governed* handler, so pre-check, tool and
  post-check all happen inside that window (deterministic journal order). BLOCK answers with a
  ``ToolMessage`` ``"Blocked by policy: …"``; HALT ends the invocation; REQUIRE_APPROVAL waits
  durably. The tool's HTTP/DB/file calls are spans of its activity.
* **LLM calls.** Each model call is an ``llm_call`` activity (model, tokens) and the provider
  request is its span.

Needs ``openbox-restate-sdk[langchain]``.
"""

from __future__ import annotations

import json
from collections.abc import Awaitable, Callable
from typing import Any

from langchain.agents.middleware.types import ModelRequest, ModelResponse
from langchain_core.messages import AIMessage, HumanMessage, ToolMessage
from langgraph.prebuilt.tool_node import ToolCallRequest
from langgraph.types import Command
from restate import RunOptions
from restate.ext.langchain import RestateMiddleware, restate_context

from .context import require_governance_context
from .governed_run import finish_phase, is_blocked, pre_phase, run_tool
from .llm import governed_llm_call, llm_output

__all__ = ["OpenBoxRestateMiddleware"]

ToolCallResult = ToolMessage | Command[Any]


def _text(content: Any) -> str | None:
    if isinstance(content, str):
        return content or None
    if isinstance(content, list):
        parts = [p.get("text") if isinstance(p, dict) else None for p in content]
        return " ".join(t for t in parts if isinstance(t, str)) or None
    return None


def _describe(response: ModelResponse) -> dict[str, Any]:
    ai = next((m for m in response.result if isinstance(m, AIMessage)), None)
    if ai is None:
        return llm_output()
    usage: dict[str, Any] = dict(ai.usage_metadata or {})
    meta: dict[str, Any] = dict(ai.response_metadata or {})
    return llm_output(
        model=meta.get("model_name") or meta.get("model"),
        completion=_text(ai.content),
        input_tokens=usage.get("input_tokens"),
        output_tokens=usage.get("output_tokens"),
        has_tool_calls=bool(ai.tool_calls),
    )


def _tool_message(content: str, call: dict[str, Any]) -> ToolMessage:
    return ToolMessage(content=content, tool_call_id=call.get("id") or "", name=call.get("name"))


class OpenBoxRestateMiddleware(RestateMiddleware):
    """``RestateMiddleware`` + OpenBox governance for tools and LLM calls."""

    def __init__(self, run_options: RunOptions[Any] | None = None, *, type_map: dict[str, str] | None = None):
        super().__init__(run_options)
        self._type_map = type_map or {}

    async def awrap_model_call(
        self,
        request: ModelRequest,
        handler: Callable[[ModelRequest], Awaitable[ModelResponse]],
    ) -> ModelResponse:
        prompt = next((_text(m.content) for m in reversed(request.messages) if isinstance(m, HumanMessage)), None)
        return await governed_llm_call(
            restate_context(),
            lambda: super(OpenBoxRestateMiddleware, self).awrap_model_call(request, handler),
            _describe,
            prompt=prompt,
            model=getattr(request.model, "model_name", None) or getattr(request.model, "model", None),
        )

    async def awrap_tool_call(
        self,
        request: ToolCallRequest,
        handler: Callable[[ToolCallRequest], Awaitable[ToolCallResult]],
    ) -> ToolCallResult:
        call: dict[str, Any] = dict(request.tool_call)
        type_ = self._type_map.get(call.get("name") or "")

        async def governed(req: ToolCallRequest) -> ToolCallResult:
            # Runs inside RestateMiddleware's turn for this call.
            g = require_governance_context()
            ctx = restate_context()
            name = call.get("name") or "tool"
            p = await pre_phase(ctx, g, name, input=call.get("args") or {}, tool_call_id=call.get("id"), type=type_)
            if p.blocked is not None:
                return _tool_message(f"Blocked by policy: {p.blocked[1]}", call)
            if isinstance(p.input, dict) and p.input != call.get("args"):  # input guardrails redacted the args
                req = req.override(tool_call={**req.tool_call, "args": p.input})
            outcome = await run_tool(ctx, g, p, lambda _a: handler(req))
            result = await finish_phase(ctx, g, p, outcome)
            if is_blocked(result):
                return _tool_message(str(result), call)
            if isinstance(result, ToolMessage | Command):
                return result
            # Output guardrails replaced the result with a redacted value: hand LangGraph a ToolMessage.
            return _tool_message(result if isinstance(result, str) else json.dumps(result, default=str), call)

        return await super().awrap_tool_call(request, governed)
