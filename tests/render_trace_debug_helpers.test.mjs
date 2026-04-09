import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const renderTraceDebugHelpers = require('../static/render_trace_debug_helpers.js');

function createHarness({
  href = 'https://example.test/app?render_trace=1',
  search = '?render_trace=1',
  stored = null,
} = {}) {
  const state = { enabled: false };
  const storage = new Map();
  if (stored != null) {
    storage.set('hermes_render_trace_debug', stored);
  }
  const localStorageRef = {
    getItem(key) {
      return storage.has(key) ? storage.get(key) : null;
    },
    setItem(key, value) {
      storage.set(key, String(value));
    },
    removeItem(key) {
      storage.delete(key);
    },
  };
  const badge = {
    hidden: true,
    dataset: {},
    attributes: new Map(),
    textContent: '',
    title: '',
    setAttribute(name, value) {
      this.attributes.set(name, String(value));
    },
  };
  const replaceCalls = [];
  const infoCalls = [];

  const windowObject = {
    location: { href, search },
    history: {
      state: { session: 1 },
      replaceState(stateArg, titleArg, urlArg) {
        replaceCalls.push([stateArg, titleArg, urlArg]);
      },
    },
  };

  const controller = renderTraceDebugHelpers.createController({
    windowObject,
    localStorageRef,
    renderTraceBadge: badge,
    storageKey: 'hermes_render_trace_debug',
    getRenderTraceDebugEnabled: () => state.enabled,
    setRenderTraceDebugEnabledState: (value) => {
      state.enabled = Boolean(value);
    },
    consoleRef: {
      info(...args) {
        infoCalls.push(args);
      },
    },
  });

  return {
    controller,
    state,
    storage,
    badge,
    replaceCalls,
    infoCalls,
  };
}

test('resolveRenderTraceDebugEnabled honors query param and persists preference', () => {
  const harness = createHarness({ href: 'https://example.test/app?render_trace=1', search: '?render_trace=1' });

  const enabled = harness.controller.resolveRenderTraceDebugEnabled();

  assert.equal(enabled, true);
  assert.equal(harness.storage.get('hermes_render_trace_debug'), '1');
});

test('setRenderTraceDebugEnabled updates state, badge, storage, and URL', () => {
  const harness = createHarness({ href: 'https://example.test/app?foo=1', search: '?foo=1' });

  harness.controller.setRenderTraceDebugEnabled(true);

  assert.equal(harness.state.enabled, true);
  assert.equal(harness.badge.hidden, false);
  assert.equal(harness.badge.dataset.enabled, 'true');
  assert.equal(harness.badge.attributes.get('aria-pressed'), 'true');
  assert.equal(harness.storage.get('hermes_render_trace_debug'), '1');
  assert.equal(harness.replaceCalls.length, 1);
  assert.match(harness.replaceCalls[0][2], /render_trace=1/);
});

test('handleRenderTraceBadgeClick toggles state and logs transitions', () => {
  const harness = createHarness({ href: 'https://example.test/app', search: '' });

  harness.controller.handleRenderTraceBadgeClick();
  harness.controller.handleRenderTraceBadgeClick();

  assert.equal(harness.infoCalls.length, 2);
  assert.equal(harness.infoCalls[0][0], '[render-trace] debug-enabled');
  assert.equal(harness.infoCalls[1][0], '[render-trace] debug-disabled');
});

test('renderTraceLog only logs when enabled', () => {
  const harness = createHarness({ href: 'https://example.test/app', search: '' });

  harness.controller.renderTraceLog('before');
  harness.controller.setRenderTraceDebugEnabled(true, { persist: false, updateUrl: false });
  harness.controller.renderTraceLog('after', { count: 1 });

  const traceEntries = harness.infoCalls.filter((entry) => String(entry[0]).includes('[render-trace]'));
  assert.equal(traceEntries.length, 1);
  assert.equal(traceEntries[0][0], '[render-trace] after');
  assert.deepEqual(traceEntries[0][1], { count: 1 });
});

