import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const shellHelpers = require('../static/visual_dev_shell_helpers.js');

function createStyle() {
  const values = new Map();
  return {
    setProperty(name, value) {
      values.set(String(name), String(value));
    },
    getPropertyValue(name) {
      return values.get(String(name)) || '';
    },
    removeProperty(name) {
      values.delete(String(name));
    },
    values,
  };
}

function createEventTarget() {
  return {
    listeners: new Map(),
    addEventListener(type, handler) {
      const entries = this.listeners.get(type) || [];
      entries.push(handler);
      this.listeners.set(type, entries);
    },
    removeEventListener(type, handler) {
      const entries = this.listeners.get(type) || [];
      this.listeners.set(type, entries.filter((entry) => entry !== handler));
    },
    dispatch(type, event = {}) {
      const entries = this.listeners.get(type) || [];
      entries.forEach((handler) => handler(event));
    },
  };
}

function createElement(tagName = 'div') {
  return {
    ...createEventTarget(),
    tagName: String(tagName || 'div').toUpperCase(),
    attributes: new Map(),
    style: createStyle(),
    textContent: '',
    hidden: false,
    className: '',
    title: '',
    loading: '',
    referrerPolicy: '',
    parentNode: null,
    children: [],
    capturedPointers: new Set(),
    setAttribute(name, value) {
      this.attributes.set(name, String(value));
    },
    getAttribute(name) {
      return this.attributes.get(name);
    },
    removeAttribute(name) {
      this.attributes.delete(name);
    },
    setPointerCapture(pointerId) {
      this.capturedPointers.add(Number(pointerId));
    },
    releasePointerCapture(pointerId) {
      this.capturedPointers.delete(Number(pointerId));
    },
    hasPointerCapture(pointerId) {
      return this.capturedPointers.has(Number(pointerId));
    },
    appendChild(child) {
      if (!child) return child;
      child.parentNode = this;
      this.children.push(child);
      return child;
    },
    insertBefore(child, referenceNode) {
      if (!child) return child;
      child.parentNode = this;
      if (!referenceNode) {
        this.children.push(child);
        return child;
      }
      const index = this.children.indexOf(referenceNode);
      if (index < 0) {
        this.children.push(child);
      } else {
        this.children.splice(index, 0, child);
      }
      return child;
    },
    removeChild(child) {
      this.children = this.children.filter((entry) => entry !== child);
      if (child) {
        child.parentNode = null;
      }
      return child;
    },
    remove() {
      this.parentNode?.removeChild?.(this);
    },
    getBoundingClientRect() {
      return { left: 120, top: 180, width: 640, height: 560, right: 760, bottom: 740 };
    },
  };
}

function createStorage(initialEntries = {}) {
  const values = new Map(Object.entries(initialEntries));
  return {
    values,
    getItem(key) {
      return values.has(key) ? values.get(key) : null;
    },
    setItem(key, value) {
      values.set(key, String(value));
    },
    removeItem(key) {
      values.delete(key);
    },
  };
}

function buildHarness(overrides = {}) {
  const appShell = createElement();
  const workspaceRoot = createElement();
  const shellRoot = createElement();
  shellRoot.hidden = true;
  const toggleButton = createElement();
  const sidebarResizeHandle = createElement('button');
  const previewFrame = createElement('iframe');
  previewFrame.src = '';
  previewFrame.className = 'visual-dev-workspace__preview';
  previewFrame.title = 'Visual dev preview';
  previewFrame.loading = 'lazy';
  previewFrame.referrerPolicy = 'strict-origin-when-cross-origin';
  const previewWrap = createElement();
  const previewResizeHandle = createElement('button');
  previewWrap.appendChild(previewFrame);
  previewWrap.appendChild(previewResizeHandle);
  const ownershipLabel = createElement();
  const statusLabel = createElement();
  const selectionChip = createElement();
  const screenshotChip = createElement();
  const composerSelectionChip = createElement();
  composerSelectionChip.hidden = true;
  const composerScreenshotChip = createElement();
  composerScreenshotChip.hidden = true;
  const composerPreviewChip = createElement();
  composerPreviewChip.hidden = true;
  const composerConsoleChip = createElement();
  composerConsoleChip.hidden = true;
  const consoleDrawer = createElement();
  consoleDrawer.hidden = true;
  const runtimeSummary = createElement();
  const consoleList = createElement();
  const documentObject = {
    ...createEventTarget(),
    createElement(tagName) {
      return createElement(tagName);
    },
  };
  const rafCallbacks = new Map();
  let nextRafId = 1;
  const requestAnimationFrame = overrides.requestAnimationFrame || ((callback) => {
    const id = nextRafId;
    nextRafId += 1;
    rafCallbacks.set(id, callback);
    return id;
  });
  const cancelAnimationFrame = overrides.cancelAnimationFrame || ((id) => {
    rafCallbacks.delete(id);
  });
  const windowObject = {
    ...createEventTarget(),
    innerWidth: overrides.innerWidth ?? 1440,
    innerHeight: overrides.innerHeight ?? 1100,
    requestAnimationFrame,
    cancelAnimationFrame,
    matchMedia(query) {
      if (query === '(min-width: 861px)') {
        return { matches: (overrides.innerWidth ?? 1440) >= 861 };
      }
      return { matches: false };
    },
  };
  const localStorageRef = createStorage(overrides.storage || {});

  workspaceRoot.getBoundingClientRect = overrides.workspaceRootRect || (() => ({
    left: 120,
    top: 180,
    width: 1200,
    height: 720,
    right: 1320,
    bottom: 900,
  }));

  if (typeof overrides.previewWrapRect === 'function') {
    previewWrap.getBoundingClientRect = overrides.previewWrapRect;
  }

  const controller = shellHelpers.createController({
    appShell,
    workspaceRoot,
    shellRoot,
    toggleButton,
    sidebarResizeHandle,
    previewFrame,
    previewWrap,
    previewResizeHandle,
    ownershipLabel,
    statusLabel,
    selectionChip,
    screenshotChip,
    composerSelectionChip,
    composerScreenshotChip,
    composerPreviewChip,
    composerConsoleChip,
    consoleDrawer,
    runtimeSummary,
    consoleList,
    documentObject,
    windowObject,
    localStorageRef,
    initialEnabled: Boolean(overrides.initialEnabled),
  });

  return {
    controller,
    appShell,
    workspaceRoot,
    shellRoot,
    toggleButton,
    sidebarResizeHandle,
    previewFrame,
    previewWrap,
    previewResizeHandle,
    ownershipLabel,
    statusLabel,
    selectionChip,
    screenshotChip,
    composerSelectionChip,
    composerScreenshotChip,
    composerPreviewChip,
    composerConsoleChip,
    consoleDrawer,
    runtimeSummary,
    consoleList,
    documentObject,
    windowObject,
    localStorageRef,
    flushAnimationFrame() {
      const pending = Array.from(rafCallbacks.entries());
      rafCallbacks.clear();
      pending.forEach(([, callback]) => callback());
    },
  };
}

test('setEnabled toggles shell dataset visibility state', () => {
  const harness = buildHarness();

  harness.controller.setEnabled(true);
  assert.equal(harness.shellRoot.attributes.get('data-visual-dev-enabled'), 'true');
  assert.equal(harness.shellRoot.hidden, true);

  harness.controller.setEnabled(false);
  assert.equal(harness.shellRoot.attributes.get('data-visual-dev-enabled'), 'false');
  assert.equal(harness.shellRoot.hidden, true);
});

test('feature-enabled shell starts closed with a visible Workspace toggle and opens on demand', () => {
  const harness = buildHarness({ initialEnabled: true });

  assert.equal(harness.toggleButton.hidden, false);
  assert.equal(harness.toggleButton.textContent, 'Workspace');
  assert.equal(harness.shellRoot.hidden, true);
  assert.equal(harness.workspaceRoot.attributes.get('data-workspace-open'), 'false');
  assert.equal(harness.shellRoot.attributes.get('data-visual-dev-enabled'), 'true');

  harness.controller.toggleWorkspace(true);

  assert.equal(harness.shellRoot.hidden, false);
  assert.equal(harness.workspaceRoot.attributes.get('data-workspace-open'), 'true');
  assert.equal(harness.toggleButton.attributes.get('aria-pressed'), 'true');

  harness.controller.toggleWorkspace(false);

  assert.equal(harness.shellRoot.hidden, true);
  assert.equal(harness.workspaceRoot.attributes.get('data-workspace-open'), 'false');
  assert.equal(harness.toggleButton.attributes.get('aria-pressed'), 'false');
});

test('feature-enabled shell stays open after clearing unattached session state when Workspace is already open', () => {
  const harness = buildHarness({ initialEnabled: true });
  harness.controller.toggleWorkspace(true);

  harness.controller.clearSessionState({ enabled: true });

  assert.equal(harness.shellRoot.hidden, false);
  assert.equal(harness.workspaceRoot.attributes.get('data-workspace-open'), 'true');
  assert.equal(harness.shellRoot.attributes.get('data-visual-dev-enabled'), 'true');
});

test('applySessionState syncs preview src ownership and status text', () => {
  const harness = buildHarness();

  harness.controller.applySessionState({
    enabled: true,
    chatId: 73,
    chatLabel: '[feat]Super app',
    sessionId: 'session-1',
    previewUrl: 'https://preview.example.com/app',
    runtime: { state: 'live' },
  });

  const activeFrame = harness.controller.getActivePreviewFrame();
  assert.equal(harness.shellRoot.attributes.get('data-visual-dev-enabled'), 'true');
  assert.equal(activeFrame.src, 'https://preview.example.com/app');
  assert.equal(harness.ownershipLabel.textContent, '[feat]Super app');
  assert.equal(harness.ownershipLabel.attributes.get('data-chat-id'), '73');
  assert.equal(harness.statusLabel.textContent, 'live');
});

test('getActivePreviewRegion returns the visible bounds of the active preview frame', () => {
  const harness = buildHarness();

  harness.controller.applySessionState({
    enabled: true,
    chatId: 73,
    chatLabel: '[feat]Super app',
    sessionId: 'session-1',
    previewUrl: 'https://preview.example.com/app',
    runtime: { state: 'live' },
  });

  assert.deepEqual(harness.controller.getActivePreviewRegion(), {
    left: 120,
    top: 180,
    width: 640,
    height: 560,
  });
});

test('applySessionState prefers preview_frame_url so same-app previews can load in embedded-preview mode without changing the stored label url', () => {
  const harness = buildHarness();

  harness.controller.applySessionState({
    enabled: true,
    chatId: 73,
    chatLabel: '[feat]Super app',
    sessionId: 'session-1',
    previewUrl: 'https://miniapp.example.com/app',
    previewFrameUrl: 'https://miniapp.example.com/app?__hermes_visual_dev_preview=1',
    runtime: { state: 'live' },
  });

  const activeFrame = harness.controller.getActivePreviewFrame();
  assert.equal(activeFrame.src, 'https://miniapp.example.com/app?__hermes_visual_dev_preview=1');
  assert.equal(harness.ownershipLabel.textContent, '[feat]Super app');
});

test('applySessionState does not reload the active cached iframe when runtime updates keep the same preview url', () => {
  const harness = buildHarness();

  harness.controller.applySessionState({
    enabled: true,
    chatId: 73,
    chatLabel: '[feat]Super app',
    sessionId: 'session-1',
    previewFrameUrl: 'https://miniapp.example.com/app?__hermes_visual_dev_preview=1',
    runtime: { state: 'connecting' },
  });

  const activeFrame = harness.controller.getActivePreviewFrame();
  let assignedSrcCount = 0;
  let assignedSrc = String(activeFrame.src || '');
  Object.defineProperty(activeFrame, 'src', {
    configurable: true,
    enumerable: true,
    get() {
      return assignedSrc;
    },
    set(value) {
      assignedSrcCount += 1;
      assignedSrc = String(value || '');
    },
  });

  harness.controller.applySessionState({
    enabled: true,
    chatId: 73,
    chatLabel: '[feat]Super app',
    sessionId: 'session-1',
    previewFrameUrl: 'https://miniapp.example.com/app?__hermes_visual_dev_preview=1',
    runtime: { state: 'live' },
  });

  assert.equal(assignedSrc, 'https://miniapp.example.com/app?__hermes_visual_dev_preview=1');
  assert.equal(assignedSrcCount, 0);
  assert.equal(harness.statusLabel.textContent, 'live');
});

test('applySelectionSummary and applyScreenshotSummary populate workspace and composer-adjacent context chips', () => {
  const harness = buildHarness({ initialEnabled: true });

  harness.controller.applySelectionSummary({
    selectionType: 'dom',
    label: 'Play button',
  });
  harness.controller.applyScreenshotSummary({
    label: 'viewport capture',
    storage_path: '/tmp/screenshot-1776958241575-66c1c292.png',
  });

  assert.equal(harness.selectionChip.textContent, 'Selected: Play button');
  assert.equal(harness.screenshotChip.textContent, 'Screenshot: viewport capture • screenshot 66c1c292');
  assert.equal(harness.composerSelectionChip.textContent, 'UI context: Play button');
  assert.equal(harness.composerScreenshotChip.textContent, 'Screenshot context: viewport capture • screenshot 66c1c292');
  assert.equal(harness.composerSelectionChip.hidden, false);
  assert.equal(harness.composerScreenshotChip.hidden, false);
});

test('applySessionState keeps recent workspace previews mounted so switching back is instant', () => {
  const harness = buildHarness({ initialEnabled: true });

  harness.controller.applySessionState({
    enabled: true,
    chatId: 11,
    chatLabel: 'Chat 11',
    sessionId: 'session-11',
    previewFrameUrl: 'https://preview.example.com/app-11',
    runtime: { state: 'live' },
  });
  const frame11 = harness.controller.getActivePreviewFrame();

  harness.controller.applySessionState({
    enabled: true,
    chatId: 22,
    chatLabel: 'Chat 22',
    sessionId: 'session-22',
    previewFrameUrl: 'https://preview.example.com/app-22',
    runtime: { state: 'connecting' },
  });
  const frame22 = harness.controller.getActivePreviewFrame();

  harness.controller.applySessionState({
    enabled: true,
    chatId: 11,
    chatLabel: 'Chat 11',
    sessionId: 'session-11',
    previewFrameUrl: 'https://preview.example.com/app-11',
    runtime: { state: 'live' },
  });

  const visibleFrames = harness.previewWrap.children.filter((child) => child.tagName === 'IFRAME' && child.hidden === false);

  assert.notEqual(frame11, frame22);
  assert.equal(frame11.hidden, false);
  assert.equal(frame22.hidden, true);
  assert.equal(visibleFrames.length, 1);
  assert.equal(visibleFrames[0], frame11);
  assert.equal(harness.controller.getActivePreviewFrame(), frame11);
  assert.deepEqual(harness.controller.getCachedPreviewSessionIds(), ['session-22', 'session-11']);
});

test('desktop resize handle restores persisted size and drags the preview from the bottom-right corner', () => {
  const harness = buildHarness({
    initialEnabled: true,
    storage: {
      'hermes.visualDev.previewSize.v1': JSON.stringify({ width: 760, height: 680 }),
    },
    previewWrapRect: () => ({ left: 120, top: 180, width: 640, height: 560, right: 760, bottom: 740 }),
  });

  assert.equal(harness.previewResizeHandle.hidden, false);
  assert.equal(harness.previewWrap.style.width, '760px');
  assert.equal(harness.previewFrame.style.height, '680px');
  assert.deepEqual(harness.controller.getPreviewSize(), { width: 760, height: 680 });

  harness.previewResizeHandle.dispatch('pointerdown', {
    pointerId: 9,
    clientX: 760,
    clientY: 740,
    preventDefault() {},
  });
  harness.documentObject.dispatch('pointermove', {
    pointerId: 9,
    clientX: 980,
    clientY: 860,
    preventDefault() {},
  });
  harness.documentObject.dispatch('pointerup', { pointerId: 9 });

  assert.equal(harness.previewWrap.style.width, '860px');
  assert.equal(harness.previewFrame.style.height, '680px');
  assert.deepEqual(harness.controller.getPreviewSize(), { width: 860, height: 680 });
  assert.equal(
    harness.localStorageRef.getItem('hermes.visualDev.previewSize.v1'),
    JSON.stringify({ width: 860, height: 680 }),
  );
});

test('mobile shells keep the resize handle hidden and ignore persisted desktop preview sizing', () => {
  const harness = buildHarness({
    initialEnabled: true,
    innerWidth: 640,
    storage: {
      'hermes.visualDev.previewSize.v1': JSON.stringify({ width: 760, height: 680 }),
    },
  });

  assert.equal(harness.previewResizeHandle.hidden, true);
  assert.equal(harness.previewWrap.style.width || '', '');
  assert.equal(harness.previewFrame.style.height || '', '');
  assert.deepEqual(harness.controller.getPreviewSize(), { width: null, height: null });
});

test('desktop sidebar resize handle restores persisted width and widens the left rail when dragged', () => {
  const harness = buildHarness({
    initialEnabled: true,
    storage: {
      'hermes.visualDev.sidebarWidth.v1': JSON.stringify({ width: 430 }),
    },
  });

  harness.controller.toggleWorkspace(true);

  assert.equal(harness.sidebarResizeHandle.hidden, false);
  assert.equal(harness.workspaceRoot.style.getPropertyValue('--workspace-sidebar-width'), '430px');

  harness.sidebarResizeHandle.dispatch('pointerdown', {
    pointerId: 12,
    clientX: 550,
    preventDefault() {},
  });
  harness.documentObject.dispatch('pointermove', {
    pointerId: 12,
    clientX: 640,
    preventDefault() {},
  });
  harness.documentObject.dispatch('pointerup', { pointerId: 12 });

  assert.equal(harness.workspaceRoot.style.getPropertyValue('--workspace-sidebar-width'), '520px');
  assert.deepEqual(harness.controller.getSidebarSize(), { width: 520 });
  assert.equal(
    harness.localStorageRef.getItem('hermes.visualDev.sidebarWidth.v1'),
    JSON.stringify({ width: 520 }),
  );
});

test('desktop sidebar resize batches drag updates to animation frames and persists only the final width on release', () => {
  const harness = buildHarness({ initialEnabled: true });

  harness.controller.toggleWorkspace(true);

  harness.sidebarResizeHandle.dispatch('pointerdown', {
    pointerId: 31,
    clientX: 500,
    preventDefault() {},
  });
  harness.documentObject.dispatch('pointermove', {
    pointerId: 31,
    clientX: 600,
    preventDefault() {},
  });
  harness.documentObject.dispatch('pointermove', {
    pointerId: 31,
    clientX: 660,
    preventDefault() {},
  });

  assert.equal(harness.workspaceRoot.style.getPropertyValue('--workspace-sidebar-width'), '');
  assert.equal(harness.localStorageRef.getItem('hermes.visualDev.sidebarWidth.v1'), null);

  harness.flushAnimationFrame();

  assert.equal(harness.workspaceRoot.style.getPropertyValue('--workspace-sidebar-width'), '540px');
  assert.equal(harness.localStorageRef.getItem('hermes.visualDev.sidebarWidth.v1'), null);

  harness.documentObject.dispatch('pointermove', {
    pointerId: 31,
    clientX: 620,
    preventDefault() {},
  });
  harness.documentObject.dispatch('pointerup', { pointerId: 31 });

  assert.equal(harness.workspaceRoot.style.getPropertyValue('--workspace-sidebar-width'), '500px');
  assert.equal(
    harness.localStorageRef.getItem('hermes.visualDev.sidebarWidth.v1'),
    JSON.stringify({ width: 500 }),
  );
});

test('desktop sidebar resize preserves the current preview right edge instead of capping preview width to the visual column', () => {
  let currentPreviewLeft = 560;
  const harness = buildHarness({
    initialEnabled: true,
    innerWidth: 1440,
    workspaceRootRect: () => ({ left: 120, top: 180, width: 1000, height: 720, right: 1120, bottom: 900 }),
    previewWrapRect: () => ({
      left: currentPreviewLeft,
      top: 200,
      width: 700,
      height: 680,
      right: currentPreviewLeft + 700,
      bottom: 880,
    }),
  });

  harness.controller.toggleWorkspace(true);
  harness.previewResizeHandle.dispatch('pointerdown', {
    pointerId: 33,
    clientX: 1260,
    clientY: 880,
    preventDefault() {},
  });
  harness.documentObject.dispatch('pointermove', {
    pointerId: 33,
    clientX: 1260,
    clientY: 880,
    preventDefault() {},
  });
  harness.documentObject.dispatch('pointerup', { pointerId: 33 });

  assert.equal(harness.previewWrap.style.width, '700px');

  harness.sidebarResizeHandle.dispatch('pointerdown', {
    pointerId: 44,
    clientX: 500,
    preventDefault() {},
  });
  currentPreviewLeft = 680;
  harness.documentObject.dispatch('pointermove', {
    pointerId: 44,
    clientX: 680,
    preventDefault() {},
  });
  harness.flushAnimationFrame();

  assert.equal(harness.workspaceRoot.style.getPropertyValue('--workspace-sidebar-width'), '560px');
  assert.deepEqual(harness.controller.getSidebarSize(), { width: 560 });
  assert.equal(harness.previewWrap.style.width, '580px');
  assert.deepEqual(harness.controller.getPreviewSize(), { width: 580, height: 680 });

  harness.documentObject.dispatch('pointerup', { pointerId: 44 });
  assert.equal(
    harness.localStorageRef.getItem('hermes.visualDev.sidebarWidth.v1'),
    JSON.stringify({ width: 560 }),
  );
  assert.equal(
    harness.localStorageRef.getItem('hermes.visualDev.previewSize.v1'),
    JSON.stringify({ width: 580, height: 680 }),
  );
});

test('desktop sidebar resize can grow well beyond the default cap while the workspace preview shrinks in place', () => {
  let currentPreviewLeft = 560;
  const harness = buildHarness({
    initialEnabled: true,
    innerWidth: 1440,
    workspaceRootRect: () => ({ left: 120, top: 180, width: 1000, height: 720, right: 1120, bottom: 900 }),
    previewWrapRect: () => ({
      left: currentPreviewLeft,
      top: 200,
      width: 700,
      height: 680,
      right: currentPreviewLeft + 700,
      bottom: 880,
    }),
  });

  harness.controller.toggleWorkspace(true);
  harness.previewResizeHandle.dispatch('pointerdown', {
    pointerId: 63,
    clientX: 1260,
    clientY: 880,
    preventDefault() {},
  });
  harness.documentObject.dispatch('pointermove', {
    pointerId: 63,
    clientX: 1260,
    clientY: 880,
    preventDefault() {},
  });
  harness.documentObject.dispatch('pointerup', { pointerId: 63 });

  assert.equal(harness.previewWrap.style.width, '700px');

  harness.sidebarResizeHandle.dispatch('pointerdown', {
    pointerId: 64,
    clientX: 500,
    preventDefault() {},
  });
  currentPreviewLeft = 980;
  harness.documentObject.dispatch('pointermove', {
    pointerId: 64,
    clientX: 980,
    preventDefault() {},
  });
  harness.flushAnimationFrame();

  assert.equal(harness.workspaceRoot.style.getPropertyValue('--workspace-sidebar-width'), '860px');
  assert.deepEqual(harness.controller.getSidebarSize(), { width: 860 });
  assert.equal(harness.previewWrap.style.width, '280px');
  assert.deepEqual(harness.controller.getPreviewSize(), { width: 280, height: 680 });

  harness.documentObject.dispatch('pointerup', { pointerId: 64 });
  assert.equal(
    harness.localStorageRef.getItem('hermes.visualDev.sidebarWidth.v1'),
    JSON.stringify({ width: 860 }),
  );
  assert.equal(
    harness.localStorageRef.getItem('hermes.visualDev.previewSize.v1'),
    JSON.stringify({ width: 280, height: 680 }),
  );
});

test('desktop sidebar resize handle captures the pointer, marks drag state active, and releases it when the drag ends or capture is lost', () => {
  const harness = buildHarness({ initialEnabled: true });

  harness.controller.toggleWorkspace(true);

  harness.sidebarResizeHandle.dispatch('pointerdown', {
    pointerId: 21,
    clientX: 500,
    preventDefault() {},
  });
  assert.equal(harness.sidebarResizeHandle.hasPointerCapture(21), true);
  assert.equal(harness.appShell.attributes.get('data-sidebar-resizing'), 'true');
  assert.equal(harness.workspaceRoot.attributes.get('data-sidebar-resizing'), 'true');
  assert.equal(harness.shellRoot.attributes.get('data-sidebar-resizing'), 'true');
  assert.equal(harness.sidebarResizeHandle.attributes.get('data-dragging'), 'true');

  harness.sidebarResizeHandle.dispatch('lostpointercapture', { pointerId: 21 });
  assert.equal(harness.sidebarResizeHandle.hasPointerCapture(21), false);
  assert.equal(harness.appShell.attributes.get('data-sidebar-resizing'), 'false');
  assert.equal(harness.workspaceRoot.attributes.get('data-sidebar-resizing'), 'false');
  assert.equal(harness.shellRoot.attributes.get('data-sidebar-resizing'), 'false');
  assert.equal(harness.sidebarResizeHandle.attributes.get('data-dragging'), 'false');

  const widthAfterLostCapture = harness.workspaceRoot.style.getPropertyValue('--workspace-sidebar-width') || '380px';
  harness.documentObject.dispatch('pointermove', {
    pointerId: 21,
    clientX: 700,
    preventDefault() {},
  });
  assert.equal(harness.workspaceRoot.style.getPropertyValue('--workspace-sidebar-width') || '380px', widthAfterLostCapture);

  harness.sidebarResizeHandle.dispatch('pointerdown', {
    pointerId: 22,
    clientX: 500,
    preventDefault() {},
  });
  assert.equal(harness.sidebarResizeHandle.hasPointerCapture(22), true);
  harness.documentObject.dispatch('pointerup', { pointerId: 22 });
  assert.equal(harness.sidebarResizeHandle.hasPointerCapture(22), false);
  assert.equal(harness.appShell.attributes.get('data-sidebar-resizing'), 'false');
  assert.equal(harness.workspaceRoot.attributes.get('data-sidebar-resizing'), 'false');
  assert.equal(harness.shellRoot.attributes.get('data-sidebar-resizing'), 'false');
  assert.equal(harness.sidebarResizeHandle.attributes.get('data-dragging'), 'false');
});

test('desktop sidebar resize handle stays hidden until workspace is open and mobile ignores persisted sidebar sizing', () => {
  const desktopHarness = buildHarness({ initialEnabled: true });

  assert.equal(desktopHarness.sidebarResizeHandle.hidden, true);
  desktopHarness.controller.toggleWorkspace(true);
  assert.equal(desktopHarness.sidebarResizeHandle.hidden, false);
  desktopHarness.controller.toggleWorkspace(false);
  assert.equal(desktopHarness.sidebarResizeHandle.hidden, true);

  const mobileHarness = buildHarness({
    initialEnabled: true,
    innerWidth: 640,
    storage: {
      'hermes.visualDev.sidebarWidth.v1': JSON.stringify({ width: 430 }),
    },
  });

  mobileHarness.controller.toggleWorkspace(true);
  assert.equal(mobileHarness.sidebarResizeHandle.hidden, true);
  assert.equal(mobileHarness.workspaceRoot.style.getPropertyValue('--workspace-sidebar-width'), '');
  assert.deepEqual(mobileHarness.controller.getSidebarSize(), { width: null });
});

test('applySessionDetails renders runtime summary and recent console events into the drawer', () => {
  const harness = buildHarness({ initialEnabled: true });

  harness.controller.applySessionDetails({
    session: {
      runtime: { state: 'build_failed', message: 'Vite compile failed' },
    },
    console_events: [
      { level: 'error', message: 'Build exploded', event_type: 'console' },
      { level: 'info', message: 'Rebuilding…', event_type: 'console' },
    ],
  });

  assert.equal(harness.runtimeSummary.textContent, 'Runtime: build_failed — Vite compile failed');
  assert.equal(harness.consoleDrawer.hidden, false);
  assert.equal(harness.consoleDrawer.attributes.get('data-open'), 'true');
  assert.equal(harness.consoleDrawer.attributes.get('data-severity'), 'error');
  assert.match(harness.consoleList.textContent, /ERROR: Build exploded/);
  assert.match(harness.consoleList.textContent, /INFO: Rebuilding/);
});

test('appendConsoleEvent auto-opens the drawer on error severity and tracks drawer severity state', () => {
  const harness = buildHarness({ initialEnabled: true });

  harness.controller.appendConsoleEvent({ level: 'warn', message: 'Retrying websocket', event_type: 'console' });
  assert.equal(harness.consoleDrawer.hidden, true);
  assert.equal(harness.consoleDrawer.attributes.get('data-severity'), 'warn');

  harness.controller.appendConsoleEvent({ level: 'error', message: 'Build exploded', event_type: 'console' });

  assert.equal(harness.consoleDrawer.hidden, false);
  assert.equal(harness.consoleDrawer.attributes.get('data-open'), 'true');
  assert.equal(harness.consoleDrawer.attributes.get('data-severity'), 'error');
  assert.match(harness.consoleList.textContent, /ERROR: Build exploded/);

  harness.controller.toggleConsoleDrawer(false);
  assert.equal(harness.consoleDrawer.hidden, true);
  assert.equal(harness.consoleDrawer.attributes.get('data-open'), 'false');
});

test('clearSessionState resets preview frame, summaries, and drawer state', () => {
  const harness = buildHarness({ initialEnabled: true });
  harness.controller.applySessionState({
    enabled: true,
    chatId: 73,
    chatLabel: '[feat]Super app',
    sessionId: 'session-1',
    previewUrl: 'https://preview.example.com/app',
    runtime: { state: 'live' },
  });
  harness.controller.applySelectionSummary({ selectionType: 'dom', label: 'Play button' });
  harness.controller.applyScreenshotSummary({ label: 'viewport capture' });
  harness.controller.applySessionDetails({
    session: { runtime: { state: 'live', message: 'Ready' } },
    console_events: [{ level: 'info', message: 'Preview live' }],
  });
  harness.controller.toggleConsoleDrawer(true);

  harness.controller.clearSessionState();

  assert.equal(harness.previewFrame.src, 'about:blank');
  assert.equal(harness.statusLabel.textContent, 'idle');
  assert.equal(harness.selectionChip.textContent, 'Selected: none');
  assert.equal(harness.screenshotChip.textContent, 'Screenshot: none');
  assert.equal(harness.composerSelectionChip.textContent, 'UI context: none');
  assert.equal(harness.composerScreenshotChip.textContent, 'Screenshot context: none');
  assert.equal(harness.composerSelectionChip.hidden, true);
  assert.equal(harness.composerScreenshotChip.hidden, true);
  assert.equal(harness.composerPreviewChip.textContent, 'Preview URL: none');
  assert.equal(harness.composerConsoleChip.textContent, 'Console: none');
  assert.equal(harness.composerPreviewChip.hidden, true);
  assert.equal(harness.composerConsoleChip.hidden, true);
  assert.equal(harness.runtimeSummary.textContent, 'Runtime: idle');
  assert.equal(harness.consoleList.textContent, 'No console events yet.');
  assert.equal(harness.consoleDrawer.hidden, true);
  assert.equal(harness.consoleDrawer.attributes.get('data-severity'), 'info');
  assert.equal(harness.shellRoot.attributes.get('data-visual-dev-enabled'), 'false');
});
