from chair_agent.models import TOOLS


def test_tools_are_non_destructive() -> None:
    assert TOOLS
    assert all(tool.destructive is False for tool in TOOLS)
