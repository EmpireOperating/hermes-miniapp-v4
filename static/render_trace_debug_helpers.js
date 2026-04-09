(function initRenderTraceDebugHelpers(global) {
  "use strict";

  function parseBooleanFlag(rawValue) {
    if (rawValue == null) return null;
    const normalized = String(rawValue).trim().toLowerCase();
    if (!normalized) return null;
    if (["1", "true", "yes", "on"].includes(normalized)) return true;
    if (["0", "false", "no", "off"].includes(normalized)) return false;
    return null;
  }

  function createController(deps) {
    const {
      windowObject,
      localStorageRef,
      renderTraceBadge,
      storageKey,
      getRenderTraceDebugEnabled,
      setRenderTraceDebugEnabledState,
      consoleRef = console,
    } = deps || {};

    function resolveRenderTraceDebugEnabled() {
      let queryFlag = null;
      try {
        const params = new URLSearchParams(windowObject.location.search || "");
        queryFlag = parseBooleanFlag(params.get("render_trace"));
        if (queryFlag !== null) {
          try {
            if (queryFlag) {
              localStorageRef.setItem(storageKey, "1");
            } else {
              localStorageRef.removeItem(storageKey);
            }
          } catch {
            // Best-effort persistence only.
          }
          return queryFlag;
        }
      } catch {
        // URL parsing unavailable; fall through to stored preference.
      }

      try {
        return Boolean(parseBooleanFlag(localStorageRef.getItem(storageKey)));
      } catch {
        return false;
      }
    }

    function syncRenderTraceBadge() {
      if (!renderTraceBadge) return;
      const renderTraceDebugEnabled = Boolean(getRenderTraceDebugEnabled());
      renderTraceBadge.hidden = false;
      renderTraceBadge.dataset.enabled = renderTraceDebugEnabled ? "true" : "false";
      renderTraceBadge.setAttribute("aria-pressed", renderTraceDebugEnabled ? "true" : "false");
      renderTraceBadge.textContent = `Render Trace ${renderTraceDebugEnabled ? "ON" : "OFF"}`;
      renderTraceBadge.title = renderTraceDebugEnabled
        ? "Tap to disable render trace logging"
        : "Tap to enable render trace logging";
    }

    function setRenderTraceDebugEnabled(nextEnabled, options = {}) {
      const { persist = true, updateUrl = true } = options;
      const renderTraceDebugEnabled = Boolean(nextEnabled);
      setRenderTraceDebugEnabledState(renderTraceDebugEnabled);

      if (persist) {
        try {
          if (renderTraceDebugEnabled) {
            localStorageRef.setItem(storageKey, "1");
          } else {
            localStorageRef.removeItem(storageKey);
          }
        } catch {
          // Best-effort persistence only.
        }
      }

      if (updateUrl) {
        try {
          const url = new URL(windowObject.location.href);
          if (renderTraceDebugEnabled) {
            url.searchParams.set("render_trace", "1");
          } else {
            url.searchParams.delete("render_trace");
          }
          windowObject.history.replaceState(windowObject.history.state, "", url.toString());
        } catch {
          // Ignore URL update failures.
        }
      }

      syncRenderTraceBadge();
    }

    function handleRenderTraceBadgeClick() {
      const nextEnabled = !Boolean(getRenderTraceDebugEnabled());
      setRenderTraceDebugEnabled(nextEnabled);
      if (nextEnabled) {
        consoleRef.info("[render-trace] debug-enabled", { enabled: true, source: "badge" });
        return;
      }
      consoleRef.info("[render-trace] debug-disabled", { enabled: false, source: "badge" });
    }

    function renderTraceLog(eventName, details = null) {
      if (!Boolean(getRenderTraceDebugEnabled())) return;
      if (details == null) {
        consoleRef.info(`[render-trace] ${eventName}`);
        return;
      }
      consoleRef.info(`[render-trace] ${eventName}`, details);
    }

    return {
      parseBooleanFlag,
      resolveRenderTraceDebugEnabled,
      syncRenderTraceBadge,
      setRenderTraceDebugEnabled,
      handleRenderTraceBadgeClick,
      renderTraceLog,
    };
  }

  const api = {
    parseBooleanFlag,
    createController,
  };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
  global.HermesMiniappRenderTraceDebug = api;
})(typeof window !== "undefined" ? window : globalThis);
