from pathlib import Path

from file_preview_eligibility import _parse_root_list, is_previewable_path, previewable_file_refs, resolve_preview_path


def test_parse_root_list_preserves_windows_drive_letter_paths() -> None:
    roots = _parse_root_list(r"C:\repo;D:\work")

    assert roots == [Path(r"C:\repo"), Path(r"D:\work")]



def test_resolve_preview_path_prefers_repo_context_for_repo_relative_and_basename_shorthand(tmp_path) -> None:
    allowed_root = tmp_path / "workspace"
    repo_root = allowed_root / "active" / "demo_repo"
    target = repo_root / "static" / "runtime_history_helpers.js"
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text("one\ntwo\nthree\n", encoding="utf-8")

    resolved_repo_relative = resolve_preview_path(
        "static/runtime_history_helpers.js",
        allowed_roots=[allowed_root],
        preferred_roots=[repo_root],
    )
    resolved_basename = resolve_preview_path(
        "runtime_history_helpers.js",
        allowed_roots=[allowed_root],
        preferred_roots=[repo_root],
    )

    assert resolved_repo_relative == target
    assert resolved_basename == target


def test_previewable_file_refs_include_repo_context_shorthand_refs(tmp_path, monkeypatch) -> None:
    allowed_root = tmp_path / "workspace"
    repo_root = allowed_root / "active" / "demo_repo"
    target = repo_root / "static" / "runtime_history_helpers.js"
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text("one\ntwo\nthree\n", encoding="utf-8")
    monkeypatch.setenv("MINI_APP_FILE_PREVIEW_ALLOWED_ROOTS", str(allowed_root))
    monkeypatch.setenv("MINI_APP_FILE_PREVIEW_CONTEXT_ROOTS", str(repo_root))

    refs = previewable_file_refs(
        "See static/runtime_history_helpers.js:2 and runtime_history_helpers.js:3",
        message_id=11,
    )

    assert [ref["path"] for ref in refs] == [
        "static/runtime_history_helpers.js",
        "runtime_history_helpers.js",
    ]
    assert [ref["line_start"] for ref in refs] == [2, 3]
    assert [ref["resolved_path"] for ref in refs] == [
        str(target),
        str(target),
    ]


def test_previewable_file_refs_skip_ambiguous_common_basename_shorthand_outside_context_root(tmp_path, monkeypatch) -> None:
    allowed_root = tmp_path / "workspace"
    miniapp_root = allowed_root / "active" / "hermes_miniapp_v4"
    freedom_mail_root = allowed_root / "active" / "freedom-mail"
    miniapp_readme = miniapp_root / "README.md"
    freedom_mail_readme = freedom_mail_root / "README.md"
    miniapp_readme.parent.mkdir(parents=True, exist_ok=True)
    freedom_mail_readme.parent.mkdir(parents=True, exist_ok=True)
    miniapp_readme.write_text("miniapp\n", encoding="utf-8")
    freedom_mail_readme.write_text("freedom mail\n", encoding="utf-8")
    monkeypatch.setenv("MINI_APP_FILE_PREVIEW_ALLOWED_ROOTS", str(allowed_root))
    monkeypatch.setenv("MINI_APP_FILE_PREVIEW_CONTEXT_ROOTS", str(miniapp_root))

    refs = previewable_file_refs(
        "Updated docs in README.md and active/freedom-mail/README.md",
        message_id=17,
    )

    assert [ref["path"] for ref in refs] == ["active/freedom-mail/README.md"]
    assert [ref["resolved_path"] for ref in refs] == [str(freedom_mail_readme)]


def test_is_previewable_path_rejects_ambiguous_basename_shorthand(tmp_path) -> None:
    allowed_root = tmp_path / "workspace"
    repo_root = allowed_root / "active" / "demo_repo"
    first = repo_root / "static" / "runtime_history_helpers.js"
    second = repo_root / "tests" / "runtime_history_helpers.js"
    first.parent.mkdir(parents=True, exist_ok=True)
    second.parent.mkdir(parents=True, exist_ok=True)
    first.write_text("one\n", encoding="utf-8")
    second.write_text("two\n", encoding="utf-8")

    assert not is_previewable_path(
        "runtime_history_helpers.js",
        allowed_roots=[allowed_root],
        preferred_roots=[repo_root],
    )


def test_is_previewable_path_rejects_basename_shorthand_ambiguous_outside_context_root(tmp_path) -> None:
    allowed_root = tmp_path / "workspace"
    miniapp_root = allowed_root / "active" / "hermes_miniapp_v4"
    freedom_mail_root = allowed_root / "active" / "freedom-mail"
    miniapp_readme = miniapp_root / "README.md"
    freedom_mail_readme = freedom_mail_root / "README.md"
    miniapp_readme.parent.mkdir(parents=True, exist_ok=True)
    freedom_mail_readme.parent.mkdir(parents=True, exist_ok=True)
    miniapp_readme.write_text("miniapp\n", encoding="utf-8")
    freedom_mail_readme.write_text("freedom mail\n", encoding="utf-8")

    assert not is_previewable_path(
        "README.md",
        allowed_roots=[allowed_root],
        preferred_roots=[miniapp_root],
    )
