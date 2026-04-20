import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const visualDevAttachHelpers = require('../static/visual_dev_attach_helpers.js');

function createButton() {
  return {
    disabled: false,
    listeners: new Map(),
    addEventListener(type, handler) {
      this.listeners.set(type, handler);
    },
    click() {
      this.listeners.get('click')?.({ preventDefault() {} });
    },
  };
}

function createDialog() {
  return {
    open: false,
    returnValue: '',
    showModal() { this.open = true; },
    close(value = '') { this.open = false; this.returnValue = value; },
  };
}

test('attach controller opens modal with active session state and submits attach requests through visualDevController', async () => {
  const settingsOpenButton = createButton();
  const attachButton = createButton();
  const refreshButton = createButton();
  const inspectButton = createButton();
  const screenshotButton = createButton();
  const openExternalButton = createButton();
  const logsButton = createButton();
  const detachButton = createButton();
  const cancelButton = createButton();
  const dialog = createDialog();
  const formListeners = new Map();
  const form = {
    addEventListener(type, handler) { formListeners.set(type, handler); },
  };
  const previewUrlInput = { value: '', focus() {}, select() {} };
  const previewTitleInput = { value: '' };
  const currentChatLabel = { textContent: '' };
  const currentSessionLabel = { textContent: '' };
  const openedUrls = [];
  const attachCalls = [];
  const detachCalls = [];
  const inspectCalls = [];
  const screenshotCalls = [];
  const regionScreenshotCalls = [];
  const logDrawerCalls = [];
  const visualDevController = {
    getState() {
      return {
        sessions: [{ session_id: 'session-11', chat_id: 11, preview_url: 'https://preview.example.com/app', preview_title: 'Live preview' }],
      };
    },
    async attachSession(payload) {
      attachCalls.push(payload);
      return { ok: true };
    },
    async detachSession(sessionId) {
      detachCalls.push(sessionId);
      return { ok: true };
    },
    requestInspectMode() {
      inspectCalls.push('inspect');
    },
    requestScreenshot() {
      screenshotCalls.push('screenshot');
    },
    requestRegionScreenshot() {
      regionScreenshotCalls.push('region');
    },
    toggleConsoleDrawer(forceOpen) {
      logDrawerCalls.push(forceOpen);
    },
    syncActiveChatSession() {},
  };

  const controller = visualDevAttachHelpers.createController({
    enabled: true,
    getActiveChatId: () => 11,
    getActiveChatLabel: () => 'Chat 11',
    visualDevController,
    dialog,
    form,
    previewUrlInput,
    previewTitleInput,
    currentChatLabel,
    currentSessionLabel,
    settingsOpenButton,
    attachButton,
    refreshButton,
    inspectButton,
    screenshotButton,
    openExternalButton,
    logsButton,
    detachButton,
    cancelButton,
    openExternalUrl: (url) => openedUrls.push(url),
    reloadPreview: () => openedUrls.push('reload'),
  });

  controller.bind();
  settingsOpenButton.click();
  assert.equal(dialog.open, true);
  assert.equal(currentChatLabel.textContent, 'Chat 11');
  assert.match(currentSessionLabel.textContent, /Live preview/);

  previewUrlInput.value = 'https://preview.example.com/dev';
  previewTitleInput.value = 'Dev preview';
  await formListeners.get('submit')({ preventDefault() {} });

  assert.deepEqual(attachCalls, [{ previewUrl: 'https://preview.example.com/dev', previewTitle: 'Dev preview' }]);
  assert.equal(dialog.open, false);

  inspectButton.click();
  screenshotButton.listeners.get('click')?.({ preventDefault() {}, shiftKey: false });
  screenshotButton.listeners.get('click')?.({ preventDefault() {}, shiftKey: true });
  logsButton.click();
  assert.deepEqual(inspectCalls, ['inspect']);
  assert.deepEqual(screenshotCalls, ['screenshot']);
  assert.deepEqual(regionScreenshotCalls, ['region']);
  assert.deepEqual(logDrawerCalls, [null]);

  openExternalButton.click();
  assert.deepEqual(openedUrls, ['https://preview.example.com/app']);

  detachButton.click();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(detachCalls, ['session-11']);
});
