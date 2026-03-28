from __future__ import annotations

import logging
import subprocess as _subprocess
import sys

import hermes_client_agent_direct as _direct
import hermes_client_agent_persistent as _persistent
from hermes_client_agent_direct import HermesClientDirectAgentMixin
from hermes_client_agent_persistent import HermesClientPersistentAgentMixin


logger = logging.getLogger(__name__)
subprocess = _subprocess


class _ModuleVarProxy:
    def __init__(self, module_name: str, var_name: str) -> None:
        self._module_name = module_name
        self._var_name = var_name

    def _target(self):
        module = sys.modules[self._module_name]
        return getattr(module, self._var_name)

    def __getattr__(self, name: str):
        return getattr(self._target(), name)


# Backward-compat monkeypatch surfaces used by tests and downstream callers.
_logger_proxy = _ModuleVarProxy(__name__, "logger")
_subprocess_proxy = _ModuleVarProxy(__name__, "subprocess")
_direct.logger = _logger_proxy
_persistent.logger = _logger_proxy
_direct.subprocess = _subprocess_proxy


class HermesClientAgentMixin(HermesClientPersistentAgentMixin, HermesClientDirectAgentMixin):
    """Compatibility composition mixin for Hermes miniapp agent transports.

    Persistent runtime orchestration and direct subprocess streaming are split into
    focused modules for maintainability while preserving existing call sites.
    """

    pass
