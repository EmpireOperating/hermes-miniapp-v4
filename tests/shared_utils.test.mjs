import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const shared = require('../static/app_shared_utils.js');

test('parseSseEvent returns eventName and event aliases for structured payloads', () => {
  const parsed = shared.parseSseEvent('event: tool\ndata: {"display":"Calling API"}\n\n');
  assert.ok(parsed);
  assert.equal(parsed.eventName, 'tool');
  assert.equal(parsed.event, 'tool');
  assert.deepEqual(parsed.payload, { display: 'Calling API' });
});

test('parseSseEvent returns text fallback payload for non-JSON data', () => {
  const parsed = shared.parseSseEvent('event: meta\ndata: queue running\n\n');
  assert.ok(parsed);
  assert.equal(parsed.eventName, 'meta');
  assert.equal(parsed.payload.text, 'queue running');
});

test('parseSseEvent returns null for empty data events', () => {
  assert.equal(shared.parseSseEvent('event: chunk\n\n'), null);
  assert.equal(shared.parseSseEvent(''), null);
});

test('parseSseEvent preserves message default when event field is omitted', () => {
  const parsed = shared.parseSseEvent('data: {"ok":true}\n\n');
  assert.ok(parsed);
  assert.equal(parsed.eventName, 'message');
  assert.equal(parsed.event, 'message');
  assert.deepEqual(parsed.payload, { ok: true });
});

test('parseSseEvent handles CRLF framing and leading whitespace', () => {
  const parsed = shared.parseSseEvent('  event: tool\r\n  data: {"display":"Calling API"}\r\n\r\n');
  assert.ok(parsed);
  assert.equal(parsed.eventName, 'tool');
  assert.equal(parsed.event, 'tool');
  assert.deepEqual(parsed.payload, { display: 'Calling API' });
});

function withClipboardGlobals(overrides, fn) {
  const previousDocument = globalThis.document;
  const previousNavigator = globalThis.navigator;
  const previousGetSelection = globalThis.getSelection;

  if ('document' in overrides) {
    globalThis.document = overrides.document;
  }
  if ('navigator' in overrides) {
    globalThis.navigator = overrides.navigator;
  }
  if ('getSelection' in overrides) {
    globalThis.getSelection = overrides.getSelection;
  }

  try {
    return fn();
  } finally {
    if (typeof previousDocument === 'undefined') {
      delete globalThis.document;
    } else {
      globalThis.document = previousDocument;
    }

    if (typeof previousNavigator === 'undefined') {
      delete globalThis.navigator;
    } else {
      globalThis.navigator = previousNavigator;
    }

    if (typeof previousGetSelection === 'undefined') {
      delete globalThis.getSelection;
    } else {
      globalThis.getSelection = previousGetSelection;
    }
  }
}

function createMockSelection() {
  return {
    rangeCount: 0,
    removeAllRanges() {},
    addRange() {},
    getRangeAt() {
      return { cloneRange: () => ({}) };
    },
  };
}

function createMockDocument({ execCommandImpl } = {}) {
  const listeners = new Map();
  const bodyChildren = [];

  return {
    body: {
      appendChild(node) {
        bodyChildren.push(node);
      },
    },
    createElement(tagName) {
      return {
        tagName,
        value: '',
        textContent: '',
        style: {},
        setAttribute() {},
        focus() {},
        select() {},
        setSelectionRange() {},
        remove() {},
      };
    },
    createRange() {
      return {
        selectNodeContents() {},
      };
    },
    addEventListener(name, handler) {
      listeners.set(name, handler);
    },
    removeEventListener(name) {
      listeners.delete(name);
    },
    execCommand(command) {
      assert.equal(command, 'copy');
      return execCommandImpl?.(listeners.get('copy')) ?? false;
    },
  };
}

test('copyTextToClipboard writes text through copy event payload for legacy WebKit paths', async () => {
  let clipboardText = null;
  const document = createMockDocument({
    execCommandImpl(copyHandler) {
      if (typeof copyHandler === 'function') {
        copyHandler({
          clipboardData: {
            setData(type, value) {
              if (type === 'text/plain') {
                clipboardText = value;
              }
            },
          },
          preventDefault() {},
        });
      }
      return false;
    },
  });

  const copied = await withClipboardGlobals({
    document,
    navigator: {},
    getSelection: () => createMockSelection(),
  }, () => shared.copyTextToClipboard('hello from webkit'));

  assert.equal(copied, true);
  assert.equal(clipboardText, 'hello from webkit');
});

test('copyTextToClipboard falls back to navigator.clipboard.writeText when execCommand fails', async () => {
  let clipboardText = null;
  const document = createMockDocument({
    execCommandImpl() {
      throw new Error('copy blocked');
    },
  });

  const copied = await withClipboardGlobals({
    document,
    navigator: {
      clipboard: {
        async writeText(value) {
          clipboardText = value;
        },
      },
    },
    getSelection: () => createMockSelection(),
  }, () => shared.copyTextToClipboard('navigator fallback'));

  assert.equal(copied, true);
  assert.equal(clipboardText, 'navigator fallback');
});
