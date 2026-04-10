from __future__ import annotations

import re
from typing import Any

_CANDIDATE_PATTERN = re.compile(
    r"(?:(?:file://)?/(?:[^\s`<>\"'(){}\[\],;]+)|(?:~/|\.{1,2}/|[A-Za-z0-9._-]+(?:/[A-Za-z0-9._-]+)+))"
    r"(?::L?\d+(?::\d+)?(?:-(?:L)?\d+(?::\d+)?)?)?"
    r"(?:#L?\d+(?:-L?\d+)?)?"
    r"[\]),.;!?\"'`>]*",
    re.IGNORECASE,
)
_BARE_FILE_PATTERN = re.compile(
    r"(?:\b[A-Za-z0-9][A-Za-z0-9._-]*\.(?:py|js|mjs|cjs|ts|tsx|jsx|json|md|yaml|yml|toml|txt|sh|go|rs|java|c|cc|cpp|h|hpp|css|scss|html|htm|sql|ini|cfg|conf|env|lock|csv|tsv|log)"
    r"|(?<![A-Za-z0-9._-])\.[A-Za-z0-9][A-Za-z0-9._-]*"
    r"|\b(?:Dockerfile|Makefile|Procfile|Containerfile|Jenkinsfile|Vagrantfile|Brewfile|Gemfile|Rakefile|Justfile|Tiltfile|README|LICENSE)(?:\.[A-Za-z0-9._-]+)?)"
    r"(?::L?\d+(?::\d+)?(?:-(?:L)?\d+(?::\d+)?)?)?"
    r"(?:#L?\d+(?:-L?\d+)?)?"
    r"[\]),.;!?\"'`>]*",
    re.IGNORECASE,
)
_TRAILING_PUNCT = re.compile(r"^(.*?)([\]),.;!?\"'`>]+)?$")
_HASH_LINE_PATTERN = re.compile(r"^(.*)#L?(\d+)(?:-L?(\d+))?$", re.IGNORECASE)
_COLON_LINE_PATTERN = re.compile(r"^(.+?):L?(\d+)(?::\d+)?(?:-(?:L)?(\d+)(?::\d+)?)?$", re.IGNORECASE)
_SIMPLE_PATH_PATTERN = re.compile(r"^[A-Za-z0-9._-]+(?:/[A-Za-z0-9._-]+)+$")
_BARE_SIMPLE_FILE_PATTERN = re.compile(
    r"^(?:[A-Za-z0-9][A-Za-z0-9._-]*\.(?:py|js|mjs|cjs|ts|tsx|jsx|json|md|yaml|yml|toml|txt|sh|go|rs|java|c|cc|cpp|h|hpp|css|scss|html|htm|sql|ini|cfg|conf|env|lock|csv|tsv|log)|\.[A-Za-z0-9][A-Za-z0-9._-]*)$",
    re.IGNORECASE,
)
_SPECIAL_BARE_FILENAMES = {
    "dockerfile",
    "makefile",
    "procfile",
    "containerfile",
    "jenkinsfile",
    "vagrantfile",
    "brewfile",
    "gemfile",
    "rakefile",
    "justfile",
    "tiltfile",
    "readme",
    "license",
}
_SCHEME_PATTERN = re.compile(r"^[a-z][a-z0-9+.-]*$", re.IGNORECASE)


def _split_trailing_punctuation(raw_text: str) -> tuple[str, str]:
    match = _TRAILING_PUNCT.match(str(raw_text or ""))
    if not match:
        return str(raw_text or ""), ""
    return str(match.group(1) or ""), str(match.group(2) or "")


def _is_supported_bare_filename(value: str) -> bool:
    candidate = str(value or "").strip()
    if not candidate:
        return False
    if _BARE_SIMPLE_FILE_PATTERN.match(candidate):
        return True
    lowered = candidate.lower()
    if lowered in _SPECIAL_BARE_FILENAMES:
        return True
    prefix, dot, suffix = lowered.partition(".")
    return bool(dot and prefix in _SPECIAL_BARE_FILENAMES and suffix)


def _is_supported_inline_path(path_text: str, *, has_line_hint: bool = False) -> bool:
    candidate = str(path_text or "").strip()
    if not candidate:
        return False
    if "://" in candidate:
        return False
    if candidate.startswith("//"):
        return False

    def _basename_has_extension(value: str) -> bool:
        name = value.rsplit("/", 1)[-1]
        return _is_supported_bare_filename(name)

    if candidate.startswith("/"):
        return bool(has_line_hint or _basename_has_extension(candidate))
    if candidate.startswith("~/"):
        return bool(has_line_hint or _basename_has_extension(candidate)) and len(candidate) > 2
    if candidate.startswith("./"):
        return bool(has_line_hint or _basename_has_extension(candidate)) and len(candidate) > 2
    if candidate.startswith("../"):
        return bool(has_line_hint or _basename_has_extension(candidate)) and len(candidate) > 3
    if _SIMPLE_PATH_PATTERN.match(candidate):
        return bool(has_line_hint or _basename_has_extension(candidate))
    return _is_supported_bare_filename(candidate)


def parse_inline_path_ref(raw_text: str) -> dict[str, Any] | None:
    trimmed = str(raw_text or "").strip()
    if not trimmed:
        return None

    core, trailing = _split_trailing_punctuation(trimmed)
    path_part = core
    line_start = 0
    line_end = 0

    has_line_hint = False
    hash_match = _HASH_LINE_PATTERN.match(path_part)
    if hash_match:
        path_part = str(hash_match.group(1) or "")
        line_start = int(hash_match.group(2) or 0)
        line_end = int(hash_match.group(3) or 0)
        has_line_hint = True
    else:
        line_spec_match = _COLON_LINE_PATTERN.match(path_part)
        if line_spec_match:
            path_part = str(line_spec_match.group(1) or "")
            line_start = int(line_spec_match.group(2) or 0)
            line_end = int(line_spec_match.group(3) or 0)
            has_line_hint = True

    path = str(path_part or "").strip()
    if path.lower().startswith("file://"):
        path = path[7:]

    if not _is_supported_inline_path(path, has_line_hint=has_line_hint):
        return None

    return {
        "path": path,
        "line_start": max(0, int(line_start)),
        "line_end": max(0, int(line_end)),
        "trailing": trailing,
    }


def _is_likely_url_path_match(text: str, start_index: int) -> bool:
    if start_index <= 0:
        return False
    token_start = start_index
    while token_start > 0 and not str(text[token_start - 1]).isspace():
        token_start -= 1
    token_prefix = text[token_start:start_index]
    if "://" in token_prefix:
        return True
    if (
        start_index > 0
        and text[start_index - 1] == ":"
        and start_index + 1 < len(text)
        and text[start_index] == "/"
        and text[start_index + 1] == "/"
    ):
        return bool(_SCHEME_PATTERN.match(token_prefix))
    return False


def extract_file_refs(text: str, *, message_id: int | None = None) -> list[dict[str, Any]]:
    value = str(text or "")
    refs: list[dict[str, Any]] = []
    seen: set[tuple[int, str]] = set()

    has_path_signal = "/" in value or "\\" in value
    has_line_signal = ":" in value or "#" in value
    has_filename_signal = "." in value
    has_special_filename_signal = any(name in value for name in ("Dockerfile", "Makefile", "README", "LICENSE"))
    if not (has_path_signal or has_line_signal or has_filename_signal or has_special_filename_signal):
        return []

    candidates = list(_CANDIDATE_PATTERN.finditer(value)) + list(_BARE_FILE_PATTERN.finditer(value))
    candidates.sort(key=lambda match: (int(match.start()), -len(str(match.group(0) or ""))))

    for index, match in enumerate(candidates, start=1):
        raw = str(match.group(0) or "")
        start = int(match.start())
        if start > 0 and re.match(r"[A-Za-z0-9_./-]", value[start - 1]):
            continue
        if _is_likely_url_path_match(value, start):
            continue
        parsed = parse_inline_path_ref(raw)
        if not parsed:
            continue

        key = (start, raw)
        if key in seen:
            continue
        seen.add(key)

        ref_message_id = int(message_id or 0)
        ref_id = f"fr_{ref_message_id}_{index}" if ref_message_id > 0 else f"fr_0_{start}_{index}"
        refs.append(
            {
                "ref_id": ref_id,
                "raw_text": raw,
                "path": parsed["path"],
                "line_start": int(parsed["line_start"] or 0),
                "line_end": int(parsed["line_end"] or 0),
            }
        )

    return refs
