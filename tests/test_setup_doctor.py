from __future__ import annotations

import json
from pathlib import Path

from scripts import setup_doctor


def test_load_env_file_ignores_comments_and_blank_lines(tmp_path: Path) -> None:
    path = tmp_path / ".env"
    path.write_text("# comment\nA=1\n\nB='two'\n", encoding="utf-8")

    values = setup_doctor.load_env_file(path)

    assert values == {"A": "1", "B": "two"}


def test_check_mini_app_url_requires_https() -> None:
    result = setup_doctor.check_mini_app_url({"MINI_APP_URL": "http://localhost:8080"})

    assert result.status == "FAIL"
    assert "HTTPS" in result.summary


def test_check_mini_app_url_passes_for_https() -> None:
    result = setup_doctor.check_mini_app_url({"MINI_APP_URL": "https://miniapp.example.com/app"})

    assert result.status == "PASS"
    assert "control" in (result.detail or "")


def test_check_telegram_bot_token_rejects_placeholder() -> None:
    result = setup_doctor.check_telegram_bot_token({"TELEGRAM_BOT_TOKEN": "123456...e_me"})

    assert result.status == "FAIL"


def test_detect_local_backend_accepts_http_and_cli(monkeypatch) -> None:
    ok, mode = setup_doctor._detect_local_backend({"HERMES_STREAM_URL": "https://hermes.example/stream"})
    assert ok is True
    assert mode == "stream"

    ok, mode = setup_doctor._detect_local_backend({}, which=lambda _name: "/usr/bin/hermes")
    assert ok is True
    assert mode == "cli"


def test_check_platform_mode_warns_on_windows_without_http(monkeypatch) -> None:
    monkeypatch.setattr(setup_doctor.sys, "platform", "win32", raising=False)

    result = setup_doctor.check_platform_mode({})

    assert result.status == "WARN"
    assert "Windows detected" in result.summary
    assert "AF_UNIX" in (result.detail or "")


def test_format_human_output_and_exit_code() -> None:
    results = [
        setup_doctor.CheckResult("python", "PASS", "ok"),
        setup_doctor.CheckResult("env", "FAIL", "missing", fix="do the thing"),
        setup_doctor.CheckResult("dns", "WARN", "not propagated yet", fix="wait"),
    ]

    output = setup_doctor.format_human_output(results)

    assert "Blocking issues (1):" in output
    assert "Warnings to fix next (1):" in output
    assert "Recommended next steps:" in output
    assert "Full check details:" in output
    assert "[PASS] python: ok" in output
    assert "[FAIL] env: missing" in output
    assert setup_doctor.summarize_exit_code(results) == 1


def test_recommended_next_steps_prioritize_bootstrap_and_config() -> None:
    results = [
        setup_doctor.CheckResult("venv", "FAIL", "missing"),
        setup_doctor.CheckResult("telegram_bot_token", "FAIL", "missing"),
        setup_doctor.CheckResult("mini_app_url", "FAIL", "missing"),
        setup_doctor.CheckResult("hermes_backend", "FAIL", "missing"),
        setup_doctor.CheckResult("dns", "WARN", "pending"),
        setup_doctor.CheckResult("platform_mode", "WARN", "windows guidance"),
    ]

    steps = setup_doctor.recommended_next_steps(results)

    assert any("scripts/setup.sh" in step for step in steps)
    assert any("TELEGRAM_BOT_TOKEN" in step for step in steps)
    assert any("MINI_APP_URL" in step for step in steps)
    assert any("HERMES_STREAM_URL" in step for step in steps)
    assert any("DNS" in step or "hostname" in step for step in steps)
    assert any("Windows" in step for step in steps)


def test_main_json_output(monkeypatch, capsys) -> None:
    fake_results = [
        setup_doctor.CheckResult("python", "PASS", "ok"),
        setup_doctor.CheckResult("dns", "WARN", "pending"),
    ]
    monkeypatch.setattr(setup_doctor, "run_checks", lambda _root: fake_results)

    exit_code = setup_doctor.main(["--json"])

    assert exit_code == 0
    payload = json.loads(capsys.readouterr().out)
    assert payload["results"][0]["key"] == "python"
    assert payload["results"][0]["status"] == "PASS"
    assert payload["summary"]["fail_count"] == 0
    assert payload["summary"]["warn_count"] == 1
    assert payload["summary"]["pass_count"] == 1
    assert payload["summary"]["next_steps"]
