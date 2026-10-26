"""Chair agent runtime.

Planner (Wonder), executor (Spark), and verifier (Spark, multimodal) will live here.
This process only exposes health and a typed tool list until those loops land.
"""

from chair_agent.models import TOOLS

__all__ = ["TOOLS"]
