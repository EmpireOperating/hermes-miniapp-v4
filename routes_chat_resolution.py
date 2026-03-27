from __future__ import annotations

from typing import Any, Callable, TypeVar


AuthErrorT = TypeVar("AuthErrorT")
RouteErrorT = TypeVar("RouteErrorT")


PayloadError = tuple[dict[str, object], int] | None


def verified_user_id_or_error(
    payload: dict[str, object],
    *,
    verify_fn: Callable[[dict[str, object]], tuple[Any | None, AuthErrorT | None]],
) -> tuple[str | None, AuthErrorT | None]:
    verified, auth_error = verify_fn(payload)
    if auth_error:
        return None, auth_error
    return str(verified.user.id), None


def active_chat_id_or_error(
    payload: dict[str, object],
    *,
    user_id: str,
    chat_id_from_payload_or_error_fn: Callable[[dict[str, object], str], tuple[int | None, PayloadError]],
    map_chat_id_payload_error_fn: Callable[[PayloadError], RouteErrorT],
    set_active_chat_fn: Callable[[int], None],
    not_found_error_fn: Callable[[Exception], RouteErrorT],
) -> tuple[int | None, RouteErrorT | None]:
    chat_id, payload_error = chat_id_from_payload_or_error_fn(payload, user_id=user_id)
    if payload_error:
        return None, map_chat_id_payload_error_fn(payload_error)

    try:
        set_active_chat_fn(int(chat_id))
    except KeyError as exc:
        return None, not_found_error_fn(exc)

    return int(chat_id), None


def user_and_chat_id_or_error(
    payload: dict[str, object],
    *,
    user_id_from_payload_or_error_fn: Callable[[dict[str, object]], tuple[str | None, RouteErrorT | None]],
    chat_id_from_payload_or_error_fn: Callable[[dict[str, object], str], tuple[int | None, PayloadError]],
    map_chat_id_payload_error_fn: Callable[[PayloadError], RouteErrorT],
) -> tuple[str | None, int | None, RouteErrorT | None]:
    user_id, auth_error = user_id_from_payload_or_error_fn(payload)
    if auth_error:
        return None, None, auth_error

    chat_id, chat_id_error = chat_id_from_payload_or_error_fn(payload, user_id=user_id)
    if chat_id_error:
        return None, None, map_chat_id_payload_error_fn(chat_id_error)

    return user_id, int(chat_id), None
