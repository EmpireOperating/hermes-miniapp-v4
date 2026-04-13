from __future__ import annotations

import argparse
import shutil
import subprocess
import sys
import venv
from collections import OrderedDict
from pathlib import Path

MIN_PYTHON = (3, 11)
MIN_NODE_MAJOR = 20


def project_root() -> Path:
    return Path(__file__).resolve().parents[1]


def is_windows(platform_name: str | None = None) -> bool:
    name = platform_name if platform_name is not None else sys.platform
    return str(name).lower().startswith("win")


def venv_python_path(venv_dir: Path, *, platform_name: str | None = None) -> Path:
    if is_windows(platform_name):
        return venv_dir / "Scripts" / "python.exe"
    return venv_dir / "bin" / "python"


def python_version_supported(version_info: tuple[int, int] | None = None) -> bool:
    version = version_info if version_info is not None else (sys.version_info.major, sys.version_info.minor)
    return tuple(version) >= MIN_PYTHON


def detect_node_major(which: callable | None = None, run: callable | None = None) -> int | None:
    which = which or shutil.which
    run = run or subprocess.run
    node_path = which("node")
    if not node_path:
        return None
    try:
        completed = run(
            [node_path, "--version"],
            check=True,
            capture_output=True,
            text=True,
        )
    except Exception:
        return None
    output = (completed.stdout or completed.stderr or "").strip()
    if output.startswith("v"):
        output = output[1:]
    major_text = output.split(".", 1)[0].strip()
    try:
        return int(major_text)
    except ValueError:
        return None


def create_venv_if_missing(venv_dir: Path) -> bool:
    if venv_python_path(venv_dir).exists():
        return False
    builder = venv.EnvBuilder(with_pip=True)
    builder.create(str(venv_dir))
    return True


def install_requirements(venv_python: Path, root: Path, *, run: callable | None = None) -> None:
    run = run or subprocess.run
    run(
        [
            str(venv_python),
            "-m",
            "pip",
            "install",
            "-r",
            str(root / "requirements.txt"),
            "-r",
            str(root / "requirements-dev.txt"),
        ],
        check=True,
    )


def maybe_write_env(root: Path, *, write_env_if_missing: bool) -> str:
    env_path = root / ".env"
    example_path = root / ".env.example"
    if env_path.exists():
        return "existing"
    if not write_env_if_missing:
        return "skipped"
    env_path.write_text(example_path.read_text(encoding="utf-8"), encoding="utf-8")
    return "created"


def load_env_values(path: Path) -> OrderedDict[str, str]:
    values: OrderedDict[str, str] = OrderedDict()
    if not path.exists():
        return values
    for raw_line in path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        values[key.strip()] = value.strip()
    return values


def update_env_file(path: Path, updates: dict[str, str]) -> None:
    lines = path.read_text(encoding="utf-8").splitlines()
    remaining = OrderedDict((key, str(value)) for key, value in updates.items())
    rendered: list[str] = []
    for line in lines:
        stripped = line.strip()
        if not stripped or stripped.startswith("#") or "=" not in line:
            rendered.append(line)
            continue
        key, _value = line.split("=", 1)
        normalized_key = key.strip()
        if normalized_key in remaining:
            rendered.append(f"{normalized_key}={remaining.pop(normalized_key)}")
        else:
            rendered.append(line)
    if remaining:
        if rendered and rendered[-1] != "":
            rendered.append("")
        for key, value in remaining.items():
            rendered.append(f"{key}={value}")
    path.write_text("\n".join(rendered) + "\n", encoding="utf-8")


def prompt_text(prompt: str, *, default: str = "", input_fn: callable | None = None, output: callable | None = None) -> str:
    input_fn = input_fn or input
    output = output or print
    suffix = f" [{default}]" if default else ""
    response = input_fn(f"{prompt}{suffix}: ").strip()
    if response:
        return response
    return default


def prompt_choice(prompt: str, choices: list[tuple[str, str]], *, default: str, input_fn: callable | None = None, output: callable | None = None) -> str:
    input_fn = input_fn or input
    output = output or print
    output(prompt)
    for key, label in choices:
        marker = " (default)" if key == default else ""
        output(f"  {key}) {label}{marker}")
    while True:
        response = input_fn(f"Choose [{default}]: ").strip().lower()
        if not response:
            return default
        for key, _label in choices:
            if response == key:
                return key
        output("Please choose one of: " + ", ".join(key for key, _label in choices))


def should_run_interactive(args: argparse.Namespace) -> bool:
    if getattr(args, "interactive", False):
        return True
    if getattr(args, "non_interactive", False):
        return False
    return bool(getattr(sys.stdin, "isatty", lambda: False)() and getattr(sys.stdout, "isatty", lambda: False)())


def configure_env_interactively(
    root: Path,
    *,
    input_fn: callable | None = None,
    output: callable | None = None,
) -> dict[str, str]:
    input_fn = input_fn or input
    output = output or print
    env_path = root / ".env"
    values = load_env_values(env_path)
    output("")
    output("Interactive setup")
    output("- Press Enter to keep the current value shown in brackets.")
    output("- You can rerun this later with: python scripts/setup_bootstrap.py --interactive")
    output("")

    token_default = values.get("TELEGRAM_BOT_TOKEN", "")
    if token_default in {"***", '"***"', "replace-me", "your-token-here"}:
        token_default = ""
    token = prompt_text("Telegram bot token", default=token_default, input_fn=input_fn, output=output)

    url_default = values.get("MINI_APP_URL", "")
    if url_default == "https://your-domain.com/app":
        url_default = ""
    url = prompt_text(
        "Mini App HTTPS URL (the domain can be cheap; any domain/subdomain you control is fine)",
        default=url_default,
        input_fn=input_fn,
        output=output,
    )

    backend_choice = prompt_choice(
        "Choose the Hermes backend mode",
        [
            ("1", "Recommended: HERMES_STREAM_URL (best incremental streaming)"),
            ("2", "Recommended: HERMES_API_URL (simple HTTP-backed Hermes mode)"),
            ("3", "Local Hermes CLI/runtime on this machine"),
            ("4", "Skip backend configuration for now"),
        ],
        default="1",
        input_fn=input_fn,
        output=output,
    )

    updates: dict[str, str] = {}
    if token:
        updates["TELEGRAM_BOT_TOKEN"] = token
    if url:
        updates["MINI_APP_URL"] = url

    if backend_choice == "1":
        stream_default = values.get("HERMES_STREAM_URL", values.get("HERMES_API_URL", ""))
        stream_url = prompt_text("HERMES_STREAM_URL", default=stream_default, input_fn=input_fn, output=output)
        updates["HERMES_STREAM_URL"] = stream_url
        updates["HERMES_API_URL"] = ""
    elif backend_choice == "2":
        api_default = values.get("HERMES_API_URL", values.get("HERMES_STREAM_URL", ""))
        api_url = prompt_text("HERMES_API_URL", default=api_default, input_fn=input_fn, output=output)
        updates["HERMES_API_URL"] = api_url
        updates["HERMES_STREAM_URL"] = ""
    elif backend_choice == "3":
        cli_default = values.get("HERMES_CLI_COMMAND", "hermes") or "hermes"
        cli_command = prompt_text("HERMES_CLI_COMMAND", default=cli_default, input_fn=input_fn, output=output)
        updates["HERMES_CLI_COMMAND"] = cli_command or "hermes"
        updates["HERMES_STREAM_URL"] = ""
        updates["HERMES_API_URL"] = ""
    update_env_file(env_path, updates)
    return updates


def render_next_steps(root: Path, *, env_state: str, interactive_updates: dict[str, str] | None = None) -> str:
    lines = [
        "Setup complete.",
        "",
        "Next:",
    ]
    if env_state == "skipped":
        lines.append("1. .env was not created automatically. Re-run with --write-env-if-missing or copy .env.example to .env.")
        lines.append(f"2. Review {(root / '.env').name} and set TELEGRAM_BOT_TOKEN, MINI_APP_URL, and one Hermes backend path.")
        lines.append("3. Run: python scripts/setup_doctor.py")
        lines.append("4. Start the app: python server.py")
    elif interactive_updates:
        lines.append(f"1. Review {(root / '.env').name}; the bootstrap already filled the prompted values.")
        lines.append("2. Run: python scripts/setup_doctor.py")
        lines.append("3. Start the app: python server.py")
    else:
        lines.append(f"1. Review {(root / '.env').name} and set TELEGRAM_BOT_TOKEN, MINI_APP_URL, and one Hermes backend path.")
        lines.append("2. Run: python scripts/setup_doctor.py")
        lines.append("3. Start the app: python server.py")
    lines.extend([
        "",
        "DNS note:",
        "- MINI_APP_URL must be HTTPS for Telegram Mini Apps.",
        "- The domain name itself does not matter much; any domain or subdomain you control is fine.",
        "- If you do not already have one, the cheapest domain you can buy and control is usually good enough.",
    ])
    if env_state == "created":
        lines.insert(3, "   .env was created from .env.example.")
    return "\n".join(lines)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Bootstrap Hermes Mini App development setup.")
    parser.add_argument("--interactive", action="store_true", help="Prompt for initial .env values after bootstrap. Enabled automatically on a TTY unless --non-interactive is set.")
    parser.add_argument("--non-interactive", action="store_true", help="Disable prompts and leave .env editing to a later manual step.")
    parser.add_argument("--skip-node-check", action="store_true", help="Skip the Node.js version check.")
    parser.add_argument("--write-env-if-missing", action="store_true", help="Create .env from .env.example if .env does not exist.")
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    root = project_root()
    if not python_version_supported():
        print(f"ERROR: Python {MIN_PYTHON[0]}.{MIN_PYTHON[1]}+ is required.", file=sys.stderr)
        return 1

    if not args.skip_node_check:
        node_major = detect_node_major()
        if node_major is None:
            print("ERROR: Node.js 20+ is required for the frontend test suite. Install Node.js or rerun with --skip-node-check.", file=sys.stderr)
            return 1
        if node_major < MIN_NODE_MAJOR:
            print(f"ERROR: Node.js {MIN_NODE_MAJOR}+ is required; found {node_major}.", file=sys.stderr)
            return 1

    venv_dir = root / ".venv"
    created_venv = create_venv_if_missing(venv_dir)
    venv_python = venv_python_path(venv_dir)
    if not venv_python.exists():
        print(f"ERROR: expected virtualenv interpreter at {venv_python}", file=sys.stderr)
        return 1

    try:
        install_requirements(venv_python, root)
    except subprocess.CalledProcessError as exc:
        print(f"ERROR: dependency installation failed with exit code {exc.returncode}.", file=sys.stderr)
        return exc.returncode or 1

    env_state = maybe_write_env(root, write_env_if_missing=args.write_env_if_missing)
    interactive_updates: dict[str, str] | None = None
    if should_run_interactive(args):
        if env_state == "skipped":
            print("Interactive setup needs a .env file. Re-run with --write-env-if-missing or create .env first.", file=sys.stderr)
            return 1
        interactive_updates = configure_env_interactively(root)
    if created_venv:
        print(f"Created virtual environment at {venv_dir}")
    else:
        print(f"Using existing virtual environment at {venv_dir}")
    print(render_next_steps(root, env_state=env_state, interactive_updates=interactive_updates))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
