from pathlib import Path

import chair_agent.models as models
from chair_agent.models import TOOLS


def test_tools_are_non_destructive() -> None:
    assert TOOLS
    assert all(tool.destructive is False for tool in TOOLS)


def test_tool_registry_has_no_vendor_sdk() -> None:
    source = Path(models.__file__).read_text(encoding="utf-8").lower()
    assert "openai" not in source
    assert "anthropic" not in source
    assert "httpx" not in source
    assert "api.meta.ai" not in source
