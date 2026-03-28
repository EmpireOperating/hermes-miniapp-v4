from __future__ import annotations

from functools import wraps
from typing import Any, Callable, ParamSpec, TypeVar


AuthErrorT = TypeVar("AuthErrorT")
RouteErrorT = TypeVar("RouteErrorT")
RouteResultT = TypeVar("RouteResultT")
P = ParamSpec("P")


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
    should_map_key_error_fn: Callable[[KeyError], bool] | None = None,
) -> tuple[int | None, RouteErrorT | None]:
    chat_id, payload_error = chat_id_from_payload_or_error_fn(payload, user_id=user_id)
    if payload_error:
        return None, map_chat_id_payload_error_fn(payload_error)

    try:
        set_active_chat_fn(int(chat_id))
    except KeyError as exc:
        if should_map_key_error_fn is not None and not should_map_key_error_fn(exc):
            raise
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


def request_payload_with_user_id_or_error(
    *,
    request_payload_fn: Callable[[], dict[str, object]],
    user_id_from_payload_or_error_fn: Callable[[dict[str, object]], tuple[str | None, RouteErrorT | None]],
) -> tuple[dict[str, object], str | None, RouteErrorT | None]:
    payload = request_payload_fn()
    user_id, auth_error = user_id_from_payload_or_error_fn(payload)
    if auth_error:
        return payload, None, auth_error
    return payload, user_id, None


def request_payload_with_user_and_chat_id_or_error(
    *,
    request_payload_fn: Callable[[], dict[str, object]],
    user_and_chat_id_from_payload_or_error_fn: Callable[
        [dict[str, object]], tuple[str | None, int | None, RouteErrorT | None]
    ],
) -> tuple[dict[str, object], str | None, int | None, RouteErrorT | None]:
    payload = request_payload_fn()
    user_id, chat_id, payload_error = user_and_chat_id_from_payload_or_error_fn(payload)
    if payload_error:
        return payload, None, None, payload_error
    return payload, user_id, chat_id, None


def guard_key_error_as_route_error(
    *,
    not_found_error_fn: Callable[[Exception], RouteErrorT],
    should_map_fn: Callable[[KeyError], bool] | None = None,
) -> Callable[[Callable[P, RouteResultT]], Callable[P, RouteResultT | RouteErrorT]]:
    def decorator(handler: Callable[P, RouteResultT]) -> Callable[P, RouteResultT | RouteErrorT]:
        @wraps(handler)
        def wrapped(*args: P.args, **kwargs: P.kwargs) -> RouteResultT | RouteErrorT:
            try:
                return handler(*args, **kwargs)
            except KeyError as exc:
                if should_map_fn is not None and not should_map_fn(exc):
                    raise
                return not_found_error_fn(exc)

        return wrapped

    return decorator


def guard_json_payload_user_route(
    *,
    request_payload_fn: Callable[[], dict[str, object]],
    user_id_from_payload_or_error_fn: Callable[[dict[str, object]], tuple[str | None, RouteErrorT | None]],
) -> Callable[[Callable[[dict[str, object], str], RouteResultT]], Callable[[], RouteResultT | RouteErrorT]]:
    def decorator(handler: Callable[[dict[str, object], str], RouteResultT]) -> Callable[[], RouteResultT | RouteErrorT]:
        @wraps(handler)
        def wrapped() -> RouteResultT | RouteErrorT:
            payload, user_id, auth_error = request_payload_with_user_id_or_error(
                request_payload_fn=request_payload_fn,
                user_id_from_payload_or_error_fn=user_id_from_payload_or_error_fn,
            )
            if auth_error:
                return auth_error
            return handler(payload, str(user_id))

        return wrapped

    return decorator


def guard_json_payload_user_chat_route(
    *,
    request_payload_fn: Callable[[], dict[str, object]],
    user_and_chat_id_from_payload_or_error_fn: Callable[
        [dict[str, object]], tuple[str | None, int | None, RouteErrorT | None]
    ],
) -> Callable[[Callable[[dict[str, object], str, int], RouteResultT]], Callable[[], RouteResultT | RouteErrorT]]:
    def decorator(
        handler: Callable[[dict[str, object], str, int], RouteResultT],
    ) -> Callable[[], RouteResultT | RouteErrorT]:
        @wraps(handler)
        def wrapped() -> RouteResultT | RouteErrorT:
            payload, user_id, chat_id, payload_error = request_payload_with_user_and_chat_id_or_error(
                request_payload_fn=request_payload_fn,
                user_and_chat_id_from_payload_or_error_fn=user_and_chat_id_from_payload_or_error_fn,
            )
            if payload_error:
                return payload_error
            return handler(payload, str(user_id), int(chat_id))

        return wrapped

    return decorator
