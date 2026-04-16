from __future__ import annotations

import os
import subprocess
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts" / "install_smoke.sh"


def _write_fake_docker(bin_dir: Path, marker_path: Path) -> None:
    (bin_dir / "docker").write_text(
        "#!/bin/bash\n"
        f"printf '%s\n' \"$@\" >> {marker_path!s}\n",
        encoding="utf-8",
    )
    (bin_dir / "docker").chmod(0o755)


def test_install_smoke_wrapper_builds_and_runs_configured_image(tmp_path: Path) -> None:
    marker_path = tmp_path / "docker-argv.txt"
    fake_bin = tmp_path / "bin"
    fake_bin.mkdir()
    _write_fake_docker(fake_bin, marker_path)

    env = os.environ.copy()
    env["PATH"] = f"{fake_bin}{os.pathsep}{env.get('PATH', '')}"

    completed = subprocess.run(
        ["/bin/bash", str(SCRIPT), "--image-tag", "miniapp-install-smoke:test"],
        cwd=ROOT,
        env=env,
        capture_output=True,
        text=True,
        check=False,
    )

    assert completed.returncode == 0, completed.stderr
    assert marker_path.read_text(encoding="utf-8").splitlines() == [
        "build",
        "-f",
        str(ROOT / "docker" / "install-smoke.Dockerfile"),
        "-t",
        "miniapp-install-smoke:test",
        str(ROOT),
        "run",
        "--rm",
        "miniapp-install-smoke:test",
    ]
