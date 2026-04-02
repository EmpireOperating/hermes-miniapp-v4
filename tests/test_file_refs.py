from file_refs import extract_file_refs, parse_inline_path_ref


def test_extract_file_refs_supports_dotfiles_and_common_extensionless_files() -> None:
    refs = extract_file_refs("Check .env:2, Dockerfile:4, and Makefile.")
    assert [ref["raw_text"] for ref in refs] == [".env:2,", "Dockerfile:4,", "Makefile."]
    assert refs[0]["path"] == ".env"
    assert refs[0]["line_start"] == 2
    assert refs[1]["path"] == "Dockerfile"
    assert refs[1]["line_start"] == 4
    assert refs[2]["path"] == "Makefile"
    assert refs[2]["line_start"] == 0


def test_extract_file_refs_ignores_url_and_api_like_paths() -> None:
    refs = extract_file_refs(
        "Call https://example.com/static/app.js:12 and /api/chats/history before checking path/line notes."
    )
    assert refs == []


def test_parse_inline_path_ref_accepts_special_bare_files_with_line_hints() -> None:
    parsed = parse_inline_path_ref("README:12")
    assert parsed is not None
    assert parsed["path"] == "README"
    assert parsed["line_start"] == 12

    parsed = parse_inline_path_ref("./Dockerfile#L8-L12")
    assert parsed is not None
    assert parsed["path"] == "./Dockerfile"
    assert parsed["line_start"] == 8
    assert parsed["line_end"] == 12
