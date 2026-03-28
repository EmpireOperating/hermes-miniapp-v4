from __future__ import annotations

import ast
from pathlib import Path


TARGET_FILES = (
    "hermes_client.py",
    "hermes_client_agent.py",
    "hermes_client_agent_direct.py",
    "hermes_client_agent_persistent.py",
    "job_runtime.py",
    "server.py",
)
POLICY_TAG = "broad-except-policy:"
LOG_MARKERS = ("logger.", "LOGGER.", "_record_best_effort_failure(")


def _iter_broad_exception_handlers(path: Path):
    source = path.read_text(encoding="utf-8")
    tree = ast.parse(source, filename=str(path))
    lines = source.splitlines()

    for node in ast.walk(tree):
        if not isinstance(node, ast.ExceptHandler):
            continue

        catches_exception = isinstance(node.type, ast.Name) and node.type.id == "Exception"
        catches_bare = node.type is None
        if not (catches_exception or catches_bare):
            continue

        lineno = int(node.lineno)
        end_lineno = int(getattr(node, "end_lineno", lineno))
        except_line = lines[lineno - 1] if lineno - 1 < len(lines) else ""
        previous_line = lines[lineno - 2] if lineno - 2 >= 0 else ""

        policy_line = ""
        if POLICY_TAG in except_line:
            policy_line = except_line
        elif POLICY_TAG in previous_line:
            policy_line = previous_line

        handler_span = "\n".join(lines[lineno - 1 : end_lineno])
        has_logging = any(marker in handler_span for marker in LOG_MARKERS)
        allows_intentional_no_log = "intentional-no-log" in policy_line

        yield {
            "path": str(path),
            "lineno": lineno,
            "except_line": except_line.strip(),
            "has_policy": bool(policy_line),
            "has_logging": has_logging,
            "allows_intentional_no_log": allows_intentional_no_log,
        }


def test_broad_exception_handlers_require_policy_and_observability():
    violations: list[str] = []

    for file_name in TARGET_FILES:
        path = Path(file_name)
        for handler in _iter_broad_exception_handlers(path):
            location = f"{handler['path']}:{handler['lineno']}"

            if not handler["has_policy"]:
                violations.append(
                    f"{location} missing '{POLICY_TAG}' justification: {handler['except_line']}"
                )
                continue

            if not handler["has_logging"] and not handler["allows_intentional_no_log"]:
                violations.append(
                    f"{location} broad exception must log/record failure or declare intentional-no-log"
                )

    assert not violations, "\n" + "\n".join(violations)
