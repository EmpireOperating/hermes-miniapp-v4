import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const startupMetrics = require('../static/startup_metrics_helpers.js');

function buildHarness({ beaconResult = true } = {}) {
  const infoCalls = [];
  const activityCalls = [];
  const beaconCalls = [];
  const fetchCalls = [];
  const latencyChip = { dataset: {}, textContent: '', title: '' };
  const documentObject = {
    visibilityState: 'visible',
    wasDiscarded: false,
    documentElement: {
      attrs: {},
      setAttribute(name, value) {
        this.attrs[name] = String(value);
      },
    },
  };
  let now = 100;
  const windowObject = {
    performance: {
      now: () => now,
      getEntriesByType(type) {
        if (type !== 'navigation') return [];
        return [{
          type: 'navigate',
          transferSize: 4096,
          encodedBodySize: 2048,
          decodedBodySize: 8192,
          nextHopProtocol: 'h2',
          activationStart: 0,
        }];
      },
    },
  };
  const localStorageState = new Map();
  const sessionStorageState = new Map();
  const navigatorObject = {
    connection: {
      effectiveType: '4g',
      saveData: false,
      rtt: 75,
    },
    sendBeacon(url, payload) {
      beaconCalls.push({ url, payload });
      return beaconResult;
    },
  };
  windowObject.localStorage = {
    getItem(key) {
      return localStorageState.has(key) ? localStorageState.get(key) : null;
    },
    setItem(key, value) {
      localStorageState.set(String(key), String(value));
    },
    removeItem(key) {
      localStorageState.delete(String(key));
    },
  };
  windowObject.sessionStorage = {
    getItem(key) {
      return sessionStorageState.has(key) ? sessionStorageState.get(key) : null;
    },
    setItem(key, value) {
      sessionStorageState.set(String(key), String(value));
    },
    removeItem(key) {
      sessionStorageState.delete(String(key));
    },
  };
  const controller = startupMetrics.createController({
    windowObject,
    documentObject,
    navigatorObject,
    latencyChip,
    setActivityChip: (chip, text) => {
      chip.textContent = String(text);
      chip.title = String(text);
      activityCalls.push(String(text));
    },
    formatLatency: (value) => `${Math.round(Number(value) || 0)}ms`,
    consoleObject: {
      info: (...args) => infoCalls.push(args),
    },
    fetchImpl: async (...args) => {
      fetchCalls.push(args);
      return { ok: true };
    },
  });
  return {
    controller,
    latencyChip,
    documentObject,
    navigatorObject,
    infoCalls,
    activityCalls,
    beaconCalls,
    fetchCalls,
    localStorageState,
    sessionStorageState,
    setNow(value) {
      now = Number(value);
    },
    windowObject,
  };
}

test('createController reuses window boot metrics object and records stages', () => {
  const existing = { shellInlineStartMs: 50 };
  const windowObject = {
    __HERMES_BOOT_METRICS__: existing,
    performance: { now: () => 125 },
  };
  const controller = startupMetrics.createController({
    windowObject,
    latencyChip: { dataset: {} },
    setActivityChip: () => {},
    formatLatency: (value) => `${value}ms`,
    consoleObject: { info() {} },
  });

  assert.equal(controller.bootMetrics, existing);
  assert.equal(controller.recordBootMetric('customStageMs'), 125);
  assert.equal(existing.customStageMs, 125);
});

test('logBootStage updates the latency chip and emits a compact console payload', () => {
  const harness = buildHarness();
  harness.controller.recordBootMetric('shellInlineStartMs', 40);
  harness.setNow(175);

  const elapsed = harness.controller.logBootStage('auth-request-dispatched', { attempt: 2 });

  assert.equal(elapsed, 175);
  assert.equal(harness.latencyChip.dataset.bootStage, 'auth-request-dispatched');
  assert.equal(harness.latencyChip.textContent, 'open: 135ms');
  assert.deepEqual(harness.infoCalls[0], [
    '[miniapp/boot]',
    { stage: 'auth-request-dispatched', elapsedMs: 175, attempt: 2 },
  ]);
});

test('summarizeBootMetrics derives phase durations and environment hints from recorded timestamps', async () => {
  const harness = buildHarness();
  harness.controller.recordBootMetric('shellInlineStartMs', 1);
  harness.controller.recordBootMetric('appScriptStartMs', 10);
  harness.controller.recordBootMetric('version_check_startMs', 12);
  harness.controller.recordBootMetric('version_check_finishedMs', 28);
  harness.controller.recordBootMetric('auth_request_dispatchedMs', 30);
  harness.controller.recordBootMetric('auth_response_receivedMs', 90);
  harness.controller.recordBootMetric('auth_bootstrap_applied_startMs', 95);
  harness.controller.recordBootMetric('auth_bootstrap_applied_finishedMs', 130);
  harness.controller.recordBootMetric('initial_render_startMs', 140);
  harness.controller.recordBootMetric('initial_render_finishedMs', 175);
  harness.controller.recordBootMetric('shellRevealMs', 180);
  harness.controller.recordBootMetric('bootstrap_finishedMs', 220);
  harness.controller.recordBootMeta({
    authBootstrapAttempts: 2,
    authBootstrapRetryCount: 1,
    authBootstrapRetryBackoffMsTotal: 140,
    bootstrapHistoryCount: 64,
  });

  const summary = harness.controller.summarizeBootMetrics({ authenticated: true });

  assert.deepEqual({
    ...summary,
    bootSummaryId: '<dynamic>',
    bootSummaryRecordedAtMs: '<dynamic>',
  }, {
    shellToAppScriptMs: 9,
    appBootToAuthRequestMs: 20,
    preAuthVersionCheckMs: 16,
    shellToAuthRequestMs: 29,
    totalOpenMs: 210,
    authWaitMs: 60,
    authApplyMs: 35,
    firstRenderMs: 35,
    emptyRenderMs: null,
    shellRevealMs: 170,
    navigationType: 'navigate',
    transferSize: 4096,
    encodedBodySize: 2048,
    decodedBodySize: 8192,
    nextHopProtocol: 'h2',
    activationStartMs: 0,
    effectiveType: '4g',
    saveData: false,
    connectionRttMs: 75,
    visibilityState: 'visible',
    wasDiscarded: false,
    pageSessionId: summary.pageSessionId,
    pageSessionStorageReused: false,
    entryPathReason: 'fresh-open-or-unknown',
    entryPathSource: 'none',
    entryPathPreviousPageSessionId: '',
    entryPathAgeMs: null,
    authBootstrapAttempts: 2,
    authBootstrapRetryCount: 1,
    authBootstrapRetryBackoffMsTotal: 140,
    bootstrapHistoryCount: 64,
    authenticated: true,
    dominantPhase: 'authWaitMs',
    bootSummaryId: '<dynamic>',
    bootSummaryRecordedAtMs: '<dynamic>',
  });
  assert.deepEqual(harness.infoCalls.at(-1), ['[miniapp/boot-summary]', summary]);
  assert.equal(harness.windowObject.__HERMES_LAST_BOOT_SUMMARY__, summary);
  assert.equal(harness.windowObject.__HERMES_BOOT_SUMMARIES__.length, 1);
  await Promise.resolve();
  assert.equal(harness.fetchCalls.length, 1);
  const [url, options] = harness.fetchCalls[0];
  assert.equal(url, '/api/telemetry/boot');
  assert.equal(options.method, 'POST');
  assert.equal(options.keepalive, true);
  assert.equal(options.credentials, 'same-origin');
  assert.equal(options.headers['Content-Type'], 'application/json');
  assert.deepEqual(JSON.parse(options.body), summary);
  assert.equal(harness.beaconCalls.length, 1);
  assert.equal(harness.localStorageState.has('__HERMES_PENDING_BOOT_SUMMARIES__'), false);
  assert.match(summary.bootSummaryId, /^\d+-[0-9a-f]+$/);
  assert.equal(typeof summary.bootSummaryRecordedAtMs, 'number');
});

test('summarizeBootMetrics falls back to sendBeacon when keepalive fetch rejects', async () => {
  const harness = buildHarness();
  harness.fetchCalls.length = 0;
  const fetchErrors = [];
  const controller = startupMetrics.createController({
    windowObject: harness.windowObject,
    documentObject: harness.documentObject,
    navigatorObject: harness.navigatorObject,
    latencyChip: harness.latencyChip,
    setActivityChip: (chip, text) => {
      chip.textContent = String(text);
      chip.title = String(text);
      harness.activityCalls.push(String(text));
    },
    formatLatency: (value) => `${Math.round(Number(value) || 0)}ms`,
    consoleObject: { info: (...args) => harness.infoCalls.push(args) },
    fetchImpl: async (...args) => {
      harness.fetchCalls.push(args);
      fetchErrors.push('rejected');
      throw new Error('offline');
    },
  });
  controller.recordBootMetric('shellInlineStartMs', 1);
  controller.recordBootMetric('appScriptStartMs', 10);
  controller.recordBootMetric('bootstrap_finishedMs', 20);

  const summary = controller.summarizeBootMetrics({ authenticated: false });
  await Promise.resolve();
  await Promise.resolve();

  assert.equal(fetchErrors.length, 1);
  assert.equal(harness.fetchCalls.length, 1);
  assert.equal(harness.beaconCalls.length, 1);
  assert.equal(harness.beaconCalls[0].url, '/api/telemetry/boot');
  const beaconPayload = harness.beaconCalls[0].payload;
  const beaconText = typeof beaconPayload?.text === 'function'
    ? await beaconPayload.text()
    : beaconPayload;
  assert.deepEqual(JSON.parse(beaconText), summary);
  const queued = JSON.parse(harness.localStorageState.get('__HERMES_PENDING_BOOT_SUMMARIES__'));
  assert.equal(queued.length, 1);
  assert.equal(queued[0].bootSummaryId, summary.bootSummaryId);
});

test('summarizeBootMetrics falls back to sendBeacon when keepalive fetch is unavailable', async () => {
  const harness = buildHarness();
  const controller = startupMetrics.createController({
    windowObject: harness.windowObject,
    documentObject: harness.documentObject,
    navigatorObject: harness.navigatorObject,
    latencyChip: harness.latencyChip,
    setActivityChip: (chip, text) => {
      chip.textContent = String(text);
      chip.title = String(text);
      harness.activityCalls.push(String(text));
    },
    formatLatency: (value) => `${Math.round(Number(value) || 0)}ms`,
    consoleObject: { info: (...args) => harness.infoCalls.push(args) },
    fetchImpl: null,
  });
  controller.recordBootMetric('shellInlineStartMs', 1);
  controller.recordBootMetric('appScriptStartMs', 10);
  controller.recordBootMetric('bootstrap_finishedMs', 20);

  const summary = controller.summarizeBootMetrics({ authenticated: false });

  assert.equal(harness.fetchCalls.length, 0);
  assert.equal(harness.beaconCalls.length, 1);
  assert.equal(harness.beaconCalls[0].url, '/api/telemetry/boot');
  const beaconPayload = harness.beaconCalls[0].payload;
  const beaconText = typeof beaconPayload?.text === 'function'
    ? await beaconPayload.text()
    : beaconPayload;
  assert.deepEqual(JSON.parse(beaconText), summary);
  const queued = JSON.parse(harness.localStorageState.get('__HERMES_PENDING_BOOT_SUMMARIES__'));
  assert.equal(queued.length, 1);
  assert.equal(queued[0].bootSummaryId, summary.bootSummaryId);
});

test('flushPendingBootSummaries retries queued summaries on the next open and clears them after success', async () => {
  const harness = buildHarness();
  harness.localStorageState.set('__HERMES_PENDING_BOOT_SUMMARIES__', JSON.stringify([
    { bootSummaryId: 'queued-1', totalOpenMs: 7000, dominantPhase: 'authWaitMs' },
    { bootSummaryId: 'queued-2', totalOpenMs: 2200, dominantPhase: 'shellToAppScriptMs' },
  ]));

  const flushed = await harness.controller.flushPendingBootSummaries();

  assert.equal(flushed, true);
  assert.equal(harness.fetchCalls.length, 2);
  assert.equal(harness.localStorageState.has('__HERMES_PENDING_BOOT_SUMMARIES__'), false);
  assert.equal(JSON.parse(harness.fetchCalls[0][1].body).bootSummaryId, 'queued-1');
  assert.equal(JSON.parse(harness.fetchCalls[1][1].body).bootSummaryId, 'queued-2');
});

test('startup metrics infer host recreation after background from lifecycle markers', () => {
  const harness = buildHarness();
  harness.localStorageState.set('__HERMES_LIFECYCLE_MARKER__', JSON.stringify({
    type: 'backgrounded',
    ts: Date.now(),
    pageSessionId: 'page-prev',
    trigger: 'pagehide',
    visibilityState: 'hidden',
  }));

  const controller = startupMetrics.createController({
    windowObject: harness.windowObject,
    documentObject: harness.documentObject,
    navigatorObject: harness.navigatorObject,
    latencyChip: harness.latencyChip,
    setActivityChip: (chip, text) => {
      chip.textContent = String(text);
      chip.title = String(text);
    },
    formatLatency: (value) => `${Math.round(Number(value) || 0)}ms`,
    consoleObject: { info: (...args) => harness.infoCalls.push(args) },
    fetchImpl: null,
  });

  assert.equal(controller.bootMeta.entryPathReason, 'host-recreated-after-background');
  assert.equal(controller.bootMeta.entryPathSource, 'lifecycle-marker');
  assert.equal(controller.bootMeta.entryPathPreviousPageSessionId, 'page-prev');
  assert.equal(controller.bootMeta.lastLifecycleTrigger, 'pagehide');
  assert.equal(typeof controller.bootMeta.pageSessionId, 'string');
  assert.equal(controller.bootMeta.pageSessionStorageReused, true);
});

test('startup metrics mark lifecycle and version reload intent for future boot attribution', () => {
  const harness = buildHarness();

  const backgrounded = harness.controller.markBackgrounded({ trigger: 'pagehide' });
  const resumed = harness.controller.markVisibilityResume({ trigger: 'visibilitychange', pendingChatCount: 2 });
  const reloadIntent = harness.controller.markVersionSyncReloadIntent({ fromVersion: 'a1', toVersion: 'b2' });

  assert.equal(backgrounded.type, 'backgrounded');
  assert.equal(backgrounded.trigger, 'pagehide');
  assert.equal(resumed.type, 'visible-resume');
  assert.equal(resumed.pendingChatCount, 2);
  assert.equal(reloadIntent.reason, 'version-sync-reload');
  assert.equal(reloadIntent.fromVersion, 'a1');
  assert.equal(reloadIntent.toVersion, 'b2');
  assert.equal(JSON.parse(harness.localStorageState.get('__HERMES_LIFECYCLE_MARKER__')).type, 'backgrounded');
  assert.equal(JSON.parse(harness.localStorageState.get('__HERMES_RELOAD_INTENT__')).reason, 'version-sync-reload');
  assert.equal(harness.windowObject.__HERMES_LAST_VISIBILITY_RESUME__.type, 'visible-resume');
});

test('revealShell marks the document ready state and refreshes the latency chip', () => {
  const harness = buildHarness();
  harness.controller.recordBootMetric('shellInlineStartMs', 100);
  harness.setNow(160);

  harness.controller.revealShell();

  assert.equal(harness.documentObject.documentElement.attrs['data-shell-ready'], '1');
  assert.equal(harness.controller.bootMetrics.shellRevealMs, 160);
  assert.equal(harness.latencyChip.dataset.bootStage, 'shell-visible');
  assert.equal(harness.latencyChip.textContent, 'open: 60ms');
});
