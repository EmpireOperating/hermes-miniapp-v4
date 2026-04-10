(function (globalScope) {
  function resolveRuntimeUnreadHelpers() {
    if (globalScope.HermesMiniappRuntimeUnread) {
      return globalScope.HermesMiniappRuntimeUnread;
    }
    if (typeof module !== "undefined" && module.exports && typeof require === "function") {
      try {
        return require("./runtime_unread_helpers.js");
      } catch {
        return null;
      }
    }
    return null;
  }

  function resolveRuntimeLatencyHelpers() {
    if (globalScope.HermesMiniappRuntimeLatency) {
      return globalScope.HermesMiniappRuntimeLatency;
    }
    if (typeof module !== "undefined" && module.exports && typeof require === "function") {
      try {
        return require("./runtime_latency_helpers.js");
      } catch {
        return null;
      }
    }
    return null;
  }

  function resolveRuntimeHistoryHelpers() {
    if (globalScope.HermesMiniappRuntimeHistory) {
      return globalScope.HermesMiniappRuntimeHistory;
    }
    if (typeof module !== "undefined" && module.exports && typeof require === "function") {
      try {
        return require("./runtime_history_helpers.js");
      } catch {
        return null;
      }
    }
    return null;
  }

  const unreadHelpers = resolveRuntimeUnreadHelpers();
  const latencyHelpers = resolveRuntimeLatencyHelpers();
  const historyHelpers = resolveRuntimeHistoryHelpers();

  if (!unreadHelpers) {
    throw new Error("HermesMiniappRuntimeUnread is required before runtime_helpers.js");
  }
  if (!latencyHelpers) {
    throw new Error("HermesMiniappRuntimeLatency is required before runtime_helpers.js");
  }
  if (!historyHelpers) {
    throw new Error("HermesMiniappRuntimeHistory is required before runtime_helpers.js");
  }

  const api = {
    ...unreadHelpers,
    ...latencyHelpers,
    ...historyHelpers,
  };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
  globalScope.HermesMiniappRuntime = api;
})(typeof window !== "undefined" ? window : globalThis);
