"""TaskResult: what one crew task produced."""

from dataclasses import dataclass, field

from chair_agent.edit_ops import ChangesetItem


@dataclass
class TaskResult:
    """One finished task: its section, pending items, and verdict."""

    task_id: str
    section: str
    artifacts: list[str] = field(default_factory=list)
    items: list[ChangesetItem] = field(default_factory=list)
    verdict: str = "rejected"
    notes: str = ""
    error: str | None = None

    def to_dict(self) -> dict:
        return {
            "task_id": self.task_id,
            "section": self.section,
            "artifacts": list(self.artifacts),
            "items": [item.model_dump(mode="json", by_alias=True) for item in self.items],
            "verdict": self.verdict,
            "notes": self.notes,
            "error": self.error,
        }
