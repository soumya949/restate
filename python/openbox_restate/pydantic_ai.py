"""``openbox_restate.pydantic_ai`` — govern Pydantic AI agents on Restate (architecture §22.6).

One diff on top of Restate's ``pydantic-ai`` template: replace ``RestateAgent(agent)`` with
``OpenBoxRestateAgent(agent)`` and decorate the handler with ``@openbox_handler``::

    restate_agent = OpenBoxRestateAgent(weather_agent)

``OpenBoxRestateAgent`` IS a ``RestateAgent`` (durable model calls, Restate-aware toolsets), plus:

* **Tools.** Every toolset is wrapped OUTSIDE Restate's own wrapping (so governance never runs
  inside a ``ctx.run``). Pydantic AI runs a step's tool calls concurrently; governed calls are
  serialized per invocation in the order they start, so pre-checks, tools and post-checks
  appear in the journal in a deterministic order. BLOCK returns ``"Blocked by policy: …"`` as
  the tool result; HALT ends the invocation; REQUIRE_APPROVAL waits durably.
* **LLM calls.** Each model request is an ``llm_call`` activity (model, tokens) and the
  provider request is its span.

Needs ``openbox-restate-sdk[pydantic-ai]``.
"""

from __future__ import annotations

import asyncio
import dataclasses
from typing import Any

from pydantic_ai.messages import ModelMessage, ModelRequest, ModelResponse, TextPart, ToolCallPart, UserPromptPart
from pydantic_ai.models import ModelRequestParameters
from pydantic_ai.models.wrapper import WrapperModel
from pydantic_ai.settings import ModelSettings
from pydantic_ai.tools import RunContext
from pydantic_ai.toolsets.abstract import AbstractToolset, ToolsetTool
from pydantic_ai.toolsets.wrapper import WrapperToolset
from restate.ext.pydantic import RestateAgent, restate_context

from .context import GovernanceContext, require_governance_context
from .governed_run import finish_phase, is_blocked, pre_phase, run_tool
from .llm import governed_llm_call, llm_output

__all__ = ["OpenBoxRestateAgent"]


def _tool_lock(g: GovernanceContext) -> asyncio.Lock:
    if g.tool_lock is None:
        g.tool_lock = asyncio.Lock()
    lock: asyncio.Lock = g.tool_lock
    return lock


class _GovernedToolset(WrapperToolset[Any]):
    """Governs every tool call of the wrapped toolset (outermost: never inside a ctx.run)."""

    def __init__(self, wrapped: AbstractToolset[Any], type_map: dict[str, str]):
        super().__init__(wrapped)
        self._type_map = type_map

    async def call_tool(
        self, name: str, tool_args: dict[str, Any], ctx: RunContext[Any], tool: ToolsetTool[Any]
    ) -> Any:
        g = require_governance_context()
        rctx = restate_context()
        # asyncio.Lock is FIFO: concurrent tool calls acquire it in the order they started, which is the
        # model's tool-call order on every replay.
        async with _tool_lock(g):
            p = await pre_phase(
                rctx, g, name, input=tool_args, tool_call_id=ctx.tool_call_id, type=self._type_map.get(name)
            )
            if p.blocked is not None:
                return f"Blocked by policy: {p.blocked[1]}"
            # p.input is what OpenBox approved (input guardrails may have redacted it).
            outcome = await run_tool(rctx, g, p, lambda a: self.wrapped.call_tool(name, a, ctx, tool))
            if outcome.error is not None and not _is_terminal(outcome.error):
                # ModelRetry / CallDeferred / ApprovalRequired and other control-flow exceptions belong to
                # Pydantic AI: let them through untouched (nothing is reported for them).
                raise outcome.error
            result = await finish_phase(rctx, g, p, outcome)
            return str(result) if is_blocked(result) else result

    def visit_and_replace(self, visitor: Any) -> AbstractToolset[Any]:
        # Like Restate's own toolsets: the wrapped toolset is already prepared, do not re-wrap inside us.
        return visitor(self)  # type: ignore[no-any-return]


def _is_terminal(err: BaseException) -> bool:
    from restate.exceptions import TerminalError

    return isinstance(err, TerminalError)


def _latest_prompt(messages: list[ModelMessage]) -> str | None:
    for m in reversed(messages):
        if isinstance(m, ModelRequest):
            for part in reversed(m.parts):
                if isinstance(part, UserPromptPart) and isinstance(part.content, str):
                    return part.content
    return None


def _with_prompt(messages: list[ModelMessage], prompt: str) -> list[ModelMessage]:
    """A copy of ``messages`` with the latest text user prompt replaced (the history is not changed)."""
    out = list(messages)
    for i in range(len(out) - 1, -1, -1):
        m = out[i]
        if not isinstance(m, ModelRequest):
            continue
        for j in range(len(m.parts) - 1, -1, -1):
            part = m.parts[j]
            if isinstance(part, UserPromptPart) and isinstance(part.content, str):
                parts = list(m.parts)
                parts[j] = dataclasses.replace(part, content=prompt)
                out[i] = dataclasses.replace(m, parts=parts)
                return out
    return out


def _describe(response: ModelResponse) -> dict[str, Any]:
    texts = [p.content for p in response.parts if isinstance(p, TextPart)]
    return llm_output(
        model=response.model_name,
        completion="".join(texts) or None,
        input_tokens=response.usage.input_tokens,
        output_tokens=response.usage.output_tokens,
        has_tool_calls=any(isinstance(p, ToolCallPart) for p in response.parts),
    )


class _GovernedModel(WrapperModel):
    """Each request is an llm_call activity around Restate's journaled model call."""

    async def request(
        self,
        messages: list[ModelMessage],
        model_settings: ModelSettings | None,
        model_request_parameters: ModelRequestParameters,
    ) -> ModelResponse:
        prompt = _latest_prompt(messages)

        async def call(approved: str | None) -> ModelResponse:
            # Input guardrails may have redacted the prompt: the provider gets what OpenBox approved.
            sent = _with_prompt(messages, approved) if approved is not None and approved != prompt else messages
            return await self.wrapped.request(sent, model_settings, model_request_parameters)

        return await governed_llm_call(
            restate_context(),
            call,
            _describe,
            prompt=prompt,
            model=self.wrapped.model_name,
        )


class OpenBoxRestateAgent(RestateAgent[Any, Any]):
    """``RestateAgent`` + OpenBox governance for tools and LLM calls."""

    def __init__(self, wrapped: Any, *, type_map: dict[str, str] | None = None, **kwargs: Any) -> None:
        super().__init__(wrapped, **kwargs)
        # RestateAgent keeps its durable model and Restate-wrapped toolsets here; wrap them on the outside.
        self._model = _GovernedModel(self._model)  # type: ignore[assignment]
        self._toolsets = [_GovernedToolset(t, type_map or {}) for t in self._toolsets]
