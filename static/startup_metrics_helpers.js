(function initHermesMiniappStartupMetrics(globalScope) {
  function createController(deps = {}) {
    const {
      windowObject = (typeof window !== 'undefined' ? window : null),
      documentObject = (typeof document !== 'undefined' ? document : null),
      latencyChip = null,
      setActivityChip = null,
      formatLatency = (value) => String(value ?? ''),
      consoleObject = (typeof console !== 'undefined' ? console : null),
    } = deps;

    const bootMetrics = (() => {
      const existing = windowObject?.__HERMES_BOOT_METRICS__;
      if (existing && typeof existing === 'object') {
        return existing;
      }
      const next = {};
      if (windowObject) {
        windowObject.__HERMES_BOOT_METRICS__ = next;
      }
      return next;
    })();

    const bootPerf = windowObject && typeof windowObject.performance !== 'undefined'
      ? windowObject.performance
      : null;

    function bootNowMs() {
      return bootPerf && typeof bootPerf.now === 'function' ? bootPerf.now() : Date.now();
    }

    function readBootMetric(name) {
      const value = Number(bootMetrics?.[name]);
      return Number.isFinite(value) ? value : 0;
    }

    function bootDuration(startMetric, endMetric) {
      const start = readBootMetric(startMetric);
      const end = readBootMetric(endMetric);
      if (!start || !end || end < start) {
        return null;
      }
      return Math.max(0, end - start);
    }

    function recordBootMetric(name, value = bootNowMs()) {
      const normalized = Math.max(0, Math.round(Number(value) || 0));
      bootMetrics[name] = normalized;
      return normalized;
    }

    function syncBootLatencyChip(stage = '') {
      const startedAt = Number(bootMetrics.shellInlineStartMs || 0);
      if (!startedAt || !latencyChip || typeof setActivityChip !== 'function') {
        return;
      }
      const elapsedMs = Math.max(0, Math.round(bootNowMs() - startedAt));
      setActivityChip(latencyChip, `open: ${formatLatency(elapsedMs)}`);
      if (stage) {
        latencyChip.dataset.bootStage = stage;
      }
    }

    function logBootStage(stage, extra = {}) {
      const metricName = `${String(stage || 'stage').replace(/[^a-z0-9]+/gi, '_')}Ms`;
      const elapsedMs = recordBootMetric(metricName);
      syncBootLatencyChip(stage);
      consoleObject?.info?.('[miniapp/boot]', {
        stage,
        elapsedMs,
        ...extra,
      });
      return elapsedMs;
    }

    function summarizeBootMetrics(extra = {}) {
      const summary = {
        totalOpenMs: bootDuration('appScriptStartMs', 'bootstrap_finishedMs'),
        authWaitMs: bootDuration('auth_request_dispatchedMs', 'auth_response_receivedMs'),
        authApplyMs: bootDuration('auth_bootstrap_applied_startMs', 'auth_bootstrap_applied_finishedMs'),
        firstRenderMs: bootDuration('initial_render_startMs', 'initial_render_finishedMs'),
        emptyRenderMs: bootDuration('initial_empty_chat_render_startMs', 'initial_empty_chat_render_finishedMs'),
        shellRevealMs: bootDuration('appScriptStartMs', 'shellRevealMs'),
        ...extra,
      };
      consoleObject?.info?.('[miniapp/boot-summary]', summary);
      return summary;
    }

    function revealShell() {
      documentObject?.documentElement?.setAttribute('data-shell-ready', '1');
      recordBootMetric('shellRevealMs');
      syncBootLatencyChip('shell-visible');
    }

    return {
      bootMetrics,
      bootNowMs,
      readBootMetric,
      bootDuration,
      recordBootMetric,
      syncBootLatencyChip,
      logBootStage,
      summarizeBootMetrics,
      revealShell,
    };
  }

  const api = {
    createController,
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  globalScope.HermesMiniappStartupMetrics = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
