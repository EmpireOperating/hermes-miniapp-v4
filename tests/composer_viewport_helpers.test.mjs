import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const composerViewport = require('../static/composer_viewport_helpers.js');

function createEventTarget(initial = {}) {
  const listeners = new Map();
  return {
    ...initial,
    addEventListener(type, handler, options = undefined) {
      const bucket = listeners.get(type) || [];
      bucket.push({ handler, options });
      listeners.set(type, bucket);
    },
    listeners(type) {
      return listeners.get(type) || [];
    },
    dispatch(type, event = {}) {
      for (const entry of listeners.get(type) || []) {
        entry.handler({ currentTarget: this, target: this, preventDefault() {}, ...event });
      }
    },
  };
}

function buildHarness({ mobileQuoteMode = false, withVisualViewport = true } = {}) {
  const scrollByCalls = [];
  const timeoutCalls = [];
  const intervalCallbacks = [];
  const clearIntervalCalls = [];
  const clearTimeoutCalls = [];
  const windowResizeListeners = [];
  const telegramViewportHandlers = [];
  const jumpVisibilityUpdates = [];
  const queryTargets = {
    '.masthead': createEventTarget({ name: 'masthead' }),
    '.sidebar': createEventTarget({ name: 'sidebar' }),
  };
  const messagesEl = createEventTarget({
    name: 'messages',
    scrollTop: 0,
    scrollHeight: 1200,
  });
  const tabsEl = createEventTarget({ name: 'tabs' });
  const toolStreamEl = createEventTarget({ name: 'tool' });
  const promptEl = createEventTarget({
    tagName: 'TEXTAREA',
    blurCalls: 0,
    blur() {
      this.blurCalls += 1;
    },
    getBoundingClientRect() {
      return { top: 470, bottom: 540 };
    },
  });
  const form = {
    scrollIntoViewCalls: [],
    scrollIntoView(options) {
      this.scrollIntoViewCalls.push(options);
    },
  };
  const visualViewport = withVisualViewport
    ? createEventTarget({ offsetTop: 0, height: 500 })
    : null;
  const windowObject = {
    innerHeight: 800,
    visualViewport,
    scrollY: 0,
    scrollBy(payload) {
      scrollByCalls.push(payload);
    },
    scrollTo(payload) {
      this.scrollY = Number(payload?.top || 0);
    },
    setTimeout(callback, delay) {
      timeoutCalls.push(delay);
      callback();
      return timeoutCalls.length;
    },
    clearTimeout(id) {
      clearTimeoutCalls.push(id);
    },
    setInterval(callback, delay) {
      intervalCallbacks.push({ callback, delay });
      return intervalCallbacks.length;
    },
    clearInterval(id) {
      clearIntervalCalls.push(id);
    },
    addEventListener(type, handler) {
      if (type === 'resize') {
        windowResizeListeners.push(handler);
      }
    },
    requestAnimationFrame(callback) {
      callback();
      return 1;
    },
  };
  const documentObject = {
    activeElement: null,
    visibilityState: 'visible',
    querySelector(selector) {
      return queryTargets[selector] || null;
    },
  };
  const tg = {
    onEvent(name, handler) {
      telegramViewportHandlers.push({ name, handler });
    },
  };

  const chatScrollTop = new Map();
  const chatStickToBottom = new Map();
  let activeChatId = 7;

  const controller = composerViewport.createController({
    windowObject,
    documentObject,
    tg,
    promptEl,
    form,
    messagesEl,
    tabsEl,
    toolStreamEl,
    mobileQuoteMode,
    isNearBottomFn: () => true,
    getActiveChatId: () => activeChatId,
    chatScrollTop,
    chatStickToBottom,
    updateJumpLatestVisibility: () => {
      jumpVisibilityUpdates.push(true);
    },
  });

  return {
    controller,
    windowObject,
    documentObject,
    tg,
    promptEl,
    form,
    messagesEl,
    tabsEl,
    toolStreamEl,
    queryTargets,
    visualViewport,
    scrollByCalls,
    timeoutCalls,
    intervalCallbacks,
    clearIntervalCalls,
    clearTimeoutCalls,
    windowResizeListeners,
    telegramViewportHandlers,
    chatScrollTop,
    chatStickToBottom,
    jumpVisibilityUpdates,
    get activeChatId() {
      return activeChatId;
    },
    set activeChatId(value) {
      activeChatId = value;
    },
  };
}

test('ensureComposerVisible scrolls form into view and corrects viewport overflow', () => {
  const harness = buildHarness();

  harness.controller.ensureComposerVisible({ smooth: true });

  assert.deepEqual(harness.form.scrollIntoViewCalls, [
    { block: 'end', inline: 'nearest', behavior: 'smooth' },
  ]);
  assert.deepEqual(harness.scrollByCalls, [
    { top: 50, left: 0, behavior: 'auto' },
  ]);
});

test('dismissKeyboard blurs active text entry element', () => {
  const harness = buildHarness();
  harness.documentObject.activeElement = harness.promptEl;

  harness.controller.dismissKeyboard();

  assert.equal(harness.promptEl.blurCalls, 1);
});

test('installTapToDismissKeyboard skips touchstart on messages in mobile quote mode', () => {
  const harness = buildHarness({ mobileQuoteMode: true });

  harness.controller.installTapToDismissKeyboard();

  assert.equal(harness.messagesEl.listeners('touchstart').length, 0);
  assert.equal(harness.messagesEl.listeners('click').length, 1);
  assert.equal(harness.tabsEl.listeners('touchstart').length, 1);
  assert.equal(harness.queryTargets['.masthead'].listeners('touchstart').length, 1);
});

test('installKeyboardViewportSync wires focus/viewport listeners and sync burst timers', () => {
  const harness = buildHarness();

  harness.controller.installKeyboardViewportSync();
  harness.documentObject.activeElement = harness.promptEl;
  harness.promptEl.dispatch('focus');

  assert.deepEqual(harness.timeoutCalls, [90, 220, 420, 700, 1000]);
  assert.deepEqual(harness.intervalCallbacks.map((entry) => entry.delay), [140]);
  assert.equal(harness.visualViewport.listeners('resize').length, 1);
  assert.equal(harness.visualViewport.listeners('scroll').length, 1);
  assert.equal(harness.windowResizeListeners.length, 1);
  assert.deepEqual(harness.telegramViewportHandlers.map((entry) => entry.name), ['viewportChanged']);
});

test('installKeyboardViewportSync clears interval on blur', () => {
  const harness = buildHarness();

  harness.controller.installKeyboardViewportSync();
  harness.documentObject.activeElement = harness.promptEl;
  harness.promptEl.dispatch('focus');
  harness.promptEl.dispatch('blur');

  assert.deepEqual(harness.clearIntervalCalls, [1]);
});

test('runAfterUiMutation schedules RAF + visibility timeout fallback', () => {
  const harness = buildHarness();
  let callbackCount = 0;

  harness.controller.runAfterUiMutation(() => {
    callbackCount += 1;
  });

  assert.equal(callbackCount, 1);
  assert.ok(harness.timeoutCalls.includes(34));
});

test('preserveViewportDuringUiMutation keeps scroll pinned and updates chat viewport bookkeeping', () => {
  const harness = buildHarness();
  harness.messagesEl.scrollTop = 220;
  harness.chatStickToBottom.set(7, true);

  let mutatorRuns = 0;
  harness.controller.preserveViewportDuringUiMutation(() => {
    mutatorRuns += 1;
    harness.messagesEl.scrollHeight = 1500;
  });

  assert.equal(mutatorRuns, 1);
  assert.equal(harness.messagesEl.scrollTop, 1500);
  assert.equal(harness.chatScrollTop.get(7), 1500);
  assert.equal(harness.chatStickToBottom.get(7), true);
  assert.ok(harness.jumpVisibilityUpdates.length >= 1);
});
