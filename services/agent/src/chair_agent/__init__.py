"""Chair agent runtime.

Planner, executor, and verifier call ModelClient. Image generation goes through ImageAdapter.
"""

from chair_agent.models import TOOLS

__all__ = ["TOOLS"]
