"""``openbox_restate.adk`` — govern Google ADK agents on Restate (architecture §22.6).

One diff on top of Restate's ``google-adk`` template: replace ``RestatePlugin()`` with
``OpenBoxRestatePlugin()`` and decorate the handler with ``@openbox_handler``::

    app = App(name=APP_NAME, root_agent=agent, plugins=[OpenBoxRestatePlugin()])

``OpenBoxRestatePlugin`` IS a ``RestatePlugin`` (durable LLM calls, turn-ordered tools), plus:

* **Tools.** ``before_tool_callback`` runs the OpenBox pre-check after Restate's turn-order
  wait; ``after_tool_callback`` runs the post-check BEFORE the next tool is released, so the
  governance timeline replays deterministically. BLOCK answers the call with
  ``{"blocked": True, "reason": ...}`` (the tool never runs); HALT ends the invocation;
  REQUIRE_APPROVAL waits durably. While the tool runs, its HTTP/DB/file calls are spans of
  its activity (with ``enable_openbox_spans()``).
* **LLM calls.** Each model call is an ``llm_call`` activity (model, tokens), and the
  provider request is its span.

ADK wraps exceptions raised in plugin callbacks in ``RuntimeError``; ``openbox_handler``
unwraps OpenBox errors again, so a HALT or a rejected approval is still terminal.

Needs ``openbox-restate-sdk[adk]``.
"""

from __future__ import annotations

from typing import Any

import restate
from google.adk.agents.callback_context import CallbackContext
from google.adk.models.llm_request import LlmRequest
from google.adk.models.llm_response import LlmResponse
from google.adk.tools.base_tool import BaseTool
from google.adk.tools.tool_context import ToolContext
from google.genai.types import Content, Part
from restate.ext.adk import RestatePlugin
from restate.extensions import current_context

from .context import GovernanceContext, require_governance_context
from .governed_run import Outcome, Prepared, finish_phase, is_blocked, pre_phase
from .llm import governed_llm_call, llm_output
from .runtime import SpanScopeInfo

__all__ = ["OpenBoxRestatePlugin"]


def _ctx() -> restate.Context:
    ctx = current_context()
    if ctx is None:
        raise restate.TerminalError("OpenBoxRestatePlugin must run inside a Restate handler.")
    return ctx


def _tool_scope(g: GovernanceContext, p: Prepared) -> SpanScopeInfo:
    return SpanScopeInfo(
        workflow_id=g.workflow_id,
        run_id=g.run_id,
        workflow_type=g.workflow_type,
        activity_id=p.aid,
        activity_type=p.name,
        agent_name=g.agent_name,
        session_id=g.session_id,
        multi_agent_session_id=g.multi_agent_session_id,
        approved=p.approved,
    )


def _latest_user_text(llm_request: LlmRequest) -> str | None:
    for content in reversed(llm_request.contents or []):
        if getattr(content, "role", None) == "user":
            texts = [p.text for p in (content.parts or []) if getattr(p, "text", None)]
            if texts:
                return " ".join(t for t in texts if t)
    return None


def _with_user_text(llm_request: LlmRequest, original: str, text: str) -> None:
    """Replace the text of the user turns carrying ``original`` (the prompt OpenBox checked) with ``text``.

    Every such turn, not just the latest: Restate re-runs the ADK runner on replay and an
    in-memory session then holds the same user message more than once. Non-text parts are kept,
    and new ``Content`` objects go in the request's list, so the session history is not changed.
    """
    contents = llm_request.contents or []
    for i, content in enumerate(contents):
        if getattr(content, "role", None) != "user":
            continue
        texts = [p.text for p in content.parts or [] if getattr(p, "text", None)]
        if texts and " ".join(t for t in texts if t) == original:
            others = [p for p in content.parts or [] if not getattr(p, "text", None)]
            contents[i] = Content(role="user", parts=[Part.from_text(text=text), *others])


def _describe(response: LlmResponse | None, model: str | None) -> dict[str, Any]:
    if response is None:
        return llm_output(model=model)
    usage = response.usage_metadata
    parts = (response.content.parts or []) if response.content else []
    texts = [p.text for p in parts if getattr(p, "text", None)]
    return llm_output(
        model=response.model_version or model,
        completion="".join(t for t in texts if t) or None,
        input_tokens=getattr(usage, "prompt_token_count", None) if usage else None,
        output_tokens=getattr(usage, "candidates_token_count", None) if usage else None,
        has_tool_calls=any(getattr(p, "function_call", None) for p in parts),
    )


class OpenBoxRestatePlugin(RestatePlugin):
    """``RestatePlugin`` + OpenBox governance for tools and LLM calls."""

    def __init__(self, *, run_options: restate.RunOptions[Any] | None = None, type_map: dict[str, str] | None = None):
        super().__init__(run_options=run_options)
        self._type_map = type_map or {}

    # ── LLM calls ────────────────────────────────────────────────────────────

    async def before_model_callback(
        self, *, callback_context: CallbackContext, llm_request: LlmRequest
    ) -> LlmResponse | None:
        model = llm_request.model
        prompt = _latest_user_text(llm_request)

        async def call(approved: str | None) -> LlmResponse | None:
            if prompt is not None and approved is not None and approved != prompt:  # input guardrails redacted it
                _with_user_text(llm_request, prompt, approved)
            return await super(OpenBoxRestatePlugin, self).before_model_callback(
                callback_context=callback_context, llm_request=llm_request
            )

        return await governed_llm_call(
            _ctx(),
            call,
            lambda r: _describe(r, model),
            prompt=prompt,
            model=model,
        )

    # ── Tools ────────────────────────────────────────────────────────────────

    async def before_tool_callback(
        self, *, tool: BaseTool, tool_args: dict[str, Any], tool_context: ToolContext
    ) -> dict[str, Any] | None:
        await super().before_tool_callback(tool=tool, tool_args=tool_args, tool_context=tool_context)  # turn order
        g = require_governance_context()
        call_id = tool_context.function_call_id or ""
        p = await pre_phase(
            _ctx(),
            g,
            tool.name,
            input=dict(tool_args),
            tool_call_id=call_id,
            type=self._type_map.get(tool.name),
            agent_id=tool_context.agent_name,
        )
        if p.blocked is not None:
            _, reason = p.blocked
            g.pending_calls[call_id] = None  # after_tool_callback only releases the turn
            return {"blocked": True, "reason": reason, "message": f"Blocked by policy: {reason}"}
        if isinstance(p.input, dict) and p.input != tool_args:  # input guardrails redacted the arguments
            tool_args.clear()
            tool_args.update(p.input)
        g.pending_calls[call_id] = p
        g.active_scope = _tool_scope(g, p)  # the tool's HTTP/DB/file calls are its spans
        return None

    async def after_tool_callback(
        self, *, tool: BaseTool, tool_args: dict[str, Any], tool_context: ToolContext, result: dict[str, Any]
    ) -> dict[str, Any] | None:
        g = require_governance_context()
        call_id = tool_context.function_call_id or ""
        p: Prepared | None = g.pending_calls.pop(call_id, None)
        g.active_scope = None
        try:
            if p is None:
                return None  # blocked before it ran
            # Post-check BEFORE the turn is released (deterministic journal order).
            out = await finish_phase(_ctx(), g, p, Outcome(result=result))
            if is_blocked(out):
                return {"blocked": True, "reason": out.reason, "message": str(out)}
            return out if out is not result else None  # output guardrails may have redacted it
        finally:
            await super().after_tool_callback(tool=tool, tool_args=tool_args, tool_context=tool_context, result=result)

    async def on_tool_error_callback(
        self, *, tool: BaseTool, tool_args: dict[str, Any], tool_context: ToolContext, error: Exception
    ) -> dict[str, Any] | None:
        g = require_governance_context()
        call_id = tool_context.function_call_id or ""
        p: Prepared | None = g.pending_calls.pop(call_id, None)
        g.active_scope = None
        out: Any = None
        try:
            if p is not None:
                out = await finish_phase(_ctx(), g, p, Outcome(error=error))  # re-raises non-governance errors
        except BaseException:
            await super().on_tool_error_callback(tool=tool, tool_args=tool_args, tool_context=tool_context, error=error)
            raise
        if is_blocked(out):
            # A span BLOCK inside the tool: answered like a BLOCK, and the next tool gets its turn.
            await super().after_tool_callback(tool=tool, tool_args=tool_args, tool_context=tool_context, result={})
            return {"blocked": True, "reason": out.reason, "message": str(out)}
        await super().on_tool_error_callback(tool=tool, tool_args=tool_args, tool_context=tool_context, error=error)
        return None
