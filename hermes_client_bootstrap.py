from __future__ import annotations

import json
import logging
from pathlib import Path
from typing import Any


class HermesClientBootstrap:
    """Config/bootstrap loader for Hermes client routing decisions."""

    def __init__(self, *, agent_hermes_home: str, logger: logging.Logger) -> None:
        self.agent_hermes_home = agent_hermes_home
        self.logger = logger

    @staticmethod
    def safe_failure_reason(exc: Exception) -> str:
        return exc.__class__.__name__

    def resolve_agent_routing(self, *, env_provider: str, env_base_url: str) -> tuple[str | None, str | None]:
        provider = env_provider if env_provider and env_provider.lower() != "auto" else None
        base_url = env_base_url if env_base_url and env_base_url.lower() != "auto" else None

        if provider is None:
            provider = self.load_active_provider_from_auth_store()

        if base_url is None:
            base_url = self.load_base_url_from_config()

        return provider, base_url

    def load_active_provider_from_auth_store(self) -> str | None:
        auth_path = Path(self.agent_hermes_home) / "auth.json"
        if not auth_path.exists():
            return None
        try:
            auth_payload = auth_path.read_text(encoding="utf-8")
        except (OSError, UnicodeDecodeError) as exc:
            self.logger.warning(
                "Failed to read auth store; falling back to default provider resolution.",
                extra={
                    "path": str(auth_path),
                    "failure_class": exc.__class__.__name__,
                    "reason": self.safe_failure_reason(exc),
                },
            )
            return None
        try:
            data = json.loads(auth_payload)
        except json.JSONDecodeError as exc:
            self.logger.warning(
                "Malformed auth store; falling back to default provider resolution.",
                extra={
                    "path": str(auth_path),
                    "failure_class": exc.__class__.__name__,
                    "reason": self.safe_failure_reason(exc),
                },
            )
            return None
        except Exception as exc:  # noqa: BLE001 - broad-except-policy: malformed auth payload should degrade gracefully
            self.logger.warning(
                "Failed to parse auth store; falling back to default provider resolution.",
                extra={
                    "path": str(auth_path),
                    "failure_class": exc.__class__.__name__,
                    "reason": self.safe_failure_reason(exc),
                },
            )
            return None
        if not isinstance(data, dict):
            self.logger.warning(
                "Malformed auth store root; falling back to default provider resolution.",
                extra={
                    "path": str(auth_path),
                    "failure_class": "TypeError",
                    "reason": f"root_not_mapping:{type(data).__name__}",
                },
            )
            return None
        provider = data.get("active_provider")
        if isinstance(provider, str) and provider.strip():
            return provider.strip()
        if provider is not None:
            self.logger.warning(
                "Malformed active_provider in auth store; falling back to default provider resolution.",
                extra={
                    "path": str(auth_path),
                    "failure_class": "TypeError",
                    "reason": f"active_provider_not_nonempty_string:{type(provider).__name__}",
                },
            )
        return None

    def load_base_url_from_config(self) -> str | None:
        model_cfg = self.load_model_cfg_from_config()
        if not isinstance(model_cfg, dict):
            return None
        base_url = model_cfg.get("base_url")
        if isinstance(base_url, str) and base_url.strip():
            return base_url.strip()
        if base_url is not None:
            config_path = Path(self.agent_hermes_home) / "config.yaml"
            self.logger.warning(
                "Malformed model.base_url in config; falling back to default base_url resolution.",
                extra={
                    "path": str(config_path),
                    "failure_class": "TypeError",
                    "reason": f"model.base_url_not_nonempty_string:{type(base_url).__name__}",
                },
            )
        return None

    def load_default_model_from_config(self) -> str | None:
        model_cfg = self.load_model_cfg_from_config()
        if not isinstance(model_cfg, dict):
            return None
        default_model = model_cfg.get("default")
        if isinstance(default_model, str) and default_model.strip():
            return default_model.strip()
        if default_model is not None:
            config_path = Path(self.agent_hermes_home) / "config.yaml"
            self.logger.warning(
                "Malformed model.default in config; falling back to default model resolution.",
                extra={
                    "path": str(config_path),
                    "failure_class": "TypeError",
                    "reason": f"model.default_not_nonempty_string:{type(default_model).__name__}",
                },
            )
        return None

    def load_model_cfg_from_config(self) -> dict[str, Any] | None:
        config_path = Path(self.agent_hermes_home) / "config.yaml"
        if not config_path.exists():
            return None
        try:
            import yaml
        except ModuleNotFoundError as exc:
            self.logger.debug(
                "YAML parser unavailable; falling back to default config resolution.",
                extra={
                    "path": str(config_path),
                    "failure_class": exc.__class__.__name__,
                    "reason": self.safe_failure_reason(exc),
                },
            )
            return None

        try:
            config_payload = config_path.read_text(encoding="utf-8")
        except (OSError, UnicodeDecodeError) as exc:
            self.logger.warning(
                "Failed to read config.yaml; falling back to default config resolution.",
                extra={
                    "path": str(config_path),
                    "failure_class": exc.__class__.__name__,
                    "reason": self.safe_failure_reason(exc),
                },
            )
            return None
        try:
            data = yaml.safe_load(config_payload)
        except yaml.YAMLError as exc:
            self.logger.warning(
                "Malformed config.yaml; falling back to default config resolution.",
                extra={
                    "path": str(config_path),
                    "failure_class": exc.__class__.__name__,
                    "reason": self.safe_failure_reason(exc),
                },
            )
            return None
        except Exception as exc:  # noqa: BLE001 - broad-except-policy: malformed config payload should degrade gracefully
            self.logger.warning(
                "Failed to parse config.yaml; falling back to default config resolution.",
                extra={
                    "path": str(config_path),
                    "failure_class": exc.__class__.__name__,
                    "reason": self.safe_failure_reason(exc),
                },
            )
            return None
        if data is None:
            data = {}
        if not isinstance(data, dict):
            self.logger.warning(
                "Malformed config root; falling back to default config resolution.",
                extra={
                    "path": str(config_path),
                    "failure_class": "TypeError",
                    "reason": f"root_not_mapping:{type(data).__name__}",
                },
            )
            return None
        model_cfg = data.get("model") if isinstance(data, dict) else None
        if model_cfg is None:
            return None
        if not isinstance(model_cfg, dict):
            self.logger.warning(
                "Malformed config model section; falling back to default config resolution.",
                extra={
                    "path": str(config_path),
                    "failure_class": "TypeError",
                    "reason": f"model_not_mapping:{type(model_cfg).__name__}",
                },
            )
            return None
        return model_cfg
