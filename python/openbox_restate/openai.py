"""``openbox_restate.openai`` — govern OpenAI Agents SDK tools on Restate (architecture §11.2).

One diff on top of Restate's ``openai-agents`` template::

    @agent_service.handler()
    @openbox_handler(agent_name="weather-agent", prompt_from=lambda r: r.message)
    async def run(_ctx: restate.Context, req: WeatherPrompt) -> str:
        result = await DurableRunner.run(govern_agent(weather_agent), req.message)
        return result.final_output

``govern_agent`` wraps every ``FunctionTool`` of the agent (and of its handoff
agents) in ``governed_run``, keyed by the model's ``tool_call_id``. It must be
applied BEFORE ``DurableRunner.run``: Restate's turn-order wrapper then sits
outside ours, so governance checks run in the deterministic tool-call order.

* BLOCK goes back to the model as the tool output (``"Blocked by policy: …"``).
* HALT and other governance errors are re-raised as exceptions that are both an
  ``AgentsException`` (so the Agents SDK does not turn them into a retryable
  ``UserError``) and the original ``TerminalError`` (so Restate stops and
  ``openbox_handler`` reports it), exactly like Restate's ``AgentsTerminalException``.
* Hosted tools (``WebSearchTool``, ``HostedMCPTool``…) run at OpenAI and cannot
  be governed before they execute; they pass through unchanged.

Needs ``openbox-restate-sdk[openai]``.
"""

from __future__ import annotations

import dataclasses
import json
from collections.abc import Callable
from typing import Any, TypeVar, cast

from agents import Agent, AgentHooks, AgentsException, FunctionTool, Handoff, ModelResponse, Tool
from agents.tool_context import ToolContext
from restate.exceptions import TerminalError
from restate.ext.openai import durable_function_tool, raise_terminal_errors, restate_context

from .context import require_governance_context
from .errors import hook_verdict_of
from .governed_run import governed_run, is_blocked
from .llm import llm_finished, llm_output, llm_scope_info, llm_started

__all__ = ["govern_agent", "govern_tool", "governed_function_tool"]

TAgent = TypeVar("TAgent", bound=Agent[Any])

_bridges: dict[type[BaseException], type[BaseException]] = {}
# Set on every governed on_invoke_tool, so a tool is never governed twice.
_GOVERNED = "__openbox_governed__"


def _as_agents_exception(err: TerminalError) -> BaseException:
    """The same error, also typed as an AgentsException (class and metadata preserved)."""
    if isinstance(err, AgentsException):
        return err
    cls = type(err)
    bridge = _bridges.get(cls)
    if bridge is None:
        bridge = type(cls.__name__, (cls, AgentsException), {"__module__": cls.__module__})
        _bridges[cls] = bridge
    bridged = bridge.__new__(bridge)
    bridged.__dict__.update(err.__dict__)
    bridged.args = err.args
    bridged.__cause__ = err.__cause__
    return bridged


def _governed(tool: FunctionTool, *, type: str | None, agent_id: str | None) -> FunctionTool:
    inner = tool.on_invoke_tool
    name = tool.name

    async def on_invoke_tool(tool_context: ToolContext[Any], tool_input: str) -> Any:
        ctx = restate_context()
        try:
            arguments = json.loads(tool_input or "{}")
        except ValueError:
            arguments = tool_input

        async def run(effective: Any) -> Any:
            # Input guardrails may have redacted the arguments: hand the tool what OpenBox approved.
            payload = tool_input if effective == arguments else json.dumps(effective)
            return await inner(tool_context, payload)

        try:
            result = await governed_run(
                ctx,
                name,
                run,
                input=arguments,
                tool_call_id=tool_context.tool_call_id,
                type=type,
                agent_id=agent_id,
            )
        except TerminalError as err:
            raise _as_agents_exception(err) from err.__cause__
        if is_blocked(result):
            return str(result)
        return result

    setattr(on_invoke_tool, _GOVERNED, True)  # noqa: B010 — marker read by govern_agent
    return dataclasses.replace(tool, on_invoke_tool=on_invoke_tool)


def _text_of(item: Any) -> str | None:
    """Text of a user input item (dict or SDK object)."""
    get = item.get if isinstance(item, dict) else lambda k, d=None: getattr(item, k, d)
    if get("role") != "user":
        return None
    content = get("content")
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts = [p.get("text") if isinstance(p, dict) else getattr(p, "text", None) for p in content]
        text = " ".join(t for t in parts if isinstance(t, str))
        return text or None
    return None


def _model_name(agent: Agent[Any]) -> str | None:
    model = agent.model
    if isinstance(model, str):
        return model
    if model is not None:
        return getattr(model, "model", None) or type(model).__name__
    try:
        from agents.models import get_default_model

        return str(get_default_model())
    except Exception:  # noqa: BLE001
        return None


class _OpenBoxAgentHooks(AgentHooks[Any]):
    """Reports each model call (telemetry only), then forwards every hook to the agent's own hooks."""

    def __init__(self, inner: AgentHooks[Any] | None) -> None:
        self._inner = inner
        self._pending: dict[str, tuple[str, int | None]] = {}  # invocation id -> (llm activity id, start)

    async def on_llm_start(self, context: Any, agent: Any, system_prompt: Any, input_items: Any) -> None:
        prompt = None
        for item in reversed(list(input_items or [])):
            prompt = _text_of(item)
            if prompt:
                break
        g = require_governance_context()
        # Started BEFORE the model call, and marked as the invocation's in-flight llm_call, so the
        # provider's HTTP request is captured as its span (hooks run in other tasks: a ContextVar
        # set here would not reach the model call, the shared governance context does).
        aid, started_at = await llm_started(restate_context(), g, prompt)
        self._pending[g.workflow_id] = (aid, started_at)
        g.llm_scope = llm_scope_info(g, aid)
        if self._inner:
            await self._inner.on_llm_start(context, agent, system_prompt, input_items)

    async def on_llm_end(self, context: Any, agent: Any, response: ModelResponse) -> None:
        # Fires again on replay (the response comes from the journal); both llm steps are journaled,
        # so OpenBox still sees the call once.
        g = require_governance_context()
        g.llm_scope = None
        texts: list[str] = []
        has_tool_calls = False
        for item in response.output:
            kind = getattr(item, "type", None)
            if kind == "function_call":
                has_tool_calls = True
            elif kind == "message":
                for part in getattr(item, "content", []) or []:
                    if getattr(part, "type", None) == "output_text":
                        texts.append(part.text)
        usage = response.usage
        pending = self._pending.pop(g.workflow_id, None)
        if pending is not None:
            aid, started_at = pending
            await llm_finished(
                restate_context(),
                g,
                aid,
                started_at,
                llm_output(
                    model=_model_name(agent),
                    completion="".join(texts) or None,
                    input_tokens=usage.input_tokens if usage else None,
                    output_tokens=usage.output_tokens if usage else None,
                    has_tool_calls=has_tool_calls,
                ),
            )
        if self._inner:
            await self._inner.on_llm_end(context, agent, response)

    async def on_start(self, context: Any, agent: Any) -> None:
        if self._inner:
            await self._inner.on_start(context, agent)

    async def on_end(self, context: Any, agent: Any, output: Any) -> None:
        if self._inner:
            await self._inner.on_end(context, agent, output)

    async def on_handoff(self, context: Any, agent: Any, source: Any) -> None:
        if self._inner:
            await self._inner.on_handoff(context, agent, source)

    async def on_tool_start(self, context: Any, agent: Any, tool: Any) -> None:
        if self._inner:
            await self._inner.on_tool_start(context, agent, tool)

    async def on_tool_end(self, context: Any, agent: Any, tool: Any, result: Any) -> None:
        if self._inner:
            await self._inner.on_tool_end(context, agent, tool, result)


def govern_tool(tool: FunctionTool, *, type: str | None = None, agent_id: str | None = None) -> FunctionTool:
    """Govern one ``FunctionTool`` (e.g. one built with ``durable_function_tool``)."""
    return _governed(tool, type=type, agent_id=agent_id)


def _failure_keeping_span_verdicts(context: Any, error: Exception) -> str:
    # A span BLOCK/HALT raised inside the tool body must reach governed_run with its metadata;
    # Restate's default handler would rebuild it as a plain AgentsTerminalException.
    if isinstance(error, TerminalError) and hook_verdict_of(error) is not None:
        raise _as_agents_exception(error)
    return raise_terminal_errors(context, error)


def governed_function_tool(
    func: Callable[..., Any] | None = None,
    *,
    type: str | None = None,
    agent_id: str | None = None,
    **tool_kwargs: Any,
) -> Any:
    """``durable_function_tool`` + OpenBox governance, as a decorator::

    @governed_function_tool
    async def send_email(to: str, body: str) -> str: ...

    @governed_function_tool(type="EMAIL_SEND")
    async def send_email(to: str, body: str) -> str: ...
    """
    tool_kwargs.setdefault("failure_error_function", _failure_keeping_span_verdicts)

    def build(f: Callable[..., Any]) -> FunctionTool:
        return _governed(durable_function_tool(f, **tool_kwargs), type=type, agent_id=agent_id)

    return build(func) if callable(func) else build


def govern_agent(
    agent: TAgent,
    *,
    type_map: dict[str, str] | None = None,
    agent_id: str | None = None,
) -> TAgent:
    """Govern every ``FunctionTool`` of ``agent`` and, recursively, of its handoff agents.

    Apply it before ``DurableRunner.run``. Tools that are already governed are left alone.
    """
    return cast(TAgent, _govern_agent(agent, type_map or {}, agent_id, {}))


def _govern_agent(
    agent: Agent[Any], type_map: dict[str, str], agent_id: str | None, seen: dict[int, Agent[Any]]
) -> Agent[Any]:
    if id(agent) in seen:  # handoff cycles (A → B → A)
        return seen[id(agent)]
    tools: list[Tool] = []
    for t in agent.tools:
        if isinstance(t, FunctionTool) and not getattr(t.on_invoke_tool, _GOVERNED, False):
            governed = _governed(t, type=type_map.get(t.name), agent_id=agent_id or agent.name)
            tools.append(governed)
        else:
            tools.append(t)
    hooks = agent.hooks if isinstance(agent.hooks, _OpenBoxAgentHooks) else _OpenBoxAgentHooks(agent.hooks)
    clone = agent.clone(tools=tools, hooks=hooks)
    seen[id(agent)] = clone
    handoffs: list[Any] = []
    for h in agent.handoffs:
        if isinstance(h, Agent):
            handoffs.append(_govern_agent(h, type_map, agent_id, seen))
        elif isinstance(h, Handoff):
            handoffs.append(_govern_handoff(h, type_map, agent_id, seen))
        else:
            handoffs.append(h)
    clone.handoffs = handoffs
    return clone


def _govern_handoff(
    h: Handoff[Any, Any], type_map: dict[str, str], agent_id: str | None, seen: dict[int, Agent[Any]]
) -> Handoff[Any, Any]:
    original = h.on_invoke_handoff

    async def on_invoke_handoff(*args: Any, **kwargs: Any) -> Any:
        target = await original(*args, **kwargs)
        return _govern_agent(target, type_map, agent_id, seen)

    return dataclasses.replace(h, on_invoke_handoff=on_invoke_handoff)
