from __future__ import annotations

import argparse
import json
import shutil
import socket
import subprocess
import sys
from dataclasses import asdict, dataclass
from pathlib import Path
from urllib.parse import urlparse

MIN_PYTHON = (3, 11)
MIN_NODE_MAJOR = 20
PLACEHOLDER_TOKEN_VALUES = {"", "123456...e_me", "replace-me", "your-token-here"}


@dataclass
class CheckResult:
    key: str
    status: str
    summary: str
    detail: str | None = None
    fix: str | None = None


def summarize_by_status(results: list[CheckResult]) -> dict[str, list[CheckResult]]:
    grouped = {"FAIL": [], "WARN": [], "PASS": []}
    for result in results:
        grouped.setdefault(result.status, []).append(result)
    return grouped


def recommended_next_steps(results: list[CheckResult]) -> list[str]:
    grouped = summarize_by_status(results)
    failures = grouped.get("FAIL", [])
    warnings = grouped.get("WARN", [])
    steps: list[str] = []

    if any(result.key in {"venv", "dependencies", "env_file"} for result in failures):
        steps.append("Run scripts/setup.sh (or ./scripts/setup.ps1 on Windows) to create .venv, install dependencies, and write .env if missing.")
    if any(result.key == "telegram_bot_token" for result in failures):
        steps.append("Edit .env and set TELEGRAM_BOT_TOKEN to your real bot token.")
    if any(result.key == "mini_app_url" for result in failures):
        steps.append("Edit .env and set MINI_APP_URL to the exact HTTPS URL your Telegram bot will open.")
    if any(result.key == "hermes_backend" for result in failures):
        steps.append("Choose one Hermes backend path: HERMES_STREAM_URL, HERMES_API_URL, or explicit local Hermes agent/CLI settings.")
    if any(result.key == "dns" for result in warnings):
        steps.append("If MINI_APP_URL is set, point that hostname at your reverse proxy or tunnel and wait for DNS to propagate.")
    if any(result.key == "platform_mode" for result in failures + warnings):
        steps.append("If you are on Windows, open a WSL2 shell and run scripts/setup.sh there.")
    if not steps and not failures:
        steps.extend([
            "Setup looks good. Start the app with: .venv/bin/python server.py",
            "Verify local startup with: curl http://127.0.0.1:8080/health",
            "Once MINI_APP_URL DNS + HTTPS are live, run: scripts/setup.sh telegram",
            "Then open the Mini App from Telegram and send a message.",
        ])
    return steps


def project_root() -> Path:
    return Path(__file__).resolve().parents[1]


def is_windows(platform_name: str | None = None) -> bool:
    name = platform_name if platform_name is not None else sys.platform
    return str(name).lower().startswith("win")


def venv_python_path(venv_dir: Path, *, platform_name: str | None = None) -> Path:
    if is_windows(platform_name):
        return venv_dir / "Scripts" / "python.exe"
    return venv_dir / "bin" / "python"


def load_env_file(path: Path) -> dict[str, str]:
    values: dict[str, str] = {}
    if not path.exists():
        return values
    for raw_line in path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        values[key.strip()] = value.strip().strip('"').strip("'")
    return values


def detect_node_major(which: callable | None = None, run: callable | None = None) -> int | None:
    which = which or shutil.which
    run = run or subprocess.run
    node_path = which("node")
    if not node_path:
        return None
    try:
        completed = run([node_path, "--version"], check=True, capture_output=True, text=True)
    except Exception:
        return None
    output = (completed.stdout or completed.stderr or "").strip()
    if output.startswith("v"):
        output = output[1:]
    try:
        return int(output.split(".", 1)[0])
    except ValueError:
        return None


def check_python() -> CheckResult:
    version = (sys.version_info.major, sys.version_info.minor)
    if version >= MIN_PYTHON:
        return CheckResult("python", "PASS", f"Python {version[0]}.{version[1]} detected.")
    return CheckResult(
        "python",
        "FAIL",
        f"Python {MIN_PYTHON[0]}.{MIN_PYTHON[1]}+ is required.",
        detail=f"Current interpreter is {version[0]}.{version[1]}.",
        fix="Install Python 3.11+ and rerun the doctor with that interpreter.",
    )


def check_node() -> CheckResult:
    major = detect_node_major()
    if major is None:
        return CheckResult(
            "node",
            "FAIL",
            "Node.js was not found.",
            fix="Install Node.js 20+ so you can run the frontend test suite.",
        )
    if major < MIN_NODE_MAJOR:
        return CheckResult(
            "node",
            "FAIL",
            f"Node.js {major} detected; Node.js {MIN_NODE_MAJOR}+ is required.",
            fix="Upgrade Node.js to version 20 or newer.",
        )
    return CheckResult("node", "PASS", f"Node.js {major} detected.")


def check_venv(root: Path) -> CheckResult:
    venv_dir = root / ".venv"
    venv_python = venv_python_path(venv_dir)
    if not venv_dir.exists() or not venv_python.exists():
        return CheckResult(
            "venv",
            "FAIL",
            "Project virtual environment is missing.",
            detail=f"Expected interpreter at {venv_python}.",
            fix="Run: scripts/setup.sh",
        )
    return CheckResult("venv", "PASS", f"Virtual environment detected at {venv_dir}.")


def check_dependencies(root: Path) -> CheckResult:
    venv_python = venv_python_path(root / ".venv")
    if not venv_python.exists():
        return CheckResult(
            "dependencies",
            "FAIL",
            "Cannot verify dependencies because the project virtual environment is missing.",
            fix="Run: scripts/setup.sh",
        )
    try:
        subprocess.run(
            [str(venv_python), "-c", "import flask, requests, yaml, pytest"],
            check=True,
            capture_output=True,
            text=True,
        )
    except subprocess.CalledProcessError as exc:
        detail = (exc.stderr or exc.stdout or "").strip() or None
        return CheckResult(
            "dependencies",
            "FAIL",
            "One or more required Python packages are missing from .venv.",
            detail=detail,
            fix="Run: scripts/setup.sh",
        )
    return CheckResult("dependencies", "PASS", "Runtime and dev dependencies import correctly from .venv.")


def check_env_file(root: Path) -> CheckResult:
    env_path = root / ".env"
    if not env_path.exists():
        return CheckResult(
            "env_file",
            "FAIL",
            ".env is missing.",
            fix="Run: scripts/setup.sh",
        )
    return CheckResult("env_file", "PASS", f"Environment file detected at {env_path.name}.")


def check_telegram_bot_token(env_values: dict[str, str]) -> CheckResult:
    token = (env_values.get("TELEGRAM_BOT_TOKEN") or "").strip()
    if token and token not in PLACEHOLDER_TOKEN_VALUES and "..." not in token:
        return CheckResult("telegram_bot_token", "PASS", "TELEGRAM_BOT_TOKEN is set.")
    return CheckResult(
        "telegram_bot_token",
        "FAIL",
        "TELEGRAM_BOT_TOKEN is missing or still set to a placeholder value.",
        fix="Edit .env and set TELEGRAM_BOT_TOKEN to your real bot token.",
    )


def hostname_from_url(url: str) -> str | None:
    try:
        parsed = urlparse(url)
    except Exception:
        return None
    return parsed.hostname


def check_mini_app_url(env_values: dict[str, str]) -> CheckResult:
    url = (env_values.get("MINI_APP_URL") or "").strip()
    if not url:
        return CheckResult(
            "mini_app_url",
            "FAIL",
            "MINI_APP_URL is not set.",
            fix="Edit .env and set MINI_APP_URL to your Telegram-facing HTTPS URL.",
        )
    parsed = urlparse(url)
    if parsed.scheme != "https" or not parsed.netloc:
        return CheckResult(
            "mini_app_url",
            "FAIL",
            "MINI_APP_URL must be a full HTTPS URL.",
            detail=f"Current value: {url}",
            fix="Use an HTTPS URL on a domain or subdomain you control, for example https://miniapp.example.com/app",
        )
    return CheckResult(
        "mini_app_url",
        "PASS",
        "MINI_APP_URL is set to an HTTPS URL.",
        detail="The domain name itself does not need to be special; any domain or subdomain you control is fine.",
    )


def check_dns_resolution(env_values: dict[str, str]) -> CheckResult:
    url = (env_values.get("MINI_APP_URL") or "").strip()
    if not url:
        return CheckResult(
            "dns",
            "WARN",
            "Skipped DNS resolution because MINI_APP_URL is not set yet.",
            fix="Set MINI_APP_URL first, then rerun the doctor.",
        )
    host = hostname_from_url(url)
    if not host:
        return CheckResult(
            "dns",
            "WARN",
            "Skipped DNS resolution because MINI_APP_URL could not be parsed.",
            fix="Set MINI_APP_URL to a valid HTTPS URL, then rerun the doctor.",
        )
    try:
        socket.getaddrinfo(host, 443, proto=socket.IPPROTO_TCP)
    except Exception:
        return CheckResult(
            "dns",
            "WARN",
            f"Could not resolve {host} yet.",
            detail="This is expected until your DNS record exists and propagates.",
            fix="Point your domain or subdomain at your proxy/tunnel and wait for DNS to propagate.",
        )
    return CheckResult("dns", "PASS", f"DNS resolves for {host}.")


def _detect_local_backend(env_values: dict[str, str], *, which: callable | None = None) -> tuple[bool, str | None]:
    which = which or shutil.which
    if (env_values.get("HERMES_STREAM_URL") or "").strip():
        return True, "stream"
    if (env_values.get("HERMES_API_URL") or "").strip():
        return True, "api"
    for key in ("MINI_APP_AGENT_PYTHON", "MINI_APP_AGENT_WORKDIR", "MINI_APP_AGENT_VENV"):
        if (env_values.get(key) or "").strip():
            return True, "local-agent"
    cli_command = (env_values.get("HERMES_CLI_COMMAND") or "hermes").strip()
    if cli_command and which(cli_command):
        return True, "cli"
    return False, None


def check_hermes_backend(env_values: dict[str, str]) -> CheckResult:
    ok, mode = _detect_local_backend(env_values)
    if ok:
        return CheckResult("hermes_backend", "PASS", f"Hermes execution path detected ({mode}).")
    return CheckResult(
        "hermes_backend",
        "FAIL",
        "No Hermes execution path detected.",
        fix="Set HERMES_STREAM_URL or HERMES_API_URL, or configure a local Hermes Agent/CLI path.",
    )


def check_platform_mode(env_values: dict[str, str]) -> CheckResult:
    if not is_windows():
        return CheckResult("platform_mode", "PASS", f"Platform {sys.platform} is within the primary support path.")
    return CheckResult(
        "platform_mode",
        "FAIL",
        "Windows detected. Run Hermes Mini App under WSL2, not native Windows.",
        detail="Hermes Agent itself does not support a native Windows runtime path. If you are on Windows, use WSL2 for the Mini App setup and runtime, even when you plan to point the app at an HTTP-backed Hermes endpoint.",
        fix="Open a WSL2 shell and run scripts/setup.sh there.",
    )


def run_checks(root: Path) -> list[CheckResult]:
    env_values = load_env_file(root / ".env")
    return [
        check_python(),
        check_node(),
        check_venv(root),
        check_dependencies(root),
        check_env_file(root),
        check_telegram_bot_token(env_values),
        check_mini_app_url(env_values),
        check_dns_resolution(env_values),
        check_hermes_backend(env_values),
        check_platform_mode(env_values),
    ]


def summarize_exit_code(results: list[CheckResult]) -> int:
    return 1 if any(result.status == "FAIL" for result in results) else 0


def format_human_output(results: list[CheckResult]) -> str:
    grouped = summarize_by_status(results)
    failures = grouped.get("FAIL", [])
    warnings = grouped.get("WARN", [])

    lines = ["Hermes Mini App setup doctor", ""]
    if failures:
        lines.append(f"Blocking issues ({len(failures)}):")
        for result in failures:
            lines.append(f"- {result.key}: {result.summary}")
        lines.append("")
    else:
        lines.append("Blocking issues: none")
        lines.append("")

    if warnings:
        lines.append(f"Warnings to fix next ({len(warnings)}):")
        for result in warnings:
            lines.append(f"- {result.key}: {result.summary}")
        lines.append("")
    else:
        lines.append("Warnings to fix next: none")
        lines.append("")

    lines.append("Recommended next steps:")
    for index, step in enumerate(recommended_next_steps(results), start=1):
        lines.append(f"{index}. {step}")
    lines.append("")
    lines.append("Full check details:")
    for result in results:
        lines.append(f"[{result.status}] {result.key}: {result.summary}")
        if result.detail:
            lines.append(f"        detail: {result.detail}")
        if result.fix:
            lines.append(f"        fix: {result.fix}")
    return "\n".join(lines)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Validate Hermes Mini App setup.")
    parser.add_argument("--json", action="store_true", help="Emit machine-readable JSON output.")
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    results = run_checks(project_root())
    if args.json:
        grouped = summarize_by_status(results)
        print(json.dumps({
            "results": [asdict(result) for result in results],
            "summary": {
                "fail_count": len(grouped.get("FAIL", [])),
                "warn_count": len(grouped.get("WARN", [])),
                "pass_count": len(grouped.get("PASS", [])),
                "next_steps": recommended_next_steps(results),
            },
        }, indent=2))
    else:
        print(format_human_output(results))
    return summarize_exit_code(results)


if __name__ == "__main__":
    raise SystemExit(main())
