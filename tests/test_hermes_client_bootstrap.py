from __future__ import annotations

import logging

from hermes_client_bootstrap import HermesClientBootstrap


def _bootstrap(tmp_path):
    return HermesClientBootstrap(agent_hermes_home=str(tmp_path), logger=logging.getLogger("test.bootstrap"))


def test_resolve_agent_routing_prefers_explicit_env_values(tmp_path) -> None:
    bootstrap = _bootstrap(tmp_path)

    provider, base_url = bootstrap.resolve_agent_routing(
        env_provider="openai-codex",
        env_base_url="https://example.invalid/api",
    )

    assert provider == "openai-codex"
    assert base_url == "https://example.invalid/api"


def test_resolve_agent_routing_uses_auth_and_config_for_auto(monkeypatch, tmp_path) -> None:
    bootstrap = _bootstrap(tmp_path)
    monkeypatch.setattr(bootstrap, "load_active_provider_from_auth_store", lambda: "anthropic")
    monkeypatch.setattr(bootstrap, "load_base_url_from_config", lambda: "https://cfg.invalid")

    provider, base_url = bootstrap.resolve_agent_routing(env_provider="auto", env_base_url="auto")

    assert provider == "anthropic"
    assert base_url == "https://cfg.invalid"


def test_load_active_provider_from_auth_store_reads_nonempty_string(tmp_path) -> None:
    (tmp_path / "auth.json").write_text('{"active_provider": "  openai  "}', encoding="utf-8")
    bootstrap = _bootstrap(tmp_path)

    assert bootstrap.load_active_provider_from_auth_store() == "openai"


def test_load_default_model_from_config_returns_none_for_malformed_type(tmp_path) -> None:
    (tmp_path / "config.yaml").write_text("model:\n  default: 123\n", encoding="utf-8")
    bootstrap = _bootstrap(tmp_path)

    model = bootstrap.load_default_model_from_config()

    assert model is None
