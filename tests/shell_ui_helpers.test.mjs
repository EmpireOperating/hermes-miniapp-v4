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
    appendSystemMessage: (text) => messages.push(String(text)),
    scheduleTimeout: (callback, delay) => {
      timeouts.push(delay);
      callback();
      return timeouts.length;
    },
  });

  return {
    controller,
    tg,
    pendingChats,
    fullscreenButton,
    messages,
    timeouts,
  };
}

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
