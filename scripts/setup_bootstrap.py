from __future__ import annotations

import argparse
import shutil
import subprocess
import sys
import venv
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


def render_next_steps(root: Path, *, env_state: str) -> str:
    lines = [
        "Setup complete.",
        "",
        "Next:",
        f"1. Review {(root / '.env').name} and set TELEGRAM_BOT_TOKEN, MINI_APP_URL, and one Hermes backend path.",
        "2. Run: python scripts/setup_doctor.py",
        "3. Start the app: python server.py",
        "",
        "DNS note:",
        "- MINI_APP_URL must be HTTPS for Telegram Mini Apps.",
        "- The domain name itself does not matter much; any domain or subdomain you control is fine.",
        "- If you do not already have one, the cheapest domain you can buy and control is usually good enough.",
    ]
    if env_state == "skipped":
        lines.insert(3, "   .env was not created automatically. Re-run with --write-env-if-missing or copy .env.example to .env.")
    if env_state == "created":
        lines.insert(3, "   .env was created from .env.example.")
    return "\n".join(lines)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Bootstrap Hermes Mini App development setup.")
    parser.add_argument("--non-interactive", action="store_true", help="Reserved for automation; current bootstrap is already non-interactive.")
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
    if created_venv:
        print(f"Created virtual environment at {venv_dir}")
    else:
        print(f"Using existing virtual environment at {venv_dir}")
    print(render_next_steps(root, env_state=env_state))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
