"""The approval gate: write HTTP verbs on call_external_api require approval.

Imports the kube_tools registry, which pulls SQLAlchemy / models; skipped in a
minimal environment, exercised in full CI.
"""

from __future__ import annotations

import pytest

kube_tools = pytest.importorskip("daalu_automation.core.kube_tools")


def test_get_does_not_require_approval() -> None:
    assert kube_tools.tool_requires_approval("call_external_api", {"method": "GET"}) is False
    # Method defaults to GET when unspecified.
    assert kube_tools.tool_requires_approval("call_external_api", {}) is False


@pytest.mark.parametrize("method", ["POST", "put", "PATCH", "delete"])
def test_write_verbs_require_approval(method: str) -> None:
    assert (
        kube_tools.tool_requires_approval("call_external_api", {"method": method}) is True
    )


def test_unregistered_tool_is_not_gated() -> None:
    assert kube_tools.tool_requires_approval("nonexistent_tool", {}) is False
