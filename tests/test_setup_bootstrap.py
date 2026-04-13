from __future__ import annotations

from pathlib import Path

from scripts import setup_bootstrap


class _Completed:
    def __init__(self, stdout: str = "") -> None:
        self.stdout = stdout
        self.stderr = ""


def test_venv_python_path_is_platform_aware() -> None:
    assert setup_bootstrap.venv_python_path(Path("demo/.venv"), platform_name="linux") == Path("demo/.venv/bin/python")
    assert setup_bootstrap.venv_python_path(Path("demo/.venv"), platform_name="win32") == Path("demo/.venv/Scripts/python.exe")


def test_detect_node_major_parses_version_output() -> None:
    major = setup_bootstrap.detect_node_major(
        which=lambda _name: "/usr/bin/node",
        run=lambda *args, **kwargs: _Completed(stdout="v20.11.1\n"),
    )
    assert major == 20


def test_maybe_write_env_creates_file_when_requested(tmp_path: Path) -> None:
    (tmp_path / ".env.example").write_text("A=1\n", encoding="utf-8")

    state = setup_bootstrap.maybe_write_env(tmp_path, write_env_if_missing=True)

    assert state == "created"
    assert (tmp_path / ".env").read_text(encoding="utf-8") == "A=1\n"


def test_maybe_write_env_skips_when_not_requested(tmp_path: Path) -> None:
    (tmp_path / ".env.example").write_text("A=1\n", encoding="utf-8")

    state = setup_bootstrap.maybe_write_env(tmp_path, write_env_if_missing=False)

    assert state == "skipped"
    assert not (tmp_path / ".env").exists()


def test_maybe_write_env_does_not_overwrite_existing_file(tmp_path: Path) -> None:
    (tmp_path / ".env.example").write_text("A=1\n", encoding="utf-8")
    (tmp_path / ".env").write_text("B=2\n", encoding="utf-8")

    state = setup_bootstrap.maybe_write_env(tmp_path, write_env_if_missing=True)

    assert state == "existing"
    assert (tmp_path / ".env").read_text(encoding="utf-8") == "B=2\n"


def test_render_next_steps_mentions_dns_and_doctor(tmp_path: Path) -> None:
    output = setup_bootstrap.render_next_steps(tmp_path, env_state="created")

    assert "python scripts/setup_doctor.py" in output
    assert "MINI_APP_URL must be HTTPS" in output
    assert "cheapest domain you can buy and control is usually good enough" in output
