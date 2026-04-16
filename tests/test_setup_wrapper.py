from __future__ import annotations

import os
import subprocess
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts" / "setup.sh"


def _write_fake_python3(bin_dir: Path, marker_path: Path) -> None:
    (bin_dir / "python3").write_text(
        "#!/bin/bash\n"
        f"printf '%s\n' \"$@\" > {marker_path!s}\n",
        encoding="utf-8",
    )
    (bin_dir / "python3").chmod(0o755)


def test_setup_wrapper_uses_python3_for_default_bootstrap_when_python_alias_is_missing(tmp_path: Path) -> None:
    marker_path = tmp_path / "argv.txt"
    fake_bin = tmp_path / "bin"
    fake_bin.mkdir()
    _write_fake_python3(fake_bin, marker_path)

    env = os.environ.copy()
    env["PATH"] = str(fake_bin)

    completed = subprocess.run(
        ["/bin/bash", str(SCRIPT)],
        cwd=ROOT,
        env=env,
        capture_output=True,
        text=True,
        check=False,
    )

    assert completed.returncode == 0, completed.stderr
    assert marker_path.read_text(encoding="utf-8").splitlines() == [
        "scripts/setup_bootstrap.py",
        "--write-env-if-missing",
    ]


def test_setup_wrapper_uses_python3_for_doctor_when_python_alias_is_missing(tmp_path: Path) -> None:
    marker_path = tmp_path / "argv.txt"
    fake_bin = tmp_path / "bin"
    fake_bin.mkdir()
    _write_fake_python3(fake_bin, marker_path)

    env = os.environ.copy()
    env["PATH"] = str(fake_bin)

    completed = subprocess.run(
        ["/bin/bash", str(SCRIPT), "doctor", "--json"],
        cwd=ROOT,
        env=env,
        capture_output=True,
        text=True,
        check=False,
    )

    assert completed.returncode == 0, completed.stderr
    assert marker_path.read_text(encoding="utf-8").splitlines() == [
        "scripts/setup_doctor.py",
        "--json",
    ]


def test_setup_wrapper_uses_python3_for_telegram_finalize_when_python_alias_is_missing(tmp_path: Path) -> None:
    marker_path = tmp_path / "argv.txt"
    fake_bin = tmp_path / "bin"
    fake_bin.mkdir()
    _write_fake_python3(fake_bin, marker_path)

    env = os.environ.copy()
    env["PATH"] = str(fake_bin)

    completed = subprocess.run(
        ["/bin/bash", str(SCRIPT), "telegram", "--menu-button-text", "Launch"],
        cwd=ROOT,
        env=env,
        capture_output=True,
        text=True,
        check=False,
    )

    assert completed.returncode == 0, completed.stderr
    assert marker_path.read_text(encoding="utf-8").splitlines() == [
        "scripts/setup_telegram.py",
        "--menu-button-text",
        "Launch",
    ]
