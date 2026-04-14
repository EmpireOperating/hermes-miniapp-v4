#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import subprocess
import sys
from typing import Any


def run_gh(args: list[str]) -> Any:
    proc = subprocess.run([
        "gh",
        *args,
    ], check=False, capture_output=True, text=True)
    if proc.returncode != 0:
        raise SystemExit(proc.stderr.strip() or f"gh {' '.join(args)} failed")
    return json.loads(proc.stdout or "[]")


def normalize_reason(reason: str) -> str:
    return reason.replace("_", " ")


def main() -> int:
    parser = argparse.ArgumentParser(description="Check unread GitHub notifications for a repo.")
    parser.add_argument("--repo", default="EmpireOperating/hermes-miniapp-v4", help="owner/repo to check")
    parser.add_argument("--all", action="store_true", help="include read notifications")
    parser.add_argument("--json", action="store_true", help="emit machine-readable JSON")
    args = parser.parse_args()

    query = f"?participating=false&per_page=50{'&all=true' if args.all else ''}"
    notifications = run_gh(["api", f"notifications{query}"])
    repo_notifications = [n for n in notifications if n.get("repository", {}).get("full_name") == args.repo]

    if args.json:
        print(json.dumps(repo_notifications, indent=2))
        return 0

    unread = [n for n in repo_notifications if n.get("unread")]
    print(f"Repo: {args.repo}")
    print(f"Unread notifications: {len(unread)}")
    if not repo_notifications:
        print("No notifications for this repo.")
        return 0

    for item in unread or repo_notifications:
        subject = item.get("subject", {})
        reason = normalize_reason(item.get("reason", "notification"))
        title = subject.get("title", "(no title)")
        type_name = subject.get("type", "Unknown")
        updated_at = item.get("updated_at", "")
        print(f"- [{type_name}] {title}")
        print(f"  reason: {reason} | unread: {item.get('unread')} | updated: {updated_at}")
        latest = item.get("last_read_at")
        if latest:
            print(f"  last_read_at: {latest}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
