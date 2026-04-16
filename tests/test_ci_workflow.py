from __future__ import annotations

from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def test_ci_workflow_runs_install_smoke_harness() -> None:
    workflow = (ROOT / ".github" / "workflows" / "ci.yml").read_text(encoding="utf-8")

    assert "install-smoke" in workflow
    assert "scripts/install_smoke.sh" in workflow
