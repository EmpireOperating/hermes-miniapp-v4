from __future__ import annotations

import pytest

from validators import parse_bounded_int


def test_parse_bounded_int_returns_default_for_missing_value() -> None:
    value, error = parse_bounded_int({}, "limit", default=25, min_value=1, max_value=200)

    assert value == 25
    assert error is None


def test_parse_bounded_int_rejects_non_integer() -> None:
    value, error = parse_bounded_int({"limit": "abc"}, "limit", default=25, min_value=1, max_value=200)

    assert value is None
    assert error is not None
    assert error[1] == 400


def test_parse_bounded_int_rejects_out_of_range() -> None:
    value, error = parse_bounded_int({"limit": 0}, "limit", default=25, min_value=1, max_value=200)

    assert value is None
    assert error is not None
    assert "between" in error[0]["error"]
