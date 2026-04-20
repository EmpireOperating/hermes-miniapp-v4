from __future__ import annotations

import pytest

from visual_dev_origin_policy import (
    assert_parent_origin_allowed,
    assert_preview_url_allowed,
    is_parent_origin_allowed,
    is_preview_url_allowed,
)


def test_preview_url_origin_is_allowed_after_normalization() -> None:
    allowed = {"https://preview.example.com", "https://cdn.example.com"}

    assert is_preview_url_allowed(" https://PREVIEW.example.com/app?x=1 ", allowed) is True
    assert is_preview_url_allowed("https://evil.example.com/app", allowed) is False


def test_assert_preview_url_allowed_returns_stripped_url() -> None:
    allowed = {"https://preview.example.com"}

    normalized_url = assert_preview_url_allowed(" https://preview.example.com/app/#/demo ", allowed)

    assert normalized_url == "https://preview.example.com/app/#/demo"


def test_assert_preview_url_allowed_rejects_invalid_url() -> None:
    with pytest.raises(ValueError, match="preview url"):
        assert_preview_url_allowed("notaurl", {"https://preview.example.com"})


def test_parent_origin_allowlist_uses_origin_normalization() -> None:
    allowed = {"https://miniapp.example.com", "https://ops.example.com"}

    assert is_parent_origin_allowed("https://MINIAPP.example.com/app", allowed) is True
    assert is_parent_origin_allowed("https://unknown.example.com", allowed) is False


def test_assert_parent_origin_allowed_rejects_untrusted_parent() -> None:
    with pytest.raises(ValueError, match="parent origin"):
        assert_parent_origin_allowed("https://unknown.example.com", {"https://miniapp.example.com"})
