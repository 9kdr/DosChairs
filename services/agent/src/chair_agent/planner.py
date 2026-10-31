"""Rule-based v1 planner: short briefs about silence and filler removal.

Reads a short brief, detects the cleanup intents it names, and emits an
ordered plan of tool steps against the proxy. A model-backed planner can
replace plan_brief later; the Plan shape stays.
"""

from pydantic import BaseModel, ConfigDict

from chair_agent.models import TOOLS

_TOOL_NAMES = frozenset(tool.name for tool in TOOLS)


class PlanStep(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    tool: str
    goal: str


class Plan(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    brief: str
    intents: list[str]
    steps: list[PlanStep]


def _intents(brief: str) -> list[str]:
    lowered = brief.lower()
    intents = []
    if "silenc" in lowered:
        intents.append("silence")
    if "filler" in lowered:
        intents.append("filler")
    return intents


def plan_brief(brief: str) -> Plan:
    """Turn a short brief into an ordered plan of tool steps.

    v1 understands silence and filler removal on a proxy. Raises
    ValueError when the brief is empty or names nothing v1 can plan.
    """
    if not brief.strip():
        raise ValueError("brief must be a non-empty string")
    intents = _intents(brief)
    if not intents:
        raise ValueError("brief names no cleanup v1 plans: say 'silence' or 'filler'")
    steps = []
    if "silence" in intents:
        steps.append(PlanStep(tool="measure_audio", goal="find silent spans on the proxy"))
    if "filler" in intents:
        steps.append(PlanStep(tool="transcribe", goal="find filler words on the proxy"))
    steps.append(PlanStep(tool="editor_op", goal="cut the flagged spans"))
    steps.append(PlanStep(tool="render_preview", goal="render a low-res preview"))
    unknown = [step.tool for step in steps if step.tool not in _TOOL_NAMES]
    if unknown:
        raise ValueError(f"plan uses unknown tools: {', '.join(unknown)}")
    return Plan(brief=brief, intents=intents, steps=steps)
