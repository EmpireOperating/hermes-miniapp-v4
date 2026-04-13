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


def test_update_env_file_replaces_target_keys_without_dropping_comments(tmp_path: Path) -> None:
    env_path = tmp_path / ".env"
    env_path.write_text("# comment\nTELEGRAM_BOT_TOKEN=***\nHERMES_STREAM_URL=\nHERMES_API_URL=old\n", encoding="utf-8")

    setup_bootstrap.update_env_file(env_path, {"TELEGRAM_BOT_TOKEN": "123:abc", "HERMES_API_URL": "", "HERMES_STREAM_URL": "https://example.com/stream"})

    text = env_path.read_text(encoding="utf-8")
    assert "# comment" in text
    assert "TELEGRAM_BOT_TOKEN=123:abc" in text
    assert "HERMES_STREAM_URL=https://example.com/stream" in text
    assert "HERMES_API_URL=" in text


def test_should_run_interactive_prefers_tty_unless_noninteractive(monkeypatch) -> None:
    class _TTY:
        @staticmethod
        def isatty() -> bool:
            return True

    monkeypatch.setattr(setup_bootstrap.sys, "stdin", _TTY())
    monkeypatch.setattr(setup_bootstrap.sys, "stdout", _TTY())

    parser = setup_bootstrap.build_parser()
    assert setup_bootstrap.should_run_interactive(parser.parse_args([])) is True
    assert setup_bootstrap.should_run_interactive(parser.parse_args(["--non-interactive"])) is False
    assert setup_bootstrap.should_run_interactive(parser.parse_args(["--interactive"])) is True


def test_recommended_backend_choice_prefers_existing_values_and_platform_defaults() -> None:
    assert setup_bootstrap.recommended_backend_choice({"HERMES_STREAM_URL": "https://example.com/stream"}, platform_name="linux") == "1"
    assert setup_bootstrap.recommended_backend_choice({"HERMES_API_URL": "https://example.com/api"}, platform_name="linux") == "2"
    assert setup_bootstrap.recommended_backend_choice({"HERMES_CLI_COMMAND": "hermes --profile local"}, platform_name="linux") == "3"
    assert setup_bootstrap.recommended_backend_choice({}, platform_name="linux") == "1"
    assert setup_bootstrap.recommended_backend_choice({}, platform_name="win32") == "2"


def test_native_windows_message_mentions_wsl2() -> None:
    message = setup_bootstrap.native_windows_message()

    assert "WSL2" in message
    assert "scripts/setup.sh" in message


def test_explain_backend_modes_mentions_recommendation() -> None:
    printed: list[str] = []

    setup_bootstrap.explain_backend_modes(recommended_choice="2", output=printed.append)

    joined = "\n".join(printed)
    assert joined == "Recommended: HERMES_API_URL"


def test_configure_env_interactively_updates_stream_backend(tmp_path: Path) -> None:
    env_path = tmp_path / ".env"
    env_path.write_text(
        "TELEGRAM_BOT_TOKEN=***\nMINI_APP_URL=https://your-domain.com/app\nHERMES_STREAM_URL=\nHERMES_API_URL=\nHERMES_CLI_COMMAND=hermes\n",
        encoding="utf-8",
    )

    answers = iter([
        "123456:real-token",
        "https://mini.example.com/app",
        "1",
        "https://hermes.example.com/stream",
    ])
    printed: list[str] = []

    updates = setup_bootstrap.configure_env_interactively(
        tmp_path,
        input_fn=lambda _prompt: next(answers),
        output=printed.append,
    )

    assert updates["TELEGRAM_BOT_TOKEN"] == "123456:real-token"
    assert updates["MINI_APP_URL"] == "https://mini.example.com/app"
    assert updates["HERMES_STREAM_URL"] == "https://hermes.example.com/stream"
    assert updates["HERMES_API_URL"] == ""
    text = env_path.read_text(encoding="utf-8")
    assert "TELEGRAM_BOT_TOKEN=123456:real-token" in text
    assert "MINI_APP_URL=https://mini.example.com/app" in text
    assert "HERMES_STREAM_URL=https://hermes.example.com/stream" in text
    assert "HERMES_API_URL=" in text
    joined = "\n".join(printed)
    assert "Interactive setup" in joined
    assert "Recommended: HERMES_STREAM_URL" in joined
    assert "Any domain or subdomain you control is fine" in joined
    assert "Local Hermes CLI/runtime" in joined


def test_render_next_steps_mentions_dns_doctor_and_interactive_fill(tmp_path: Path) -> None:
    output = setup_bootstrap.render_next_steps(tmp_path, env_state="created", interactive_updates={"MINI_APP_URL": "https://mini.example.com/app"})

    assert "bootstrap already filled the prompted values" in output
    assert "python scripts/setup_doctor.py" in output
    assert "MINI_APP_URL must be HTTPS" in output
    assert "domain or subdomain you control" in output
