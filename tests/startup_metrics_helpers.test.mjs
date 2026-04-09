import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const startupMetrics = require('../static/startup_metrics_helpers.js');

function buildHarness() {
  const infoCalls = [];
  const activityCalls = [];
  const latencyChip = { dataset: {}, textContent: '', title: '' };
  const documentObject = {
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
    },
  };
  const controller = startupMetrics.createController({
    windowObject,
    documentObject,
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
  });
  return {
    controller,
    latencyChip,
    documentObject,
    infoCalls,
    activityCalls,
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

test('summarizeBootMetrics derives phase durations from recorded timestamps', () => {
  const harness = buildHarness();
  harness.controller.recordBootMetric('appScriptStartMs', 10);
  harness.controller.recordBootMetric('auth_request_dispatchedMs', 30);
  harness.controller.recordBootMetric('auth_response_receivedMs', 90);
  harness.controller.recordBootMetric('auth_bootstrap_applied_startMs', 95);
  harness.controller.recordBootMetric('auth_bootstrap_applied_finishedMs', 130);
  harness.controller.recordBootMetric('initial_render_startMs', 140);
  harness.controller.recordBootMetric('initial_render_finishedMs', 175);
  harness.controller.recordBootMetric('shellRevealMs', 180);
  harness.controller.recordBootMetric('bootstrap_finishedMs', 220);

  const summary = harness.controller.summarizeBootMetrics({ authenticated: true });

  assert.deepEqual(summary, {
    totalOpenMs: 210,
    authWaitMs: 60,
    authApplyMs: 35,
    firstRenderMs: 35,
    emptyRenderMs: null,
    shellRevealMs: 170,
    authenticated: true,
  });
  assert.deepEqual(harness.infoCalls.at(-1), ['[miniapp/boot-summary]', summary]);
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
