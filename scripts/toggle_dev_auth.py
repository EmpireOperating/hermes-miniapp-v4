from __future__ import annotations

import argparse
import subprocess
import time
from datetime import UTC, datetime
from pathlib import Path


DEFAULT_ENV_PATH = Path(__file__).resolve().parents[1] / ".env"
DEFAULT_SERVICE = "hermes-miniapp-v4.service"
DEV_BYPASS_KEY = "MINIAPP_DEV_BYPASS"
DEV_BYPASS_EXPIRES_KEY = "MINIAPP_DEV_BYPASS_EXPIRES_AT"
DEFAULT_TTL_MINUTES = 15
STATUS_ACTIVE = "active"
STATUS_EXPIRED = "expired"
STATUS_DISABLED = "disabled"


def read_env_lines(path: Path) -> list[str]:
    return path.read_text(encoding="utf-8").splitlines()


def write_env_lines(path: Path, lines: list[str]) -> None:
    content = "\n".join(lines)
    if lines:
        content += "\n"
    path.write_text(content, encoding="utf-8")


def set_key(lines: list[str], key: str, value: str) -> list[str]:
    prefix = f"{key}="
    updated = False
    new_lines: list[str] = []
    for line in lines:
        if line.startswith(prefix):
            new_lines.append(f"{prefix}{value}")
            updated = True
        else:
            new_lines.append(line)
    if not updated:
        new_lines.append(f"{prefix}{value}")
    return new_lines


def remove_key(lines: list[str], key: str) -> list[str]:
    prefix = f"{key}="
    return [line for line in lines if not line.startswith(prefix)]


def get_key(lines: list[str], key: str) -> str:
    prefix = f"{key}="
    return next((line.split("=", 1)[1].strip() for line in lines if line.startswith(prefix)), "")


def restart_service(service: str) -> None:
    subprocess.run(["systemctl", "--user", "restart", service], check=True)


def format_expiry(epoch: int | None) -> str:
    if epoch is None:
        return "<none>"
    return datetime.fromtimestamp(epoch, tz=UTC).strftime("%Y-%m-%d %H:%M:%SZ")


def parse_expiry(raw: str) -> int | None:
    stripped = str(raw or "").strip()
    if not stripped:
        return None
    return int(stripped)


def get_status(*, current: str, expires_at: int | None, now: int) -> str:
    active = current == "1" and (expires_at is None or now < expires_at)
    if active:
        return STATUS_ACTIVE
    if current == "1" and expires_at is not None and now >= expires_at:
        return STATUS_EXPIRED
    return STATUS_DISABLED


def cleanup_expired(lines: list[str], *, now: int) -> tuple[list[str], bool]:
    current = get_key(lines, DEV_BYPASS_KEY)
    expires_at = parse_expiry(get_key(lines, DEV_BYPASS_EXPIRES_KEY))
    status = get_status(current=current, expires_at=expires_at, now=now)
    if status != STATUS_EXPIRED:
        return lines, False
    cleaned = set_key(lines, DEV_BYPASS_KEY, "0")
    cleaned = remove_key(cleaned, DEV_BYPASS_EXPIRES_KEY)
    return cleaned, True


def print_turn_off_warning(*, expires_at: int | None) -> None:
    print("WARNING: Dev auth is ENABLED for temporary debugging only.")
    print("TURN IT OFF WHEN DONE: python scripts/toggle_dev_auth.py off --restart")
    if expires_at is not None:
        print(f"It is scheduled to expire at {format_expiry(expires_at)}.")


def main() -> int:
    parser = argparse.ArgumentParser(description="Toggle Hermes Mini App dev auth bypass.")
    parser.add_argument(
        "state",
        choices=["on", "off", "status", "cleanup-expired"],
        help="Desired dev-auth bypass state.",
    )
    parser.add_argument("--env-file", default=str(DEFAULT_ENV_PATH), help="Path to the miniapp .env file.")
    parser.add_argument("--service", default=DEFAULT_SERVICE, help="systemd user service to restart.")
    parser.add_argument("--restart", action="store_true", help="Restart the miniapp service after updating the env file.")
    parser.add_argument(
        "--ttl-minutes",
        type=int,
        default=DEFAULT_TTL_MINUTES,
        help=f"Minutes until dev auth auto-expires when turning it on (default: {DEFAULT_TTL_MINUTES}).",
    )
    args = parser.parse_args()

    env_path = Path(args.env_file).expanduser().resolve()
    lines = read_env_lines(env_path)
    current = get_key(lines, DEV_BYPASS_KEY)
    expires_at = parse_expiry(get_key(lines, DEV_BYPASS_EXPIRES_KEY))
    now = int(time.time())
    status = get_status(current=current, expires_at=expires_at, now=now)

    if args.state == "status":
        print(f"{DEV_BYPASS_KEY}={current or '<unset>'}")
        print(f"{DEV_BYPASS_EXPIRES_KEY}={expires_at if expires_at is not None else '<unset>'}")
        print(f"status={status}")
        print(f"expires_at_utc={format_expiry(expires_at)}")
        if status == STATUS_ACTIVE:
            print_turn_off_warning(expires_at=expires_at)
        elif status == STATUS_EXPIRED:
            print("WARNING: Dev auth was left enabled long enough to expire.")
            print("Turn it off when convenient: python scripts/toggle_dev_auth.py off --restart")
            print("hint=run 'python scripts/toggle_dev_auth.py cleanup-expired --restart' to self-clean the expired config")
        return 0

    if args.state == "cleanup-expired":
        cleaned_lines, cleaned = cleanup_expired(lines, now=now)
        if cleaned:
            write_env_lines(env_path, cleaned_lines)
            expires_at = None
            status = STATUS_DISABLED
            print(f"Updated {env_path}: {DEV_BYPASS_KEY}=0")
            print(f"Removed {DEV_BYPASS_EXPIRES_KEY} from {env_path}")
            print("Expired dev auth config was cleaned up.")
        else:
            print(f"No cleanup needed; status={status}.")
        if args.restart and cleaned:
            restart_service(args.service)
            print(f"Restarted {args.service}")
        return 0

    if args.state == "on":
        if args.ttl_minutes <= 0:
            raise SystemExit("--ttl-minutes must be > 0")
        expires_at = now + (args.ttl_minutes * 60)
        lines = set_key(lines, DEV_BYPASS_KEY, "1")
        lines = set_key(lines, DEV_BYPASS_EXPIRES_KEY, str(expires_at))
        write_env_lines(env_path, lines)
        print(f"Updated {env_path}: {DEV_BYPASS_KEY}=1")
        print(f"Updated {env_path}: {DEV_BYPASS_EXPIRES_KEY}={expires_at} ({format_expiry(expires_at)})")
    else:
        lines = set_key(lines, DEV_BYPASS_KEY, "0")
        lines = remove_key(lines, DEV_BYPASS_EXPIRES_KEY)
        write_env_lines(env_path, lines)
        print(f"Updated {env_path}: {DEV_BYPASS_KEY}=0")
        print(f"Removed {DEV_BYPASS_EXPIRES_KEY} from {env_path}")
        expires_at = None

    if args.restart:
        restart_service(args.service)
        print(f"Restarted {args.service}")

    reveal_hint = "#dev-auth"
    if args.state == "on":
        print(
            "Dev auth is enabled but hidden until expiry. "
            f"Open /app{reveal_hint} to reveal the sign-in controls before {format_expiry(expires_at)}."
        )
        print_turn_off_warning(expires_at=expires_at)
    else:
        print("Dev auth is disabled. /api/dev/auth should return 404.")
        print("Default safe state: leave dev auth off unless you are actively debugging.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
