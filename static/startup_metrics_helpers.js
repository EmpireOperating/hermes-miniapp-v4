(function initHermesMiniappStartupMetrics(globalScope) {
  function createController(deps = {}) {
    const {
      windowObject = (typeof window !== 'undefined' ? window : null),
      documentObject = (typeof document !== 'undefined' ? document : null),
      navigatorObject = (typeof navigator !== 'undefined' ? navigator : null),
      latencyChip = null,
      setActivityChip = null,
      formatLatency = (value) => String(value ?? ''),
      consoleObject = (typeof console !== 'undefined' ? console : null),
      reportBootSummaryUrl = '/api/telemetry/boot',
      fetchImpl = (typeof fetch === 'function' ? fetch.bind(globalThis) : null),
      storageObject = (() => {
        try {
          return windowObject?.localStorage || null;
        } catch {
          return null;
        }
      })(),
      sessionStorageObject = (() => {
        try {
          return windowObject?.sessionStorage || null;
        } catch {
          return null;
        }
      })(),
      pendingBootSummaryStorageKey = '__HERMES_PENDING_BOOT_SUMMARIES__',
      lifecycleMarkerStorageKey = '__HERMES_LIFECYCLE_MARKER__',
      reloadIntentStorageKey = '__HERMES_RELOAD_INTENT__',
      pageSessionStorageKey = '__HERMES_PAGE_SESSION_ID__',
      maxPendingBootSummaries = 20,
      lifecycleMarkerMaxAgeMs = 5 * 60 * 1000,
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

    const bootMeta = (() => {
      const existing = windowObject?.__HERMES_BOOT_META__;
      if (existing && typeof existing === 'object') {
        return existing;
      }
      const next = {};
      if (windowObject) {
        windowObject.__HERMES_BOOT_META__ = next;
      }
      return next;
    })();

    const bootPerf = windowObject && typeof windowObject.performance !== 'undefined'
      ? windowObject.performance
      : null;

    function bootNowMs() {
      return bootPerf && typeof bootPerf.now === 'function' ? bootPerf.now() : Date.now();
    }

    function readJson(storageRef, key) {
      if (!storageRef || !key) return null;
      try {
        const raw = storageRef.getItem(key);
        if (!raw) return null;
        const parsed = JSON.parse(raw);
        return parsed && typeof parsed === 'object' ? parsed : null;
      } catch {
        return null;
      }
    }

    function writeJson(storageRef, key, value) {
      if (!storageRef || !key) return false;
      try {
        if (value == null) {
          storageRef.removeItem?.(key);
          return true;
        }
        storageRef.setItem(key, JSON.stringify(value));
        return true;
      } catch {
        return false;
      }
    }

    function randomId(prefix = 'boot') {
      return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
    }

    const existingPageSessionId = (() => {
      try {
        return String(sessionStorageObject?.getItem?.(pageSessionStorageKey) || '').trim();
      } catch {
        return '';
      }
    })();
    const pageSessionId = existingPageSessionId || randomId('page');
    if (!existingPageSessionId) {
      try {
        sessionStorageObject?.setItem?.(pageSessionStorageKey, pageSessionId);
      } catch {
        // best effort only
      }
    }

    function inferEntryPathMeta() {
      const now = Date.now();
      const reloadIntent = readJson(storageObject, reloadIntentStorageKey);
      if (
        reloadIntent
        && Number.isFinite(Number(reloadIntent.ts))
        && now - Number(reloadIntent.ts) <= Math.max(1000, Number(lifecycleMarkerMaxAgeMs) || 0)
      ) {
        return {
          entryPathReason: String(reloadIntent.reason || 'version-sync-reload'),
          entryPathSource: 'reload-intent',
          entryPathPreviousPageSessionId: String(reloadIntent.pageSessionId || ''),
          entryPathAgeMs: Math.max(0, now - Number(reloadIntent.ts)),
          reloadIntentFromVersion: String(reloadIntent.fromVersion || ''),
          reloadIntentToVersion: String(reloadIntent.toVersion || ''),
        };
      }

      const lifecycleMarker = readJson(storageObject, lifecycleMarkerStorageKey);
      if (
        lifecycleMarker
        && String(lifecycleMarker.type || '') === 'backgrounded'
        && Number.isFinite(Number(lifecycleMarker.ts))
        && now - Number(lifecycleMarker.ts) <= Math.max(1000, Number(lifecycleMarkerMaxAgeMs) || 0)
      ) {
        return {
          entryPathReason: 'host-recreated-after-background',
          entryPathSource: 'lifecycle-marker',
          entryPathPreviousPageSessionId: String(lifecycleMarker.pageSessionId || ''),
          entryPathAgeMs: Math.max(0, now - Number(lifecycleMarker.ts)),
          lastLifecycleTrigger: String(lifecycleMarker.trigger || ''),
          lastLifecycleVisibilityState: String(lifecycleMarker.visibilityState || ''),
        };
      }

      return {
        entryPathReason: 'fresh-open-or-unknown',
        entryPathSource: 'none',
        entryPathPreviousPageSessionId: '',
        entryPathAgeMs: null,
      };
    }

    Object.assign(bootMeta, {
      pageSessionId,
      pageSessionStorageReused: Boolean(existingPageSessionId),
      ...inferEntryPathMeta(),
    });

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

    function recordBootMeta(nameOrPatch, value) {
      if (!bootMeta || typeof bootMeta !== 'object') {
        return bootMeta;
      }
      if (nameOrPatch && typeof nameOrPatch === 'object' && !Array.isArray(nameOrPatch)) {
        Object.assign(bootMeta, nameOrPatch);
        return bootMeta;
      }
      const name = String(nameOrPatch || '').trim();
      if (name) {
        bootMeta[name] = value;
      }
      return bootMeta;
    }

    function summarizeDominantPhase(summary) {
      const phases = [
        ['shellToAppScriptMs', summary.shellToAppScriptMs],
        ['appBootToAuthRequestMs', summary.appBootToAuthRequestMs],
        ['authWaitMs', summary.authWaitMs],
        ['authApplyMs', summary.authApplyMs],
        ['firstRenderMs', summary.firstRenderMs],
      ].filter(([, value]) => Number.isFinite(Number(value)) && Number(value) >= 0);
      if (!phases.length) {
        return '';
      }
      phases.sort((left, right) => Number(right[1]) - Number(left[1]));
      return String(phases[0][0] || '');
    }

    function readNavigationInfo() {
      const navEntry = typeof bootPerf?.getEntriesByType === 'function'
        ? bootPerf.getEntriesByType('navigation')?.[0] || null
        : null;
      const connection = navigatorObject?.connection || navigatorObject?.mozConnection || navigatorObject?.webkitConnection || null;
      return {
        navigationType: String(navEntry?.type || ''),
        transferSize: Number.isFinite(Number(navEntry?.transferSize)) ? Number(navEntry.transferSize) : null,
        encodedBodySize: Number.isFinite(Number(navEntry?.encodedBodySize)) ? Number(navEntry.encodedBodySize) : null,
        decodedBodySize: Number.isFinite(Number(navEntry?.decodedBodySize)) ? Number(navEntry.decodedBodySize) : null,
        nextHopProtocol: String(navEntry?.nextHopProtocol || ''),
        activationStartMs: Number.isFinite(Number(navEntry?.activationStart)) ? Math.round(Number(navEntry.activationStart)) : null,
        effectiveType: String(connection?.effectiveType || ''),
        saveData: typeof connection?.saveData === 'boolean' ? connection.saveData : null,
        connectionRttMs: Number.isFinite(Number(connection?.rtt)) ? Math.round(Number(connection.rtt)) : null,
        visibilityState: String(documentObject?.visibilityState || ''),
        wasDiscarded: Boolean(documentObject?.wasDiscarded),
      };
    }

    function loadPendingBootSummaries() {
      if (!storageObject || !pendingBootSummaryStorageKey) {
        return [];
      }
      try {
        const raw = storageObject.getItem(pendingBootSummaryStorageKey);
        if (!raw) {
          return [];
        }
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed.filter((item) => item && typeof item === 'object') : [];
      } catch {
        return [];
      }
    }

    function savePendingBootSummaries(entries) {
      if (!storageObject || !pendingBootSummaryStorageKey) {
        return;
      }
      try {
        const normalized = Array.isArray(entries) ? entries.filter((item) => item && typeof item === 'object') : [];
        if (!normalized.length) {
          storageObject.removeItem(pendingBootSummaryStorageKey);
          return;
        }
        storageObject.setItem(
          pendingBootSummaryStorageKey,
          JSON.stringify(normalized.slice(-Math.max(1, Number(maxPendingBootSummaries) || 20))),
        );
      } catch {
        // Best-effort telemetry only.
      }
    }

    function queueBootSummary(summary) {
      const queue = loadPendingBootSummaries();
      const id = String(summary?.bootSummaryId || '').trim();
      const deduped = id ? queue.filter((item) => String(item?.bootSummaryId || '').trim() !== id) : queue;
      deduped.push(summary);
      savePendingBootSummaries(deduped);
    }

    async function flushPendingBootSummaries() {
      const reportUrl = String(reportBootSummaryUrl || '').trim();
      if (!reportUrl || typeof fetchImpl !== 'function') {
        return false;
      }
      const queue = loadPendingBootSummaries();
      let flushedAny = false;
      while (queue.length) {
        const next = queue[0];
        try {
          const response = await fetchImpl(reportUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(next),
            keepalive: true,
            credentials: 'same-origin',
          });
          if (!response || response.ok !== true) {
            break;
          }
          queue.shift();
          flushedAny = true;
          savePendingBootSummaries(queue);
        } catch {
          break;
        }
      }
      return flushedAny;
    }

    function emitBestEffortBootSummary(summary) {
      const reportUrl = String(reportBootSummaryUrl || '').trim();
      const sendBeacon = typeof navigatorObject?.sendBeacon === 'function'
        ? navigatorObject.sendBeacon.bind(navigatorObject)
        : null;
      if (!reportUrl || !sendBeacon) {
        return false;
      }
      try {
        const payload = JSON.stringify(summary);
        const beaconPayload = typeof Blob === 'function'
          ? new Blob([payload], { type: 'application/json' })
          : payload;
        return sendBeacon(reportUrl, beaconPayload) === true;
      } catch {
        return false;
      }
    }

    function summarizeBootMetrics(extra = {}) {
      const summary = {
        shellToAppScriptMs: bootDuration('shellInlineStartMs', 'appScriptStartMs'),
        appBootToAuthRequestMs: bootDuration('appScriptStartMs', 'auth_request_dispatchedMs'),
        preAuthVersionCheckMs: bootDuration('version_check_startMs', 'version_check_finishedMs'),
        shellToAuthRequestMs: bootDuration('shellInlineStartMs', 'auth_request_dispatchedMs'),
        totalOpenMs: bootDuration('appScriptStartMs', 'bootstrap_finishedMs'),
        authWaitMs: bootDuration('auth_request_dispatchedMs', 'auth_response_receivedMs'),
        authApplyMs: bootDuration('auth_bootstrap_applied_startMs', 'auth_bootstrap_applied_finishedMs'),
        firstRenderMs: bootDuration('initial_render_startMs', 'initial_render_finishedMs'),
        emptyRenderMs: bootDuration('initial_empty_chat_render_startMs', 'initial_empty_chat_render_finishedMs'),
        shellRevealMs: bootDuration('appScriptStartMs', 'shellRevealMs'),
        ...readNavigationInfo(),
        ...bootMeta,
        ...extra,
      };
      summary.dominantPhase = summarizeDominantPhase(summary);
      summary.bootSummaryId = String(summary.bootSummaryId || `${Date.now()}-${Math.random().toString(16).slice(2, 10)}`);
      summary.bootSummaryRecordedAtMs = Number.isFinite(Number(summary.bootSummaryRecordedAtMs))
        ? Math.round(Number(summary.bootSummaryRecordedAtMs))
        : Date.now();
      const history = Array.isArray(windowObject?.__HERMES_BOOT_SUMMARIES__) ? windowObject.__HERMES_BOOT_SUMMARIES__ : [];
      history.push(summary);
      while (history.length > 10) {
        history.shift();
      }
      if (windowObject) {
        windowObject.__HERMES_BOOT_SUMMARIES__ = history;
        windowObject.__HERMES_LAST_BOOT_SUMMARY__ = summary;
      }
      consoleObject?.info?.('[miniapp/boot-summary]', summary);
      queueBootSummary(summary);
      emitBestEffortBootSummary(summary);
      void flushPendingBootSummaries();
      return summary;
    }

    function markBackgrounded(extra = {}) {
      const marker = {
        type: 'backgrounded',
        ts: Date.now(),
        pageSessionId,
        visibilityState: String(documentObject?.visibilityState || ''),
        ...extra,
      };
      writeJson(storageObject, lifecycleMarkerStorageKey, marker);
      consoleObject?.info?.('[miniapp/lifecycle]', marker);
      return marker;
    }

    function markVisibilityResume(extra = {}) {
      const marker = {
        type: 'visible-resume',
        ts: Date.now(),
        pageSessionId,
        visibilityState: String(documentObject?.visibilityState || ''),
        ...extra,
      };
      if (windowObject) {
        windowObject.__HERMES_LAST_VISIBILITY_RESUME__ = marker;
      }
      consoleObject?.info?.('[miniapp/lifecycle]', marker);
      return marker;
    }

    function markVersionSyncReloadIntent(extra = {}) {
      const marker = {
        reason: 'version-sync-reload',
        ts: Date.now(),
        pageSessionId,
        ...extra,
      };
      writeJson(storageObject, reloadIntentStorageKey, marker);
      consoleObject?.info?.('[miniapp/lifecycle]', marker);
      return marker;
    }

    function revealShell() {
      documentObject?.documentElement?.setAttribute('data-shell-ready', '1');
      recordBootMetric('shellRevealMs');
      syncBootLatencyChip('shell-visible');
    }

    return {
      bootMetrics,
      bootMeta,
      bootNowMs,
      readBootMetric,
      bootDuration,
      recordBootMetric,
      recordBootMeta,
      syncBootLatencyChip,
      logBootStage,
      summarizeBootMetrics,
      markBackgrounded,
      markVisibilityResume,
      markVersionSyncReloadIntent,
      revealShell,
      flushPendingBootSummaries,
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
