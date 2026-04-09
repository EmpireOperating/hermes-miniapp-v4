     1|from __future__ import annotations
     2|
     3|import atexit
     4|import json
     5|import os
     6|import queue
     7|import time
     8|from pathlib import Path
     9|
    10|from flask import Flask, Response, g, request
    11|
    12|from app_factory import create_flask_app, create_runtime_dependencies
    13|from assets import asset_version, dev_reload_version
    14|from auth import TelegramAuthError, verify_telegram_init_data
    15|from auth_session import verify_from_payload as auth_verify_from_payload
    16|from blueprints import create_api_blueprint, create_public_blueprint
    17|from hermes_client import HermesClient
    18|from miniapp_config import MiniAppConfig, normalize_origin
    19|from request_context import (
    20|    json_user_id_or_error as request_json_user_id_or_error,
    21|    verify_for_json as request_verify_for_json,
    22|    verify_for_sse as request_verify_for_sse,
    23|    sse_user_id_or_error as request_sse_user_id_or_error,
    24|)
    25|from request_guards import enforce_api_request_guards
    26|from request_logging import build_job_log, build_request_log, new_request_id, now_ms, sanitized_request_target
    27|from routes_auth import register_auth_routes
    28|from routes_chat import register_chat_routes
    29|from routes_chat_context import ChatRouteContext
    30|from routes_jobs_runtime import register_jobs_runtime_routes
    31|from routes_meta import register_meta_routes
    32|from security_headers import apply_security_headers, generate_csp_nonce
    33|from server_public_routes import register_public_routes
    34|from server_request_adapters import build_server_request_adapters
    35|from server_startup import log_startup_diagnostics, startup_diagnostics_payload
    36|from store import ChatThread, SessionStore
    37|from validators import parse_chat_id, validate_message, validate_title
    38|
    39|BASE_DIR = Path(__file__).resolve().parent
    40|SESSION_STORE_PATH = Path(os.environ.get("MINI_APP_SESSION_STORE_PATH") or (BASE_DIR / "sessions.db"))
    41|
    42|_previous_runtime = globals().get("runtime")
    43|if _previous_runtime is not None:
    44|    shutdown_previous_runtime = getattr(_previous_runtime, "shutdown", None)
    45|    if callable(shutdown_previous_runtime):
    46|        try:
    47|            shutdown_previous_runtime(reason="module_reload", join_timeout=2.0)
    48|        except Exception:  # noqa: BLE001 - broad-except-policy: intentional-no-log module-reload cleanup must never block startup
    49|            pass
    50|
    51|_previous_runtime_atexit = globals().get("_shutdown_runtime_at_exit")
    52|if callable(_previous_runtime_atexit):
    53|    try:
    54|        atexit.unregister(_previous_runtime_atexit)
    55|    except Exception:  # noqa: BLE001 - broad-except-policy: intentional-no-log module-reload cleanup must never block startup
    56|        pass
    57|
CONFIG = MiniAppConfig.from_env()
BOT_TOKEN = os.environ.get("TELEGRAM_BOT_TOKEN", "")
PORT = CONFIG.port
DEBUG = CONFIG.debug
DEV_RELOAD = CONFIG.dev_reload
ALLOWED_SKINS = {"terminal", "oracle", "obsidian"}
SKIN_COOKIE_NAME = "hermes_skin"
AUTH_COOKIE_NAME = "hermes_auth_session"
AUTH_SESSION_MAX_AGE_SECONDS = CONFIG.auth_session_max_age_seconds
MAX_MESSAGE_LEN = CONFIG.max_message_len
MAX_TITLE_LEN = CONFIG.max_title_len
ASSISTANT_CHUNK_LEN = CONFIG.assistant_chunk_len
ASSISTANT_HARD_LIMIT = CONFIG.assistant_hard_limit
DEV_RELOAD_INTERVAL_MS = CONFIG.dev_reload_interval_ms
JOB_MAX_ATTEMPTS = CONFIG.job_max_attempts
JOB_RETRY_BASE_SECONDS = CONFIG.job_retry_base_seconds
JOB_WORKER_CONCURRENCY = CONFIG.job_worker_concurrency
JOB_WORKER_LAUNCHER = CONFIG.job_worker_launcher
JOB_WORKER_SUBPROCESS_TIMEOUT_SECONDS = CONFIG.job_worker_subprocess_timeout_seconds
JOB_WORKER_SUBPROCESS_KILL_GRACE_SECONDS = CONFIG.job_worker_subprocess_kill_grace_seconds
JOB_WORKER_SUBPROCESS_STDERR_EXCERPT_BYTES = CONFIG.job_worker_subprocess_stderr_excerpt_bytes
JOB_WORKER_SUBPROCESS_MEMORY_LIMIT_MB = CONFIG.job_worker_subprocess_memory_limit_mb
JOB_WORKER_SUBPROCESS_MAX_TASKS = CONFIG.job_worker_subprocess_max_tasks
JOB_WORKER_SUBPROCESS_MAX_OPEN_FILES = CONFIG.job_worker_subprocess_max_open_files
PERSISTENT_RUNTIME_OWNERSHIP = CONFIG.resolved_persistent_runtime_ownership()
JOB_STALL_TIMEOUT_SECONDS = CONFIG.job_stall_timeout_seconds
TELEGRAM_INIT_DATA_MAX_AGE_SECONDS = CONFIG.telegram_init_data_max_age_seconds
TRUST_PROXY_HEADERS = CONFIG.trust_proxy_headers
FORCE_SECURE_COOKIES = CONFIG.force_secure_cookies
ALLOWED_ORIGINS = CONFIG.allowed_origins
ENFORCE_ORIGIN_CHECK = CONFIG.enforce_origin_check
RATE_LIMIT_WINDOW_SECONDS = CONFIG.rate_limit_window_seconds
RATE_LIMIT_API_REQUESTS = CONFIG.rate_limit_api_requests
RATE_LIMIT_STREAM_REQUESTS = CONFIG.rate_limit_stream_requests
ENABLE_HSTS = CONFIG.enable_hsts
OPERATOR_DEBUG = CONFIG.operator_debug
REQUEST_DEBUG = CONFIG.request_debug
STREAM_TIMING_DEBUG = CONFIG.stream_timing_debug
DEV_AUTH_SECRET = CONFIG.dev_auth_secret
JOB_EVENT_HISTORY_MAX_JOBS = CONFIG.job_event_history_max_jobs
JOB_EVENT_HISTORY_TTL_SECONDS = CONFIG.job_event_history_ttl_seconds
DEV_RELOAD_WATCH_PATHS = CONFIG.dev_reload_watch_paths

STATIC_NO_STORE_FILENAMES = {
   101|    "app.js",
   102|    "app.css",
   103|    "runtime_helpers.js",
   104|    "app_shared_utils.js",
   105|    "chat_ui_helpers.js",
   106|    "chat_tabs_helpers.js",
   107|    "message_actions_helpers.js",
   108|    "stream_state_helpers.js",
   109|    "stream_controller.js",
   110|    "composer_state_helpers.js",
   111|    "keyboard_shortcuts_helpers.js",
   112|    "interaction_helpers.js",
   113|    "bootstrap_auth_helpers.js",
   114|    "chat_history_helpers.js",
   115|    "chat_admin_helpers.js",
   116|    "shell_ui_helpers.js",
   117|    "composer_viewport_helpers.js",
   118|    "visibility_skin_helpers.js",
   119|    "startup_bindings_helpers.js",
   120|    "startup_metrics_helpers.js",
   121|    "render_trace_text_helpers.js",
   122|    "render_trace_debug_helpers.js",
   123|    "render_trace_message_helpers.js",
   124|    "render_trace_history_helpers.js",
   125|    "render_trace_helpers.js",
   126|    "file_preview_helpers.js",
   127|}
   128|STATIC_NO_STORE_PATHS = {f"/static/{name}" for name in STATIC_NO_STORE_FILENAMES}
   129|
   130|
   131|def _file_preview_allowed_roots() -> tuple[str, ...]:
   132|    raw = str(os.environ.get("MINI_APP_FILE_PREVIEW_ALLOWED_ROOTS", "")).strip()
   133|    if not raw:
   134|        return ()
   135|    roots: list[str] = []
   136|    for chunk in raw.split(os.pathsep):
   137|        candidate = str(chunk or "").strip()
   138|        if not candidate:
   139|            continue
   140|        roots.append(candidate)
   141|    return tuple(roots)
   142|
   143|
   144|def _file_preview_enabled(allowed_roots: tuple[str, ...]) -> bool:
   145|    raw = os.environ.get("MINI_APP_FILE_PREVIEW_ENABLED")
   146|    if raw is None:
   147|        # Backward-compatible default: keep preview enabled when allowed roots are configured.
   148|        return bool(allowed_roots)
   149|    return str(raw).strip().lower() in {"1", "true", "yes", "on"}
   150|
   151|
   152|app: Flask = create_flask_app(
   153|    base_dir=BASE_DIR,
   154|    trust_proxy_headers=TRUST_PROXY_HEADERS,
   155|    max_content_length=CONFIG.max_content_length,
   156|    debug=DEBUG,
   157|    dev_reload=DEV_RELOAD,
   158|)
   159|app.logger.setLevel("INFO")
   160|
   161|
   162|@app.before_request
   163|def _log_request_debug() -> None:
   164|    if not REQUEST_DEBUG:
   165|        return
   166|    try:
   167|        app.logger.info(
   168|            "miniapp req method=%s path=%s host=%s ua=%s",
   169|            request.method,
   170|            sanitized_request_target(request),
   171|            request.host,
   172|            request.headers.get("User-Agent", "")[:160],
   173|        )
   174|    except Exception:  # noqa: BLE001 - broad-except-policy: intentional-no-log module-reload cleanup must never block startup  # noqa: BLE001 - broad-except-policy: intentional-no-log debug instrumentation must never block requests
   175|        pass
   176|
   177|
   178|public_bp = create_public_blueprint()
   179|api_bp = create_api_blueprint()
   180|
   181|
   182|def _create_client_with_resolved_ownership() -> HermesClient:
   183|    previous = os.environ.get("MINI_APP_PERSISTENT_RUNTIME_OWNERSHIP")
   184|    previous_requested = os.environ.get("MINI_APP_PERSISTENT_RUNTIME_OWNERSHIP_REQUESTED")
   185|    os.environ["MINI_APP_PERSISTENT_RUNTIME_OWNERSHIP_REQUESTED"] = str(CONFIG.persistent_runtime_ownership or "auto")
   186|    os.environ["MINI_APP_PERSISTENT_RUNTIME_OWNERSHIP"] = PERSISTENT_RUNTIME_OWNERSHIP
   187|    try:
   188|        return HermesClient()
   189|    finally:
   190|        if previous is None:
   191|            os.environ.pop("MINI_APP_PERSISTENT_RUNTIME_OWNERSHIP", None)
   192|        else:
   193|            os.environ["MINI_APP_PERSISTENT_RUNTIME_OWNERSHIP"] = previous
   194|        if previous_requested is None:
   195|            os.environ.pop("MINI_APP_PERSISTENT_RUNTIME_OWNERSHIP_REQUESTED", None)
   196|        else:
   197|            os.environ["MINI_APP_PERSISTENT_RUNTIME_OWNERSHIP_REQUESTED"] = previous_requested
   198|
   199|
   200|client = _create_client_with_resolved_ownership()
   201|store = SessionStore(SESSION_STORE_PATH)
   202|
   203|
   204|
   205|def _session_id_for(user_id: str, chat_id: int) -> str:
   206|    return f"miniapp-{user_id}-{chat_id}"
   207|
   208|
   209|JOB_MAX_ATTEMPTS = globals().get("JOB_MAX_ATTEMPTS", CONFIG.job_max_attempts)
   210|JOB_RETRY_BASE_SECONDS = globals().get("JOB_RETRY_BASE_SECONDS", CONFIG.job_retry_base_seconds)
   211|ASSISTANT_CHUNK_LEN = globals().get("ASSISTANT_CHUNK_LEN", CONFIG.assistant_chunk_len)
   212|ASSISTANT_HARD_LIMIT = globals().get("ASSISTANT_HARD_LIMIT", CONFIG.assistant_hard_limit)
   213|
   214|_RUNTIME_DEPS = create_runtime_dependencies(
   215|    store_getter=lambda: store,
   216|    client_getter=lambda: client,
   217|    job_max_attempts=JOB_MAX_ATTEMPTS,
   218|    job_retry_base_seconds=JOB_RETRY_BASE_SECONDS,
   219|    job_worker_concurrency=JOB_WORKER_CONCURRENCY,
   220|    job_worker_launcher_mode=JOB_WORKER_LAUNCHER,
   221|    job_worker_subprocess_timeout_seconds=JOB_WORKER_SUBPROCESS_TIMEOUT_SECONDS,
   222|    job_worker_subprocess_kill_grace_seconds=JOB_WORKER_SUBPROCESS_KILL_GRACE_SECONDS,
   223|    job_worker_subprocess_stderr_excerpt_bytes=JOB_WORKER_SUBPROCESS_STDERR_EXCERPT_BYTES,
   224|    job_worker_subprocess_memory_limit_mb=JOB_WORKER_SUBPROCESS_MEMORY_LIMIT_MB,
   225|    job_worker_subprocess_max_tasks=JOB_WORKER_SUBPROCESS_MAX_TASKS,
   226|    job_worker_subprocess_max_open_files=JOB_WORKER_SUBPROCESS_MAX_OPEN_FILES,
   227|    job_stall_timeout_seconds=JOB_STALL_TIMEOUT_SECONDS,
   228|    assistant_chunk_len=ASSISTANT_CHUNK_LEN,
   229|    assistant_hard_limit=ASSISTANT_HARD_LIMIT,
   230|    job_event_history_max_jobs=JOB_EVENT_HISTORY_MAX_JOBS,
   231|    job_event_history_ttl_seconds=JOB_EVENT_HISTORY_TTL_SECONDS,
   232|    session_id_builder=_session_id_for,
   233|)
   234|runtime = _RUNTIME_DEPS.runtime
   235|_JOB_WAKE_EVENT = runtime.wake_event
   236|_RATE_LIMITER = _RUNTIME_DEPS.rate_limiter
   237|
   238|
   239|def _cookie_secure() -> bool:
   240|    if FORCE_SECURE_COOKIES:
   241|        return True
   242|    return bool(request.is_secure)
   243|
   244|
   245|def _dev_auth_enabled() -> bool:
   246|    return MiniAppConfig.from_env().is_dev_auth_active()
   247|
   248|
   249|def _ensure_csp_nonce() -> str:
   250|    existing = getattr(g, "csp_nonce", None)
   251|    if isinstance(existing, str) and existing:
   252|        return existing
   253|
   254|    nonce = generate_csp_nonce()
   255|    g.csp_nonce = nonce
   256|    return nonce
   257|
   258|
   259|def _origin_allowed() -> bool:
   260|    if not ALLOWED_ORIGINS or not ENFORCE_ORIGIN_CHECK:
   261|        return True
   262|
   263|    origin = normalize_origin(request.headers.get("Origin"))
   264|    if origin:
   265|        return origin in ALLOWED_ORIGINS
   266|
   267|    referer = normalize_origin(request.headers.get("Referer"))
   268|    if referer:
   269|        return referer in ALLOWED_ORIGINS
   270|
   271|    return False
   272|
   273|
   274|def _check_rate_limit(key: str, limit: int, window_seconds: int) -> bool:
   275|    return _RATE_LIMITER.allow(key=key, limit=limit, window_seconds=window_seconds)
   276|
   277|
   278|def _publish_job_event(job_id: int, event_name: str, payload: dict[str, object]) -> None:
   279|    _RUNTIME_DEPS.bind_runtime().publish_job_event(job_id, event_name, payload)
   280|
   281|
   282|def _subscribe_job_events(job_id: int) -> queue.Queue[dict[str, object]]:
   283|    return _RUNTIME_DEPS.bind_runtime().subscribe_job_events(job_id)
   284|
   285|
   286|def _unsubscribe_job_events(job_id: int, subscriber: queue.Queue[dict[str, object]]) -> None:
   287|    _RUNTIME_DEPS.bind_runtime().unsubscribe_job_events(job_id, subscriber)
   288|
   289|
   290|def _run_chat_job(job: dict[str, object]) -> None:
   291|    _RUNTIME_DEPS.bind_runtime().run_chat_job(job)
   292|
   293|
   294|def _is_stale_chat_job_error(exc: Exception) -> bool:
   295|    return runtime.is_stale_chat_job_error(exc)
   296|
   297|
   298|def _serialize_chat(chat: ChatThread) -> dict[str, object]:
   299|    return {
   300|        "id": chat.id,
   301|        "title": chat.title,
   302|        "parent_chat_id": chat.parent_chat_id,
   303|        "unread_count": chat.unread_count,
   304|        "pending": chat.pending,
   305|        "is_pinned": chat.is_pinned,
   306|        "updated_at": chat.updated_at,
   307|        "created_at": chat.created_at,
   308|    }
   309|
   310|
   311|def _chat_id_from_payload(payload: dict[str, object], user_id: str) -> int:
   312|    raw_chat_id = payload.get("chat_id")
   313|    if raw_chat_id not in (None, "", 0, "0"):
   314|        return parse_chat_id(payload, default_chat_id=0)
   315|
   316|    active_chat_id = store.get_active_chat(user_id)
   317|    if active_chat_id is not None:
   318|        try:
   319|            store.get_chat(user_id=user_id, chat_id=active_chat_id)
   320|        except KeyError:
   321|            active_chat_id = None
   322|    if active_chat_id is not None:
   323|        return active_chat_id
   324|
   325|    if store.has_explicit_empty_chat_state(user_id):
   326|        raise KeyError("Chat not found.")
   327|
   328|    return store.ensure_default_chat(user_id)
   329|
   330|
   331|_REQUEST_ADAPTERS = build_server_request_adapters(
   332|    bot_token=BOT_TOKEN,
   333|    auth_cookie_name=AUTH_COOKIE_NAME,
   334|    auth_session_max_age_seconds=AUTH_SESSION_MAX_AGE_SECONDS,
   335|    telegram_init_data_max_age_seconds=TELEGRAM_INIT_DATA_MAX_AGE_SECONDS,
   336|    upsert_auth_session_fn=lambda **kwargs: store.upsert_auth_session(**kwargs),
   337|    is_auth_session_active_fn=lambda **kwargs: store.is_auth_session_active(**kwargs),
   338|    auth_session_profile_fn=lambda user_id: store.get_latest_auth_session_profile(user_id),
   339|    verify_telegram_init_data_fn=lambda **kwargs: verify_telegram_init_data(**kwargs),
   340|    chat_id_from_payload_fn=lambda payload, user_id: _chat_id_from_payload(payload, user_id=user_id),
   341|)
   342|
   343|
   344|def _validated_title(raw_title: object, *, default: str) -> str:
   345|    return validate_title(raw_title, default=default, max_length=MAX_TITLE_LEN)
   346|
   347|
   348|def _validated_message(raw_message: object) -> str:
   349|    return validate_message(raw_message, max_length=MAX_MESSAGE_LEN)
   350|
   351|
   352|# Bind adapter-backed implementations after local helper definitions so exported symbols stay stable.
   353|_create_auth_session_token = _REQUEST_ADAPTERS.create_auth_session_token_fn
   354|_verify_auth_session_token = _REQUEST_ADAPTERS.verify_auth_session_token_fn
   355|
   356|
   357|def _verified_from_session_cookie():
   358|    return _REQUEST_ADAPTERS.verified_from_session_cookie_fn()
   359|
   360|
   361|def _verify_from_payload(payload: dict[str, object]):
   362|    return auth_verify_from_payload(
   363|        payload,
   364|        bot_token=BOT_TOKEN,
   365|        telegram_init_data_max_age_seconds=TELEGRAM_INIT_DATA_MAX_AGE_SECONDS,
   366|        verified_from_session_cookie_fn=_verified_from_session_cookie,
   367|        verify_telegram_init_data_fn=lambda **kwargs: verify_telegram_init_data(**kwargs),
   368|    )
   369|
   370|_json_error = _REQUEST_ADAPTERS.json_error_fn
   371|_sse_event = _REQUEST_ADAPTERS.sse_event_fn
   372|_sse_error = _REQUEST_ADAPTERS.sse_error_fn
   373|_request_payload = _REQUEST_ADAPTERS.request_payload_fn
   374|_chat_id_from_payload_or_error = lambda payload, *, user_id: _REQUEST_ADAPTERS.chat_id_from_payload_or_error_fn(payload, user_id)
   375|
   376|
   377|def _verify_for_json(payload: dict[str, object]):
   378|    return request_verify_for_json(payload, verify_from_payload_fn=_verify_from_payload)
   379|
   380|
   381|def _verify_for_sse(payload: dict[str, object]):
   382|    return request_verify_for_sse(payload, verify_from_payload_fn=_verify_from_payload, sse_event_fn=_sse_event)
   383|
   384|
   385|def _json_user_id_or_error(payload: dict[str, object]):
   386|    return request_json_user_id_or_error(payload, verify_for_json_fn=_verify_for_json)
   387|
   388|
   389|def _sse_user_id_or_error(payload: dict[str, object]):
   390|    return request_sse_user_id_or_error(payload, verify_for_sse_fn=_verify_for_sse)
   391|
   392|
   393|def _asset_version(filename: str) -> str:
   394|    return asset_version(BASE_DIR, filename)
   395|
   396|
   397|def _dev_reload_version() -> str:
   398|    return dev_reload_version(BASE_DIR, DEV_RELOAD_WATCH_PATHS)
   399|
   400|
   401|def _startup_diagnostics_payload() -> dict[str, object]:
   402|    return startup_diagnostics_payload(
   403|        client=client,
   404|        session_store_path=str(store.db_path),
   405|        bot_token_configured=bool(BOT_TOKEN),
   406|        debug=DEBUG,
   407|        dev_reload=DEV_RELOAD,
   408|        operator_debug=OPERATOR_DEBUG,
   409|        request_debug=REQUEST_DEBUG,
   410|        stream_timing_debug=STREAM_TIMING_DEBUG,
   411|        force_secure_cookies=FORCE_SECURE_COOKIES,
   412|        trust_proxy_headers=TRUST_PROXY_HEADERS,
   413|        enforce_origin_check=ENFORCE_ORIGIN_CHECK,
   414|        allowed_origins_count=len(ALLOWED_ORIGINS),
   415|        rate_limit_window_seconds=RATE_LIMIT_WINDOW_SECONDS,
   416|        rate_limit_api_requests=RATE_LIMIT_API_REQUESTS,
   417|        rate_limit_stream_requests=RATE_LIMIT_STREAM_REQUESTS,
   418|        assistant_chunk_len=ASSISTANT_CHUNK_LEN,
   419|        assistant_hard_limit=ASSISTANT_HARD_LIMIT,
   420|    )
   421|
   422|
   423|def _log_startup_diagnostics() -> None:
   424|    payload = _startup_diagnostics_payload()
   425|    log_startup_diagnostics(logger=app.logger, payload=payload)
   426|
   427|
   428|runtime.start_once()
   429|
   430|
   431|def _shutdown_runtime_at_exit() -> None:
   432|    runtime.shutdown(reason="process_exit", join_timeout=1.0)
   433|
   434|
   435|atexit.register(_shutdown_runtime_at_exit)
   436|_log_startup_diagnostics()
   437|
   438|
   439|@app.before_request
   440|def enforce_request_guards() -> Response | None:
   441|    return enforce_api_request_guards(
   442|        origin_allowed_fn=_origin_allowed,
   443|        check_rate_limit_fn=_check_rate_limit,
   444|        rate_limit_window_seconds=RATE_LIMIT_WINDOW_SECONDS,
   445|        rate_limit_api_requests=RATE_LIMIT_API_REQUESTS,
   446|        rate_limit_stream_requests=RATE_LIMIT_STREAM_REQUESTS,
   447|        new_request_id_fn=new_request_id,
   448|        now_ms_fn=now_ms,
   449|        auth_cookie_name=AUTH_COOKIE_NAME,
   450|        verify_auth_session_token_fn=_verify_auth_session_token,
   451|    )
   452|
   453|
   454|@app.after_request
   455|def add_security_headers(response: Response) -> Response:
   456|    response = apply_security_headers(
   457|        response,
   458|        csp_nonce=str(getattr(g, "csp_nonce", "") or ""),
   459|        enable_hsts=ENABLE_HSTS,
   460|    )
   461|
   462|    request_started_ms = float(getattr(g, "request_started_ms", now_ms()))
   463|    elapsed_ms = max(0, int(now_ms() - request_started_ms))
   464|    request_id = str(getattr(g, "request_id", ""))
   465|    app.logger.info(
   466|        build_request_log(
   467|            request=request,
   468|            request_id=request_id,
   469|            status_code=response.status_code,
   470|            elapsed_ms=elapsed_ms,
   471|        )
   472|    )
   473|    if request.path in STATIC_NO_STORE_PATHS:
   474|        response.headers["Cache-Control"] = "no-store, max-age=0"
   475|    if request_id:
   476|        response.headers.setdefault("X-Request-Id", request_id)
   477|    return response
   478|
   479|
   480|_FILE_PREVIEW_ALLOWED_ROOTS = _file_preview_allowed_roots()
   481|_FILE_PREVIEW_ENABLED = _file_preview_enabled(_FILE_PREVIEW_ALLOWED_ROOTS)
   482|
   483|register_public_routes(
   484|    public_bp,
   485|    app=app,
   486|    allowed_skins=ALLOWED_SKINS,
   487|    skin_cookie_name=SKIN_COOKIE_NAME,
   488|    max_message_len=MAX_MESSAGE_LEN,
   489|    dev_reload=DEV_RELOAD,
   490|    dev_reload_interval_ms=DEV_RELOAD_INTERVAL_MS,
   491|    request_debug=REQUEST_DEBUG,
   492|    dev_auth_enabled_fn=_dev_auth_enabled,
   493|    file_preview_enabled=_FILE_PREVIEW_ENABLED,
   494|    file_preview_allowed_roots=_FILE_PREVIEW_ALLOWED_ROOTS,
   495|    static_no_store_filenames=STATIC_NO_STORE_FILENAMES,
   496|    asset_version_fn=lambda filename: _asset_version(filename),
   497|    dev_reload_version_fn=lambda: _dev_reload_version(),
   498|    ensure_csp_nonce_fn=_ensure_csp_nonce,
   499|)
   500|
   501|