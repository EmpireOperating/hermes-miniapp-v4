#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import subprocess
import sys
from pathlib import Path
from typing import Any

DEFAULT_REPO = "EmpireOperating/hermes-miniapp-v4"
DEFAULT_STATE_FILE = Path.home() / ".local" / "state" / "hermes-miniapp-v4" / "github_notifications.json"


def run_gh(args: list[str]) -> Any:
    proc = subprocess.run(["gh", *args], check=False, capture_output=True, text=True)
    if proc.returncode != 0:
        raise SystemExit(proc.stderr.strip() or f"gh {' '.join(args)} failed")
    return json.loads(proc.stdout or "[]")


def normalize_reason(reason: str) -> str:
    return reason.replace("_", " ")


def load_state(path: Path) -> dict[str, Any]:
    if not path.exists():
        return {"seen": {}, "repo": DEFAULT_REPO}
    try:
        return json.loads(path.read_text())
    except json.JSONDecodeError:
        return {"seen": {}, "repo": DEFAULT_REPO}


def save_state(path: Path, state: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(state, indent=2, sort_keys=True) + "\n")


def notification_key(item: dict[str, Any]) -> str:
    return str(item.get("id", ""))


def notification_updated_at(item: dict[str, Any]) -> str:
    return str(item.get("updated_at", ""))


def human_summary(item: dict[str, Any]) -> str:
    subject = item.get("subject", {})
    return f"[{subject.get('type', 'Unknown')}] {subject.get('title', '(no title)')} ({normalize_reason(item.get('reason', 'notification'))})"


def emit_notify(repo: str, new_items: list[dict[str, Any]]) -> None:
    lines = [human_summary(item) for item in new_items[:5]]
    if len(new_items) > 5:
        lines.append(f"…and {len(new_items) - 5} more")
    subprocess.run(
        [
            "notify-send",
            f"GitHub activity: {repo}",
            "\n".join(lines),
            "--app-name=GitHub Watch",
            "--expire-time=15000",
        ],
        check=False,
    )


def main() -> int:
    parser = argparse.ArgumentParser(description="Check GitHub notifications for a repo.")
    parser.add_argument("--repo", default=DEFAULT_REPO, help="owner/repo to check")
    parser.add_argument("--all", action="store_true", help="include read notifications")
    parser.add_argument("--json", action="store_true", help="emit machine-readable JSON")
    parser.add_argument("--state-file", type=Path, default=DEFAULT_STATE_FILE, help="state file for seen notifications")
    parser.add_argument("--notify", action="store_true", help="send desktop notifications for new matching activity")
    parser.add_argument("--baseline", action="store_true", help="store current matching activity without alerting")
    parser.add_argument("--include-ci", action="store_true", help="include ci_activity notifications")
    args = parser.parse_args()

    query = f"?participating=false&per_page=50{'&all=true' if args.all else ''}"
    notifications = run_gh(["api", f"notifications{query}"])
    repo_notifications = [n for n in notifications if n.get("repository", {}).get("full_name") == args.repo]
    matching_notifications = [
        n for n in repo_notifications
        if args.include_ci or n.get("reason") != "ci_activity"
    ]

    prior_state = load_state(args.state_file)
    seen = dict(prior_state.get("seen", {}))
    current_seen = {notification_key(item): notification_updated_at(item) for item in matching_notifications}
    new_items = [item for item in matching_notifications if seen.get(notification_key(item)) != notification_updated_at(item)]

    if args.baseline:
        save_state(args.state_file, {"repo": args.repo, "seen": current_seen})
        print(f"Baselined {len(current_seen)} notifications for {args.repo} at {args.state_file}")
        return 0

    if args.notify and new_items:
        emit_notify(args.repo, new_items)

    save_state(args.state_file, {"repo": args.repo, "seen": current_seen})

    unread = [n for n in matching_notifications if n.get("unread")]
    payload = {
        "repo": args.repo,
        "matching_count": len(matching_notifications),
        "unread_count": len(unread),
        "new_count": len(new_items),
        "new": new_items,
        "state_file": str(args.state_file),
        "ignored_ci": not args.include_ci,
    }

    if args.json:
        print(json.dumps(payload, indent=2))
        return 0

    print(f"Repo: {args.repo}")
    print(f"Matching notifications: {len(matching_notifications)}")
    print(f"Unread notifications: {len(unread)}")
    print(f"New since last check: {len(new_items)}")
    print(f"State file: {args.state_file}")
    if not matching_notifications:
        print("No matching notifications for this repo.")
        return 0
    for item in new_items or matching_notifications:
        print(f"- {human_summary(item)}")
        print(f"  unread: {item.get('unread')} | updated: {item.get('updated_at', '')}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
