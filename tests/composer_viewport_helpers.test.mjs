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

function buildHarness({
  mobileQuoteMode = false,
  withVisualViewport = true,
  isNearBottom = true,
  promptRect = { top: 470, bottom: 540 },
  formRect = { top: 430, bottom: 620 },
} = {}) {
  let nearBottom = Boolean(isNearBottom);
  const scrollByCalls = [];
  const timeoutCalls = [];
  const intervalCallbacks = [];
  const clearIntervalCalls = [];
  const clearTimeoutCalls = [];
  const windowResizeListeners = [];
  const windowBlurListeners = [];
  const windowPagehideListeners = [];
  const documentVisibilityListeners = [];
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
  const promptEl = createEventTarget({
    tagName: 'TEXTAREA',
    value: 'draft text',
    disabled: false,
    blurCalls: 0,
    focusCalls: [],
    selectionRanges: [],
    scrollTop: 0,
    scrollHeight: 320,
    clientHeight: 104,
    blur() {
      this.blurCalls += 1;
      documentObject.activeElement = documentObject.body;
    },
    focus(options) {
      this.focusCalls.push(options ?? null);
      documentObject.activeElement = this;
    },
    setSelectionRange(start, end) {
      this.selectionRanges.push([start, end]);
    },
    getBoundingClientRect() {
      return promptRect;
    },
  });
  const form = {
    scrollIntoViewCalls: [],
    scrollIntoView(options) {
      this.scrollIntoViewCalls.push(options);
    },
    getBoundingClientRect() {
      return formRect;
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
      } else if (type === 'blur') {
        windowBlurListeners.push(handler);
      } else if (type === 'pagehide') {
        windowPagehideListeners.push(handler);
      }
    },
    requestAnimationFrame(callback) {
      callback();
      return 1;
    },
  };
  const cssVarUpdates = [];
  const documentObject = {
    activeElement: null,
    visibilityState: 'visible',
    body: { nodeName: 'BODY' },
    documentElement: {
      style: {
        setProperty(name, value) {
          cssVarUpdates.push([name, value]);
        },
      },
    },
    addEventListener(type, handler) {
      if (type === 'visibilitychange') {
        documentVisibilityListeners.push(handler);
      }
    },
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
    mobileQuoteMode,
    isNearBottomFn: () => nearBottom,
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
    queryTargets,
    visualViewport,
    scrollByCalls,
    timeoutCalls,
    intervalCallbacks,
    clearIntervalCalls,
    clearTimeoutCalls,
    windowResizeListeners,
    windowBlurListeners,
    windowPagehideListeners,
    documentVisibilityListeners,
    telegramViewportHandlers,
    cssVarUpdates,
    chatScrollTop,
    chatStickToBottom,
    jumpVisibilityUpdates,
    get activeChatId() {
      return activeChatId;
    },
    set activeChatId(value) {
      activeChatId = value;
    },
    get isNearBottom() {
      return nearBottom;
    },
    setIsNearBottom(value) {
      nearBottom = Boolean(value);
    },
  };
}

test('ensureComposerVisible scrolls form into view and corrects composer overflow using the full form bounds', () => {
  const harness = buildHarness();

  harness.controller.ensureComposerVisible({ smooth: true });

  assert.deepEqual(harness.form.scrollIntoViewCalls, [
    { block: 'end', inline: 'nearest', behavior: 'smooth' },
  ]);
  assert.deepEqual(harness.scrollByCalls, [
    { top: 130, left: 0, behavior: 'auto' },
  ]);
});

test('ensureComposerVisible keeps a fully visible textarea stable when the overall composer is taller than the viewport', () => {
  const harness = buildHarness({
    promptRect: { top: 180, bottom: 250 },
    formRect: { top: 40, bottom: 620 },
  });

  harness.controller.ensureComposerVisible();

  assert.deepEqual(harness.form.scrollIntoViewCalls, [
    { block: 'end', inline: 'nearest', behavior: 'auto' },
  ]);
  assert.deepEqual(harness.scrollByCalls, []);
});

test('ensureComposerVisible prioritizes the textarea bounds when the full composer cannot fit in the viewport', () => {
  const harness = buildHarness({
    promptRect: { top: 420, bottom: 530 },
    formRect: { top: 220, bottom: 760 },
  });

  harness.controller.ensureComposerVisible();

  assert.deepEqual(harness.form.scrollIntoViewCalls, [
    { block: 'end', inline: 'nearest', behavior: 'auto' },
  ]);
  assert.deepEqual(harness.scrollByCalls, [
    { top: 40, left: 0, behavior: 'auto' },
  ]);
});

test('focusComposerForNewChat retries focus for the active visible chat and keeps the caret at the end', () => {
  const harness = buildHarness();
  harness.documentObject.activeElement = harness.documentObject.body;

  harness.controller.focusComposerForNewChat(7);

  assert.deepEqual(harness.promptEl.focusCalls, [{ preventScroll: true }, { preventScroll: true }, { preventScroll: true }, { preventScroll: true }]);
  assert.deepEqual(harness.promptEl.selectionRanges, [[10, 10], [10, 10], [10, 10], [10, 10]]);
  assert.deepEqual(harness.timeoutCalls.slice(0, 2), [0, 180]);
  assert.ok(harness.form.scrollIntoViewCalls.length >= 3);
});

test('focusComposerForNewChat skips retries when a dialog is open after the initial focus', () => {
  const harness = buildHarness();
  harness.documentObject.activeElement = harness.documentObject.body;
  harness.queryTargets['dialog[open]'] = { nodeName: 'DIALOG' };

  harness.controller.focusComposerForNewChat(7);

  assert.deepEqual(harness.promptEl.focusCalls, [{ preventScroll: true }]);
  assert.deepEqual(harness.timeoutCalls.slice(0, 2), [0, 180]);
});

test('focusComposerAfterQuoteInsertion uses a longer retry burst so quote insertion leaves the composer focused and caret-ready on mobile', () => {
  const harness = buildHarness({ mobileQuoteMode: true });
  harness.documentObject.activeElement = harness.documentObject.body;
  harness.promptEl.value = 'quote block plus draft';

  harness.controller.focusComposerAfterQuoteInsertion(7);

  assert.deepEqual(harness.promptEl.focusCalls, [null, null, null, null, null, null, null, null]);
  assert.deepEqual(harness.promptEl.selectionRanges, [[7, 7], [7, 7], [7, 7], [7, 7], [7, 7], [7, 7], [7, 7], [7, 7]]);
  assert.deepEqual(harness.timeoutCalls, [0, 90, 220, 420, 700, 1000]);
  assert.ok(harness.form.scrollIntoViewCalls.length >= 7);
});

test('focusComposerAfterQuoteInsertion on desktop avoids preventScroll focus and reveals the caret at the lower quote follow-up lines', () => {
  const harness = buildHarness({ mobileQuoteMode: false });
  harness.documentObject.activeElement = harness.documentObject.body;
  harness.promptEl.value = 'quoted draft with breathing room';
  harness.promptEl.scrollTop = 0;
  const caret = harness.promptEl.value.length;

  harness.controller.focusComposerAfterQuoteInsertion(caret);

  assert.equal(harness.promptEl.focusCalls[0], null);
  assert.deepEqual(harness.promptEl.selectionRanges[0], [caret, caret]);
  assert.equal(harness.promptEl.scrollTop, harness.promptEl.scrollHeight - harness.promptEl.clientHeight);
  assert.ok(harness.form.scrollIntoViewCalls.length >= 2);
});

test('focusComposerAfterQuoteInsertion skips retries when a dialog opens after the initial focus', () => {
  const harness = buildHarness({ mobileQuoteMode: true });
  harness.documentObject.activeElement = harness.documentObject.body;
  harness.queryTargets['dialog[open]'] = { nodeName: 'DIALOG' };

  harness.controller.focusComposerAfterQuoteInsertion(4);

  assert.deepEqual(harness.promptEl.focusCalls, [null]);
  assert.deepEqual(harness.promptEl.selectionRanges, [[4, 4]]);
  assert.deepEqual(harness.timeoutCalls, [0, 90, 220, 420, 700, 1000]);
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

test('installKeyboardViewportSync wires focus/viewport listeners, sync burst timers, and viewport css vars', () => {
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
  assert.deepEqual(harness.cssVarUpdates.slice(0, 2), [
    ['--hermes-visual-viewport-height', '500px'],
    ['--hermes-visual-viewport-top', '0px'],
  ]);
});

test('installKeyboardViewportSync focuses the composer on guarded mobile prompt tap', () => {
  const harness = buildHarness({ mobileQuoteMode: true });

  harness.controller.installKeyboardViewportSync();
  harness.promptEl.dispatch('touchstart', { touches: [{ clientX: 20, clientY: 30 }] });
  harness.promptEl.dispatch('touchend', { changedTouches: [{ clientX: 24, clientY: 34 }] });

  assert.deepEqual(harness.promptEl.focusCalls, [null]);
  assert.equal(harness.documentObject.activeElement, harness.promptEl);
  assert.deepEqual(harness.timeoutCalls, [90, 220, 420, 700, 1000]);
  assert.deepEqual(harness.intervalCallbacks.map((entry) => entry.delay), [140]);
});

test('installKeyboardViewportSync does not cancel native mobile prompt touch defaults', () => {
  const harness = buildHarness({ mobileQuoteMode: true });
  const touchStartEvent = {
    touches: [{ clientX: 20, clientY: 30 }],
    preventDefaultCalled: false,
    preventDefault() {
      this.preventDefaultCalled = true;
    },
  };
  const touchEndEvent = {
    changedTouches: [{ clientX: 24, clientY: 34 }],
    preventDefaultCalled: false,
    preventDefault() {
      this.preventDefaultCalled = true;
    },
  };

  harness.controller.installKeyboardViewportSync();
  harness.promptEl.dispatch('touchstart', touchStartEvent);
  harness.promptEl.dispatch('touchend', touchEndEvent);

  assert.equal(touchStartEvent.preventDefaultCalled, false);
  assert.equal(touchEndEvent.preventDefaultCalled, false);
  assert.equal(harness.documentObject.activeElement, harness.promptEl);
});

test('installKeyboardViewportSync re-arms composer reveal sync when a mobile user touches an already-focused prompt', () => {
  const harness = buildHarness({ mobileQuoteMode: true });

  harness.controller.installKeyboardViewportSync();
  harness.promptEl.dispatch('touchstart', { touches: [{ clientX: 20, clientY: 30 }] });
  harness.promptEl.dispatch('touchend', { changedTouches: [{ clientX: 24, clientY: 34 }] });
  assert.deepEqual(harness.intervalCallbacks.map((entry) => entry.delay), [140]);

  harness.promptEl.focusCalls.length = 0;
  harness.form.scrollIntoViewCalls.length = 0;
  harness.scrollByCalls.length = 0;
  harness.promptEl.dispatch('touchstart', { touches: [{ clientX: 24, clientY: 34 }] });
  harness.visualViewport.dispatch('resize');

  assert.deepEqual(harness.clearIntervalCalls, []);
  assert.deepEqual(harness.promptEl.focusCalls, []);
  assert.ok(harness.form.scrollIntoViewCalls.length >= 2);
  assert.ok(harness.scrollByCalls.length >= 1);
});


test('installKeyboardViewportSync clears interval on blur', () => {
  const harness = buildHarness();

  harness.controller.installKeyboardViewportSync();
  harness.documentObject.activeElement = harness.promptEl;
  harness.promptEl.dispatch('focus');
  harness.promptEl.dispatch('blur');

  assert.deepEqual(harness.clearIntervalCalls, [1]);
});

test('installKeyboardViewportSync clears sync state and blurs focused mobile composer when the app backgrounds', () => {
  const harness = buildHarness({ mobileQuoteMode: true });

  harness.controller.installKeyboardViewportSync();
  harness.promptEl.dispatch('touchstart', { touches: [{ clientX: 20, clientY: 30 }] });
  harness.promptEl.dispatch('touchend', { changedTouches: [{ clientX: 24, clientY: 34 }] });
  harness.documentObject.activeElement = harness.promptEl;
  harness.promptEl.focusCalls.length = 0;
  harness.form.scrollIntoViewCalls.length = 0;

  harness.documentObject.visibilityState = 'hidden';
  harness.documentVisibilityListeners[0]();

  assert.equal(harness.promptEl.blurCalls, 1);
  assert.equal(harness.documentObject.activeElement, harness.documentObject.body);
  assert.deepEqual(harness.clearIntervalCalls, [1]);

  harness.documentObject.visibilityState = 'visible';
  harness.visualViewport.dispatch('resize');

  assert.deepEqual(harness.promptEl.focusCalls, []);
  assert.equal(harness.form.scrollIntoViewCalls.length, 0);
});

test('installKeyboardViewportSync stops interval sync when user is no longer near bottom', () => {
  const harness = buildHarness();

  harness.controller.installKeyboardViewportSync();
  harness.documentObject.activeElement = harness.promptEl;
  harness.promptEl.dispatch('focus');
  harness.form.scrollIntoViewCalls.length = 0;
  harness.scrollByCalls.length = 0;
  harness.setIsNearBottom(false);

  harness.intervalCallbacks[0].callback();

  assert.equal(harness.form.scrollIntoViewCalls.length, 0);
  assert.equal(harness.scrollByCalls.length, 0);
  assert.deepEqual(harness.clearIntervalCalls, [1]);
});

test('installKeyboardViewportSync ignores viewport shifts while user is reading older messages', () => {
  const harness = buildHarness({ isNearBottom: false });

  harness.controller.installKeyboardViewportSync();
  harness.documentObject.activeElement = harness.promptEl;
  harness.telegramViewportHandlers[0].handler();
  harness.visualViewport.dispatch('resize');
  harness.windowResizeListeners[0]();

  assert.equal(harness.form.scrollIntoViewCalls.length, 0);
  assert.equal(harness.scrollByCalls.length, 0);
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

test('preserveViewportDuringUiMutation does not snap to bottom when cached stickiness is stale', () => {
  const harness = buildHarness({ isNearBottom: false });
  harness.messagesEl.scrollTop = 220;
  harness.chatStickToBottom.set(7, true);

  harness.controller.preserveViewportDuringUiMutation(() => {
    harness.messagesEl.scrollHeight = 1500;
  });

  assert.equal(harness.messagesEl.scrollTop, 220);
  assert.equal(harness.chatScrollTop.get(7), 220);
  assert.equal(harness.chatStickToBottom.get(7), false);
});
