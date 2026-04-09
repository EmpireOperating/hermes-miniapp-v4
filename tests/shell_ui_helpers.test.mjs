import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const shellUi = require('../static/shell_ui_helpers.js');

function buildHarness(overrides = {}) {
  const pendingChats = new Set(overrides.pendingChats || []);
  const messages = [];
  const timeouts = [];
  const fullscreenButton = { textContent: '', title: '' };
  const devAuthControls = {
    attributes: new Map(),
    setAttribute(name, value) {
      this.attributes.set(name, value);
    },
    removeAttribute(name) {
      this.attributes.delete(name);
    },
  };
  const devModeBadge = {
    attributes: new Map(),
    setAttribute(name, value) {
      this.attributes.set(name, value);
    },
    removeAttribute(name) {
      this.attributes.delete(name);
    },
  };
  const confirmCalls = [];
  const windowObject = {
    confirm: (message) => {
      confirmCalls.push(String(message));
      return true;
    },
    ...overrides.windowObject,
  };
  const popupCalls = [];
  const tg = {
    isVersionAtLeast: () => true,
    enableClosingConfirmationCalls: 0,
    disableClosingConfirmationCalls: 0,
    setHeaderColorCalls: [],
    setBackgroundColorCalls: [],
    requestFullscreenCalls: 0,
    exitFullscreenCalls: 0,
    closeCalls: 0,
    isFullscreen: false,
    showPopup(config, callback) {
      popupCalls.push(config);
      callback('ok');
    },
    enableClosingConfirmation() {
      this.enableClosingConfirmationCalls += 1;
    },
    disableClosingConfirmation() {
      this.disableClosingConfirmationCalls += 1;
    },
    setHeaderColor(value) {
      this.setHeaderColorCalls.push(value);
    },
    setBackgroundColor(value) {
      this.setBackgroundColorCalls.push(value);
    },
    requestFullscreen() {
      this.requestFullscreenCalls += 1;
    },
    exitFullscreen() {
      this.exitFullscreenCalls += 1;
    },
    close() {
      this.closeCalls += 1;
    },
    ...overrides.tg,
  };

  const controller = shellUi.createController({
    tg,
    pendingChats,
    fullscreenAppTopButton: fullscreenButton,
    devAuthControls,
    devModeBadge,
    devConfig: overrides.devConfig || {},
    desktopTestingRequested: Boolean(overrides.desktopTestingRequested),
    appendSystemMessage: (text) => messages.push(String(text)),
    scheduleTimeout: (callback, delay) => {
      timeouts.push(delay);
      callback();
      return timeouts.length;
    },
    windowObject,
  });

  return {
    controller,
    tg,
    pendingChats,
    fullscreenButton,
    devAuthControls,
    devModeBadge,
    messages,
    timeouts,
    windowObject,
    confirmCalls,
    popupCalls,
  };
}

test('setElementHidden toggles hidden attribute idempotently', () => {
  const harness = buildHarness();

  harness.controller.setElementHidden(harness.devAuthControls, true);
  assert.equal(harness.devAuthControls.attributes.get('hidden'), 'hidden');

  harness.controller.setElementHidden(harness.devAuthControls, false);
  assert.equal(harness.devAuthControls.attributes.has('hidden'), false);
});

test('syncDebugOnlyPillVisibility shows dev pills only for requested desktop testing modes', () => {
  const harness = buildHarness({
    desktopTestingRequested: true,
    devConfig: {
      devAuthEnabled: true,
      requestDebug: false,
    },
  });

  harness.controller.syncDebugOnlyPillVisibility();

  assert.equal(harness.devAuthControls.attributes.has('hidden'), false);
  assert.equal(harness.devModeBadge.attributes.get('hidden'), 'hidden');
});

test('syncDebugOnlyPillVisibility hides debug pills outside desktop testing', () => {
  const harness = buildHarness({
    desktopTestingRequested: false,
    devConfig: {
      devAuthEnabled: true,
      requestDebug: true,
    },
  });

  harness.controller.syncDebugOnlyPillVisibility();

  assert.equal(harness.devAuthControls.attributes.get('hidden'), 'hidden');
  assert.equal(harness.devModeBadge.attributes.get('hidden'), 'hidden');
});

test('syncClosingConfirmation enables confirmation when chat work is pending', () => {
  const harness = buildHarness({ pendingChats: [5] });

  harness.controller.syncClosingConfirmation();

  assert.equal(harness.tg.enableClosingConfirmationCalls, 1);
  assert.equal(harness.tg.disableClosingConfirmationCalls, 0);
});

test('syncClosingConfirmation disables confirmation when there is no pending work', () => {
  const harness = buildHarness();

  harness.controller.syncClosingConfirmation();

  assert.equal(harness.tg.enableClosingConfirmationCalls, 0);
  assert.equal(harness.tg.disableClosingConfirmationCalls, 1);
});

test('syncTelegramChromeForSkin applies palette colors and falls back to terminal', () => {
  const harness = buildHarness();

  harness.controller.syncTelegramChromeForSkin('oracle');
  harness.controller.syncTelegramChromeForSkin('unknown');

  assert.deepEqual(harness.tg.setHeaderColorCalls, ['#140f1b', '#0f1218']);
  assert.deepEqual(harness.tg.setBackgroundColorCalls, ['#09070c', '#0b0d12']);
});

test('syncFullscreenControlState updates top button icon and tooltip', () => {
  const harness = buildHarness();

  harness.controller.syncFullscreenControlState();
  assert.equal(harness.fullscreenButton.textContent, '⛶');
  assert.equal(harness.fullscreenButton.title, 'Enter fullscreen');

  harness.tg.isFullscreen = true;
  harness.controller.syncFullscreenControlState();
  assert.equal(harness.fullscreenButton.textContent, '🗗');
  assert.equal(harness.fullscreenButton.title, 'Exit fullscreen');
});

test('handleFullscreenToggle requests fullscreen and schedules state sync', () => {
  const harness = buildHarness();

  harness.controller.handleFullscreenToggle();

  assert.equal(harness.tg.requestFullscreenCalls, 1);
  assert.deepEqual(harness.timeouts, [120]);
  assert.equal(harness.messages.length, 0);
});

test('handleFullscreenToggle exits fullscreen when already fullscreen', () => {
  const harness = buildHarness({
    tg: {
      isFullscreen: true,
    },
  });

  harness.controller.handleFullscreenToggle();

  assert.equal(harness.tg.exitFullscreenCalls, 1);
  assert.equal(harness.tg.requestFullscreenCalls, 0);
});

test('handleFullscreenToggle reports unsupported clients', () => {
  const harness = buildHarness({
    tg: {
      requestFullscreen: null,
    },
  });

  harness.controller.handleFullscreenToggle();

  assert.deepEqual(harness.messages, ['Fullscreen is not supported by this Telegram client.']);
});

test('confirmAction prefers Telegram popup confirmation when available', async () => {
  const harness = buildHarness();

  const confirmed = await harness.controller.confirmAction('Close this chat?');

  assert.equal(confirmed, true);
  assert.equal(harness.popupCalls.length, 1);
  assert.equal(harness.popupCalls[0].title, 'Confirm');
  assert.equal(harness.popupCalls[0].message, 'Close this chat?');
  assert.deepEqual(harness.confirmCalls, []);
});

test('confirmAction falls back to window.confirm when Telegram popup is unavailable', async () => {
  const harness = buildHarness({
    tg: {
      showPopup: null,
    },
  });

  const confirmed = await harness.controller.confirmAction('Close this chat?');

  assert.equal(confirmed, true);
  assert.deepEqual(harness.confirmCalls, ['Close this chat?']);
  assert.equal(harness.popupCalls.length, 0);
});

test('handleCloseApp closes the telegram web app when available', () => {
  const harness = buildHarness();

  harness.controller.handleCloseApp();

  assert.equal(harness.tg.closeCalls, 1);
  assert.equal(harness.messages.length, 0);
});

test('handleCloseApp reports unsupported clients', () => {
  const harness = buildHarness({
    tg: {
      close: null,
    },
  });

  harness.controller.handleCloseApp();

  assert.deepEqual(harness.messages, ['Close action is not available on this Telegram client.']);
});

test('confirmAction prefers Telegram popup flow when available', async () => {
  const popupCalls = [];
  const harness = buildHarness({
    tg: {
      showPopup(config, callback) {
        popupCalls.push(config);
        callback('ok');
      },
    },
    windowObject: {
      confirm: () => false,
    },
  });

  const result = await harness.controller.confirmAction('Close this chat?');

  assert.equal(result, true);
  assert.equal(harness.confirmCalls.length, 0);
  assert.deepEqual(popupCalls, [{
    title: 'Confirm',
    message: 'Close this chat?',
    buttons: [
      { id: 'cancel', type: 'cancel' },
      { id: 'ok', type: 'destructive', text: 'Close' },
    ],
  }]);
});

test('confirmAction falls back to window.confirm when Telegram popup is unavailable', async () => {
  const harness = buildHarness({
    tg: {
      showPopup: null,
    },
    windowObject: {
      confirm: (message) => {
        harness.confirmCalls.push(String(message));
        return false;
      },
    },
  });

  const result = await harness.controller.confirmAction('Close this chat?');

  assert.equal(result, false);
  assert.deepEqual(harness.confirmCalls, ['Close this chat?']);
});
