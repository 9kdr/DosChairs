from pathlib import Path

import chair_agent.models as models
import pytest
from chair_agent.models import TOOLS, tools_for_effect


def test_tools_are_non_destructive() -> None:
    assert TOOLS
    assert all(tool.destructive is False for tool in TOOLS)


def test_effect_selects_its_endpoint_tool() -> None:
    assert [tool.name for tool in tools_for_effect("grade")] == ["grade"]
    assert [tool.name for tool in tools_for_effect("motion_graphics")] == ["motion_graphics"]
    assert all(tool.destructive is False for tool in tools_for_effect("sam3_mask"))
    with pytest.raises(ValueError):
        tools_for_effect("warp_drive")


def test_tool_registry_has_no_vendor_sdk() -> None:
    source = Path(models.__file__).read_text(encoding="utf-8").lower()
    assert "openai" not in source
    assert "anthropic" not in source
    assert "httpx" not in source
    assert "api.meta.ai" not in source
