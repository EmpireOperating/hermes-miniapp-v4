import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const filePreviewHelpers = require('../static/file_preview_helpers.js');

class FakeClassList {
  constructor(owner) {
    this.owner = owner;
    this.values = new Set();
  }

  add(...tokens) {
    tokens.forEach((token) => this.values.add(String(token)));
    this.owner.className = Array.from(this.values).join(' ');
  }

  contains(token) {
    return this.values.has(String(token));
  }
}

class FakeElement {
  constructor(tagName = 'div') {
    this.tagName = String(tagName).toUpperCase();
    this.children = [];
    this.parentNode = null;
    this.dataset = {};
    this.className = '';
    this.classList = new FakeClassList(this);
    this.textContent = '';
    this.disabled = false;
    this.hidden = false;
    this.scrollTop = 0;
    this.clientHeight = 120;
    this.offsetHeight = 20;
    this.open = false;
    this._listeners = new Map();
  }

  appendChild(child) {
    if (child?.isFragment) {
      child.children.slice().forEach((node) => this.appendChild(node));
      child.children = [];
      return child;
    }
    child.parentNode = this;
    this.children.push(child);
    return child;
  }

  insertBefore(child, referenceNode) {
    if (child?.isFragment) {
      child.children.slice().forEach((node) => this.insertBefore(node, referenceNode));
      child.children = [];
      return child;
    }
    const index = this.children.indexOf(referenceNode);
    child.parentNode = this;
    if (index < 0) {
      this.children.push(child);
    } else {
      this.children.splice(index, 0, child);
    }
    return child;
  }

  get firstChild() {
    return this.children[0] || null;
  }

  get offsetTop() {
    if (!this.parentNode) return 0;
    return this.parentNode.children.indexOf(this) * this.offsetHeight;
  }

  get scrollHeight() {
    return this.children.length * 20;
  }

  set innerHTML(value) {
    this._innerHTML = String(value);
    this.children = [];
  }

  get innerHTML() {
    return this._innerHTML || '';
  }

  querySelectorAll(selector) {
    if (selector === '.file-preview-line[data-line-number]') {
      return this.children.filter((child) => child.classList.contains('file-preview-line') && child.dataset.lineNumber);
    }
    return [];
  }

  querySelector(selector) {
    const lineMatch = selector.match(/^\.file-preview-line\[data-line-number="(\d+)"\]$/);
    if (lineMatch) {
      const wanted = lineMatch[1];
      return this.children.find((child) => child.dataset.lineNumber === wanted) || null;
    }
    if (selector === '.file-preview-line.is-focus') {
      return this.children.find((child) => child.classList.contains('file-preview-line') && child.classList.contains('is-focus')) || null;
    }
    return null;
  }

  addEventListener(eventName, handler, options = undefined) {
    const key = String(eventName);
    if (!this._listeners.has(key)) {
      this._listeners.set(key, []);
    }
    this._listeners.get(key).push({ handler, options });
  }

  removeEventListener(eventName, handler) {
    const key = String(eventName);
    const current = this._listeners.get(key) || [];
    this._listeners.set(key, current.filter((entry) => entry.handler !== handler));
  }

  listeners(eventName) {
    return (this._listeners.get(String(eventName)) || []).slice();
  }

  dispatch(eventName, event = {}) {
    this.listeners(eventName).forEach(({ handler }) => handler(event));
  }

  showModal() {
    this.open = true;
  }

  close() {
    this.open = false;
  }
}

class FakeFragment {
  constructor() {
    this.children = [];
    this.isFragment = true;
  }

  appendChild(child) {
    this.children.push(child);
    return child;
  }

  insertBefore(child, referenceNode) {
    const index = this.children.indexOf(referenceNode);
    if (index < 0) {
      this.children.push(child);
    } else {
      this.children.splice(index, 0, child);
    }
    return child;
  }

  get firstChild() {
    return this.children[0] || null;
  }
}

function createDocumentObject() {
  return {
    createElement(tagName) {
      return new FakeElement(tagName);
    },
    createDocumentFragment() {
      return new FakeFragment();
    },
  };
}

function createDeferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function buildHarness(overrides = {}) {
  const documentObject = createDocumentObject();
  const filePreviewModal = new FakeElement('dialog');
  const filePreviewPath = new FakeElement('div');
  const filePreviewStatus = new FakeElement('div');
  const filePreviewLines = new FakeElement('div');
  const filePreviewExpandUp = new FakeElement('button');
  const filePreviewLoadFull = new FakeElement('button');
  const filePreviewExpandDown = new FakeElement('button');
  const filePreviewClose = new FakeElement('button');
  const messagesEl = new FakeElement('div');
  const apiCalls = [];
  let activeChatId = 7;
  let currentFilePreviewRequest = null;
  let currentFilePreview = null;

  const controller = filePreviewHelpers.createController({
    documentObject,
    requestAnimationFrameFn: (callback) => callback(),
    filePreviewModal,
    filePreviewPath,
    filePreviewStatus,
    filePreviewLines,
    filePreviewExpandUp,
    filePreviewLoadFull,
    filePreviewExpandDown,
    filePreviewClose,
    messagesEl,
    apiPost: async (path, payload) => {
      apiCalls.push({ path, payload });
      return {
        preview: {
          path: payload.path || '/tmp/example.txt',
          line_start: 2,
          line_end: 3,
          window_start: 1,
          window_end: 4,
          total_lines: 10,
          can_expand_up: false,
          can_expand_down: true,
          can_load_full_file: true,
          lines: [
            { line: 1, text: 'alpha' },
            { line: 2, text: 'bravo' },
            { line: 3, text: 'charlie' },
            { line: 4, text: 'delta' },
          ],
        },
      };
    },
    getActiveChatId: () => activeChatId,
    getCurrentFilePreviewRequest: () => currentFilePreviewRequest,
    setCurrentFilePreviewRequest: (value) => {
      currentFilePreviewRequest = value || null;
    },
    getCurrentFilePreview: () => currentFilePreview,
    setCurrentFilePreview: (value) => {
      currentFilePreview = value || null;
    },
    ...overrides,
  });

  return {
    controller,
    documentObject,
    filePreviewModal,
    filePreviewPath,
    filePreviewStatus,
    filePreviewLines,
    filePreviewExpandUp,
    filePreviewLoadFull,
    filePreviewExpandDown,
    filePreviewClose,
    messagesEl,
    apiCalls,
    getCurrentFilePreviewRequest: () => currentFilePreviewRequest,
    setCurrentFilePreviewRequest: (value) => {
      currentFilePreviewRequest = value || null;
    },
    getCurrentFilePreview: () => currentFilePreview,
    setCurrentFilePreview: (value) => {
      currentFilePreview = value || null;
    },
    setActiveChatId: (value) => {
      activeChatId = value;
    },
  };
}

test('bindFilePreviewBindings reuses one listener install across message/file-preview controls', () => {
  const harness = buildHarness();

  const firstUnbind = harness.controller.bindFilePreviewBindings();
  const secondUnbind = harness.controller.bindFilePreviewBindings();

  assert.equal(typeof firstUnbind, 'function');
  assert.equal(secondUnbind, firstUnbind);
  assert.equal(harness.messagesEl.listeners('click').length, 1);
  assert.equal(harness.messagesEl.listeners('touchstart').length, 1);
  assert.equal(harness.messagesEl.listeners('touchmove').length, 1);
  assert.equal(harness.messagesEl.listeners('touchend').length, 1);
  assert.equal(harness.messagesEl.listeners('touchcancel').length, 1);
  assert.equal(harness.messagesEl.listeners('scroll').length, 1);
  assert.equal(harness.filePreviewExpandUp.listeners('click').length, 1);
  assert.equal(harness.filePreviewLoadFull.listeners('click').length, 1);
  assert.equal(harness.filePreviewExpandDown.listeners('click').length, 1);
  assert.equal(harness.filePreviewClose.listeners('click').length, 1);
  assert.equal(harness.filePreviewModal.listeners('cancel').length, 1);

  firstUnbind();
  assert.equal(harness.messagesEl.listeners('click').length, 0);
  assert.equal(harness.filePreviewClose.listeners('click').length, 0);
  assert.equal(harness.filePreviewModal.listeners('cancel').length, 0);
});

test('cloneFilePreviewRequest normalizes numeric fields and drops empty values', () => {
  const harness = buildHarness();

  const payload = harness.controller.cloneFilePreviewRequest({
    ref_id: '  ref-1  ',
    path: '  /tmp/a.txt  ',
    line_start: 4.9,
    line_end: '8',
    window_start: 0,
    window_end: '11.7',
    full_file: true,
  });

  assert.deepEqual(payload, {
    ref_id: 'ref-1',
    path: '/tmp/a.txt',
    line_start: 4,
    line_end: 8,
    window_end: 11,
    full_file: true,
  });
});

test('renderFilePreview populates lines, focus state, and summary text', () => {
  const harness = buildHarness();

  harness.controller.renderFilePreview({
    path: '/tmp/sample.txt',
    line_start: 3,
    line_end: 4,
    window_start: 2,
    window_end: 5,
    total_lines: 9,
    is_truncated: true,
    can_expand_up: true,
    can_expand_down: false,
    can_load_full_file: true,
    lines: [
      { line: 2, text: 'two' },
      { line: 3, text: 'three' },
      { line: 4, text: 'four' },
      { line: 5, text: 'five' },
    ],
  });

  assert.equal(harness.filePreviewPath.textContent, '/tmp/sample.txt');
  assert.equal(harness.filePreviewLines.children.length, 4);
  assert.equal(harness.filePreviewLines.children[1].classList.contains('is-focus'), true);
  assert.equal(harness.filePreviewLines.children[2].classList.contains('is-focus'), true);
  assert.equal(harness.filePreviewStatus.textContent, 'Showing lines 2–5 of 9 (focused excerpt)');
  assert.equal(harness.filePreviewExpandUp.disabled, false);
  assert.equal(harness.filePreviewExpandDown.disabled, true);
  assert.equal(harness.filePreviewLoadFull.textContent, 'Load full file');
});

test('expandFilePreviewInPlace prepends/appends new rows while preserving viewport offset', () => {
  const harness = buildHarness();
  harness.controller.renderFilePreview({
    path: '/tmp/sample.txt',
    line_start: 3,
    line_end: 4,
    window_start: 3,
    window_end: 4,
    total_lines: 6,
    lines: [
      { line: 3, text: 'three' },
      { line: 4, text: 'four' },
    ],
  });
  harness.filePreviewLines.scrollTop = 15;

  const merged = harness.controller.expandFilePreviewInPlace(
    harness.getCurrentFilePreview(),
    {
      path: '/tmp/sample.txt',
      line_start: 3,
      line_end: 4,
      window_start: 1,
      window_end: 6,
      total_lines: 6,
      lines: [
        { line: 1, text: 'one' },
        { line: 2, text: 'two' },
        { line: 3, text: 'three' },
        { line: 4, text: 'four' },
        { line: 5, text: 'five' },
        { line: 6, text: 'six' },
      ],
    },
  );

  assert.equal(merged, true);
  assert.deepEqual(
    harness.filePreviewLines.children.map((node) => Number(node.dataset.lineNumber)),
    [1, 2, 3, 4, 5, 6],
  );
  assert.equal(harness.filePreviewLines.scrollTop, 55);
});

test('openFilePreview shows modal, loads preview, and stores request state', async () => {
  const harness = buildHarness();

  await harness.controller.openFilePreview({ path: ' /tmp/example.txt ', line_start: 2.3 });

  assert.equal(harness.filePreviewModal.open, true);
  assert.deepEqual(harness.apiCalls, [{
    path: '/api/chats/file-preview',
    payload: {
      chat_id: 7,
      path: '/tmp/example.txt',
      line_start: 2,
    },
  }]);
  assert.deepEqual(harness.getCurrentFilePreviewRequest(), {
    path: '/tmp/example.txt',
    line_start: 2,
  });
  assert.equal(harness.filePreviewStatus.textContent, 'Showing lines 1–4 of 10');
  assert.equal(harness.filePreviewLines.children.length, 4);
});

test('openFilePreview ignores stale overlapping responses and keeps the latest preview visible', async () => {
  const firstRequest = createDeferred();
  const secondRequest = createDeferred();
  const harness = buildHarness({
    apiPost: async (path, payload) => {
      harness.apiCalls.push({ path, payload });
      if (payload.path === '/tmp/first.txt') {
        return firstRequest.promise;
      }
      return secondRequest.promise;
    },
  });

  const firstOpen = harness.controller.openFilePreview({ path: '/tmp/first.txt', line_start: 1 });
  const secondOpen = harness.controller.openFilePreview({ path: '/tmp/second.txt', line_start: 9 });

  secondRequest.resolve({
    preview: {
      path: '/tmp/second.txt',
      line_start: 9,
      line_end: 10,
      window_start: 8,
      window_end: 11,
      total_lines: 20,
      can_expand_up: true,
      can_expand_down: true,
      can_load_full_file: true,
      lines: [
        { line: 8, text: 'eight' },
        { line: 9, text: 'nine' },
        { line: 10, text: 'ten' },
        { line: 11, text: 'eleven' },
      ],
    },
  });
  await secondOpen;

  firstRequest.resolve({
    preview: {
      path: '/tmp/first.txt',
      line_start: 1,
      line_end: 2,
      window_start: 1,
      window_end: 4,
      total_lines: 20,
      can_expand_up: false,
      can_expand_down: true,
      can_load_full_file: true,
      lines: [
        { line: 1, text: 'one' },
        { line: 2, text: 'two' },
        { line: 3, text: 'three' },
        { line: 4, text: 'four' },
      ],
    },
  });
  await firstOpen;

  assert.deepEqual(harness.getCurrentFilePreviewRequest(), {
    path: '/tmp/second.txt',
    line_start: 9,
  });
  assert.equal(harness.filePreviewPath.textContent, '/tmp/second.txt');
  assert.equal(harness.filePreviewStatus.textContent, 'Showing lines 8–11 of 20');
  assert.deepEqual(
    harness.filePreviewLines.children.map((node) => Number(node.dataset.lineNumber)),
    [8, 9, 10, 11],
  );
});

test('openFilePreview ignores late responses after the modal closes', async () => {
  const deferred = createDeferred();
  const harness = buildHarness({
    apiPost: async (path, payload) => {
      harness.apiCalls.push({ path, payload });
      return deferred.promise;
    },
  });

  const openPromise = harness.controller.openFilePreview({ path: '/tmp/example.txt', line_start: 2 });
  harness.controller.closeFilePreviewModal();
  deferred.resolve({
    preview: {
      path: '/tmp/example.txt',
      line_start: 2,
      line_end: 3,
      window_start: 1,
      window_end: 4,
      total_lines: 10,
      can_expand_up: false,
      can_expand_down: true,
      can_load_full_file: true,
      lines: [
        { line: 1, text: 'one' },
        { line: 2, text: 'two' },
        { line: 3, text: 'three' },
        { line: 4, text: 'four' },
      ],
    },
  });
  await openPromise;

  assert.equal(harness.filePreviewModal.open, false);
  assert.equal(harness.getCurrentFilePreviewRequest(), null);
  assert.equal(harness.getCurrentFilePreview(), null);
  assert.equal(harness.filePreviewPath.textContent, '');
  assert.equal(harness.filePreviewLines.children.length, 0);
});

test('requestFilePreviewExpansion and requestFullFilePreview reuse current request state', async () => {
  const harness = buildHarness();
  harness.setCurrentFilePreviewRequest({ path: '/tmp/example.txt', line_start: 2, line_end: 3, window_start: 1, window_end: 4 });
  harness.setCurrentFilePreview({
    path: '/tmp/example.txt',
    line_start: 2,
    line_end: 3,
    window_start: 1,
    window_end: 4,
    total_lines: 50,
    can_expand_up: false,
    can_expand_down: true,
    can_load_full_file: true,
    full_file_loaded: false,
    lines: [
      { line: 1, text: 'one' },
      { line: 2, text: 'two' },
      { line: 3, text: 'three' },
      { line: 4, text: 'four' },
    ],
  });

  await harness.controller.requestFilePreviewExpansion('down');
  await harness.controller.requestFullFilePreview();

  assert.deepEqual(harness.apiCalls.map((entry) => entry.payload), [
    {
      chat_id: 7,
      path: '/tmp/example.txt',
      line_start: 2,
      line_end: 3,
      window_start: 1,
      window_end: 44,
    },
    {
      chat_id: 7,
      path: '/tmp/example.txt',
      line_start: 2,
      line_end: 3,
      window_start: 1,
      window_end: 44,
      full_file: true,
    },
  ]);
});

test('touch-driven file preview opens only when movement stays within mobile tap slop', async () => {
  const harness = buildHarness();
  let prevented = 0;
  const trigger = { dataset: { fileRefId: '  ref-88  ' } };

  harness.controller.handleMessageFileRefTouchStart({
    target: {
      closest(selector) {
        assert.equal(selector, '.message-file-ref');
        return trigger;
      },
    },
    touches: [{ clientX: 100, clientY: 200 }],
  });

  harness.controller.handleMessageFileRefTouchMove({
    touches: [{ clientX: 108, clientY: 207 }],
  });

  harness.controller.handleMessageFileRefClick({
    type: 'touchend',
    target: {
      closest() {
        return trigger;
      },
    },
    changedTouches: [{ clientX: 109, clientY: 208 }],
    preventDefault() {
      prevented += 1;
    },
  });

  await Promise.resolve();

  assert.equal(prevented, 1);
  assert.equal(harness.apiCalls[0].payload.ref_id, 'ref-88');
});

test('touch-driven file preview cancels when movement exceeds mobile tap slop', async () => {
  const harness = buildHarness();
  const trigger = { dataset: { fileRefId: 'ref-89' } };

  harness.controller.handleMessageFileRefTouchStart({
    target: {
      closest() {
        return trigger;
      },
    },
    touches: [{ clientX: 10, clientY: 20 }],
  });

  harness.controller.handleMessageFileRefTouchMove({
    touches: [{ clientX: 28, clientY: 20 }],
  });

  harness.controller.handleMessageFileRefClick({
    type: 'touchend',
    target: {
      closest() {
        return trigger;
      },
    },
    changedTouches: [{ clientX: 28, clientY: 20 }],
    preventDefault() {
      throw new Error('touchend should not prevent default after scroll-like movement');
    },
  });

  await Promise.resolve();

  assert.equal(harness.apiCalls.length, 0);
});

test('touch-driven file preview cancels when chat scroll begins before touchend', async () => {
  const harness = buildHarness();
  const trigger = { dataset: { fileRefId: 'ref-90' } };

  harness.controller.handleMessageFileRefTouchStart({
    target: {
      closest() {
        return trigger;
      },
    },
    touches: [{ clientX: 44, clientY: 55 }],
  });

  harness.controller.cancelPendingMessageFileRefTouch();

  harness.controller.handleMessageFileRefClick({
    type: 'touchend',
    target: {
      closest() {
        return trigger;
      },
    },
    changedTouches: [{ clientX: 45, clientY: 56 }],
    preventDefault() {
      throw new Error('touchend should not prevent default after scroll cancellation');
    },
  });

  await Promise.resolve();

  assert.equal(harness.apiCalls.length, 0);
});

test('handleMessageFileRefClick still prevents default and opens ref previews for direct click triggers', async () => {
  const harness = buildHarness();
  let prevented = 0;

  harness.controller.handleMessageFileRefClick({
    type: 'click',
    target: {
      closest(selector) {
        assert.equal(selector, '.message-file-ref');
        return { dataset: { fileRefId: '  ref-77  ' } };
      },
    },
    preventDefault() {
      prevented += 1;
    },
  });

  await Promise.resolve();

  assert.equal(prevented, 1);
  assert.equal(harness.apiCalls[0].payload.ref_id, 'ref-77');
});
