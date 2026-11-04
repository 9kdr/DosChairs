"""Crew: a command that splits a brief plus a plan into tasks, one tool
subagent per task, then one merged pending changeset.

Every edit lands on a copy and stays undoable: subagents emit pending
changeset items only, and the merge produces a single pending
changeset that the UI applies after a human accepts. Nothing here
touches source media or the person's timeline in place.
"""

from chair_agent.crew.command import InvalidTasks, Task, run_command
from chair_agent.crew.orchestrator import (
    CrewRun,
    handle_direct,
    run_crew,
    run_task,
    status_snapshot,
)
from chair_agent.crew.result import TaskResult

__all__ = [
    "CrewRun",
    "InvalidTasks",
    "Task",
    "TaskResult",
    "handle_direct",
    "run_command",
    "run_crew",
    "run_task",
    "status_snapshot",
]
