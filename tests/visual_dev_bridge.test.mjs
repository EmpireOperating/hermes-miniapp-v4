import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const bridgeModulePath = require.resolve('../static/visual_dev_bridge.js');
const bridge = require(bridgeModulePath);

function loadBridgeFresh() {
  delete require.cache[bridgeModulePath];
  return require(bridgeModulePath);
}

function buildHarness(overrides = {}) {
  const posted = [];
  const listeners = new Map();
  const documentListeners = new Map();
  const windowObject = {
    location: {
      href: 'https://preview.example.com/app',
      origin: 'https://preview.example.com',
    },
    parent: {
      postMessage(payload, targetOrigin) {
        posted.push({ payload, targetOrigin });
      },
    },
    addEventListener(type, handler) {
      listeners.set(type, handler);
    },
    removeEventListener(type) {
      listeners.delete(type);
    },
    setInterval: overrides.setInterval || (() => 0),
    clearInterval: overrides.clearInterval || (() => {}),
    ...overrides.windowObject,
  };
  const documentObject = {
    title: 'Preview title',
    documentElement: {
      dataset: {},
    },
    addEventListener(type, handler, options) {
      documentListeners.set(type, { handler, options });
    },
    removeEventListener(type) {
      documentListeners.delete(type);
    },
    ...overrides.documentObject,
  };
  const controller = bridge.createController({
    windowObject,
    documentObject,
    captureScreenshot: overrides.captureScreenshot,
  });
  return {
    controller,
    posted,
    listeners,
    documentListeners,
    windowObject,
    documentObject,
  };
}

test('handleConnect stores session metadata and posts ready handshake', () => {
  const harness = buildHarness();
  harness.controller.install();
  const messageHandler = harness.listeners.get('message');

  messageHandler({
    origin: 'https://miniapp.example.com',
    data: {
      type: 'hermes-visual-dev:connect',
      sessionId: 'session-1',
      parentOrigin: 'https://miniapp.example.com',
    },
  });

  assert.equal(harness.documentObject.documentElement.dataset.visualDevSessionId, 'session-1');
  assert.deepEqual(harness.posted, [{
    payload: {
      type: 'hermes-visual-dev:ready',
      sessionId: 'session-1',
      previewUrl: 'https://preview.example.com/app',
      previewTitle: 'Preview title',
    },
    targetOrigin: 'https://miniapp.example.com',
  }]);
});

test('handleConnect starts heartbeat and dispose clears it', () => {
  const intervals = [];
  const cleared = [];
  const harness = buildHarness({
    setInterval(handler, delayMs) {
      intervals.push({ handler, delayMs });
      return `interval-${intervals.length}`;
    },
    clearInterval(intervalId) {
      cleared.push(intervalId);
    },
  });

  harness.controller.handleConnect({
    sessionId: 'session-1',
    parentOrigin: 'https://miniapp.example.com',
  });

  assert.equal(intervals.length, 1);
  assert.equal(intervals[0].delayMs, 5000);
  intervals[0].handler();
  assert.deepEqual(harness.posted.at(-1), {
    payload: {
      type: 'hermes-visual-dev:runtime',
      sessionId: 'session-1',
      runtime: { state: 'live' },
    },
    targetOrigin: 'https://miniapp.example.com',
  });

  harness.controller.dispose();

  assert.deepEqual(cleared, ['interval-1']);
});

test('reportSelection and reportConsole forward typed payloads after connect', () => {
  const harness = buildHarness();
  harness.controller.install();
  harness.controller.handleConnect({
    sessionId: 'session-1',
    parentOrigin: 'https://miniapp.example.com',
  });

  harness.controller.reportSelection({ label: 'Play button' });
  harness.controller.reportConsole({ level: 'warn', message: 'Hot reload fallback' });

  assert.deepEqual(harness.posted.slice(0, 2), [
    {
      payload: {
        type: 'hermes-visual-dev:ready',
        sessionId: 'session-1',
        previewUrl: 'https://preview.example.com/app',
        previewTitle: 'Preview title',
      },
      targetOrigin: 'https://miniapp.example.com',
    },
    {
      payload: {
        type: 'hermes-visual-dev:selection',
        sessionId: 'session-1',
        selection: { label: 'Play button' },
      },
      targetOrigin: 'https://miniapp.example.com',
    },
  ]);
  assert.deepEqual(harness.posted[2], {
    payload: {
      type: 'hermes-visual-dev:console',
      sessionId: 'session-1',
      consoleEvent: { level: 'warn', message: 'Hot reload fallback' },
    },
    targetOrigin: 'https://miniapp.example.com',
  });
});

test('reportScreenshot sends screenshot envelope only after connect', () => {
  const harness = buildHarness();

  harness.controller.reportScreenshot({ label: 'viewport capture' });
  assert.equal(harness.posted.length, 0);

  harness.controller.handleConnect({
    sessionId: 'session-1',
    parentOrigin: 'https://miniapp.example.com',
  });
  harness.controller.reportScreenshot({ label: 'viewport capture' });

  assert.deepEqual(harness.posted.at(-1), {
    payload: {
      type: 'hermes-visual-dev:screenshot',
      sessionId: 'session-1',
      screenshot: { label: 'viewport capture' },
    },
    targetOrigin: 'https://miniapp.example.com',
  });
});

test('trusted command message starts inspect mode and reports clicked element metadata', () => {
  const target = {
    tagName: 'BUTTON',
    id: 'play-button',
    className: 'cta primary',
    textContent: 'Play now',
    closest() { return this; },
    getAttribute(name) { return name === 'aria-label' ? 'Play' : null; },
    getBoundingClientRect() {
      return { left: 10, top: 20, width: 120, height: 48 };
    },
  };
  const harness = buildHarness();
  harness.controller.install();
  harness.controller.handleConnect({
    sessionId: 'session-1',
    parentOrigin: 'https://miniapp.example.com',
  });

  const windowMessageHandler = harness.listeners.get('message');
  windowMessageHandler({
    origin: 'https://miniapp.example.com',
    data: {
      type: 'hermes-visual-dev:command',
      sessionId: 'session-1',
      command: 'inspect-start',
      payload: { source: 'toolbar' },
    },
  });

  const clickHandler = harness.documentListeners.get('click')?.handler;
  assert.equal(typeof clickHandler, 'function');
  clickHandler({
    preventDefault() {},
    stopPropagation() {},
    target,
  });

  assert.equal(harness.documentListeners.has('click'), false);
  assert.deepEqual(harness.posted.at(-1), {
    payload: {
      type: 'hermes-visual-dev:selection',
      sessionId: 'session-1',
      selection: {
        label: 'Play',
        selector: '#play-button',
        tagName: 'button',
        text: 'Play now',
        rect: { left: 10, top: 20, width: 120, height: 48 },
        source: 'toolbar',
      },
    },
    targetOrigin: 'https://miniapp.example.com',
  });
});

test('trusted command message captures screenshot via injected hook and reports the artifact payload', async () => {
  const harness = buildHarness({
    captureScreenshot: async () => ({
      contentType: 'image/png',
      bytesB64: 'Zm9v',
      label: 'viewport capture',
    }),
  });
  harness.controller.install();
  harness.controller.handleConnect({
    sessionId: 'session-1',
    parentOrigin: 'https://miniapp.example.com',
  });

  const windowMessageHandler = harness.listeners.get('message');
  await windowMessageHandler({
    origin: 'https://miniapp.example.com',
    data: {
      type: 'hermes-visual-dev:command',
      sessionId: 'session-1',
      command: 'capture-full',
      payload: { source: 'toolbar', capture: 'full' },
    },
  });

  assert.deepEqual(harness.posted.at(-1), {
    payload: {
      type: 'hermes-visual-dev:screenshot',
      sessionId: 'session-1',
      screenshot: {
        contentType: 'image/png',
        bytesB64: 'Zm9v',
        label: 'viewport capture',
        source: 'toolbar',
        capture: 'full',
      },
    },
    targetOrigin: 'https://miniapp.example.com',
  });
});

test('trusted command message captures a region screenshot and preserves region metadata', async () => {
  const captureCalls = [];
  const harness = buildHarness({
    captureScreenshot: async (payload) => {
      captureCalls.push(payload);
      return {
        contentType: 'image/png',
        bytesB64: 'YmFy',
        label: 'toolbar region',
      };
    },
  });
  harness.controller.install();
  harness.controller.handleConnect({
    sessionId: 'session-1',
    parentOrigin: 'https://miniapp.example.com',
  });

  const windowMessageHandler = harness.listeners.get('message');
  await windowMessageHandler({
    origin: 'https://miniapp.example.com',
    data: {
      type: 'hermes-visual-dev:command',
      sessionId: 'session-1',
      command: 'capture-region',
      payload: {
        source: 'toolbar',
        capture: 'region',
        region: { left: 10, top: 20, width: 120, height: 48 },
      },
    },
  });

  assert.deepEqual(captureCalls, [{
    source: 'toolbar',
    capture: 'region',
    region: { left: 10, top: 20, width: 120, height: 48 },
  }]);
  assert.deepEqual(harness.posted.at(-1), {
    payload: {
      type: 'hermes-visual-dev:screenshot',
      sessionId: 'session-1',
      screenshot: {
        contentType: 'image/png',
        bytesB64: 'YmFy',
        label: 'toolbar region',
        source: 'toolbar',
        capture: 'region',
        region: { left: 10, top: 20, width: 120, height: 48 },
      },
    },
    targetOrigin: 'https://miniapp.example.com',
  });
});

test('controller falls back to built-in DOM screenshot capture when no hook is injected', async () => {
  const imageLoads = [];
  class FakeImage {
    constructor() {
      this.onload = null;
      this.onerror = null;
    }

    set src(value) {
      imageLoads.push(value);
      this._src = value;
      Promise.resolve().then(() => this.onload?.());
    }

    get src() {
      return this._src;
    }
  }

  const drawCalls = [];
  const harness = buildHarness({
    windowObject: {
      innerWidth: 640,
      innerHeight: 360,
      devicePixelRatio: 1,
      Image: FakeImage,
      XMLSerializer: class {
        serializeToString(node) {
          return `<html>${node?.outerHTML || ''}</html>`;
        }
      },
      btoa(value) {
        return Buffer.from(String(value), 'binary').toString('base64');
      },
      encodeURIComponent,
      unescape,
    },
    documentObject: {
      documentElement: {
        dataset: {},
        outerHTML: '<body><main>Preview</main></body>',
        scrollWidth: 640,
        scrollHeight: 360,
        clientWidth: 640,
        clientHeight: 360,
      },
      body: {
        scrollWidth: 640,
        scrollHeight: 360,
      },
      createElement(tagName) {
        assert.equal(tagName, 'canvas');
        return {
          width: 0,
          height: 0,
          getContext(type) {
            assert.equal(type, '2d');
            return {
              drawImage(...args) {
                drawCalls.push(args);
              },
            };
          },
          toDataURL(type) {
            assert.equal(type, 'image/png');
            return 'data:image/png;base64,ZmFrZS1zY3JlZW5zaG90';
          },
        };
      },
    },
  });
  harness.controller.install();
  harness.controller.handleConnect({
    sessionId: 'session-1',
    parentOrigin: 'https://miniapp.example.com',
  });

  const windowMessageHandler = harness.listeners.get('message');
  await windowMessageHandler({
    origin: 'https://miniapp.example.com',
    data: {
      type: 'hermes-visual-dev:command',
      sessionId: 'session-1',
      command: 'capture-full',
      payload: { source: 'toolbar', capture: 'full' },
    },
  });

  assert.equal(imageLoads.length, 1);
  assert.match(imageLoads[0], /^data:image\/svg\+xml;charset=utf-8,/);
  assert.equal(drawCalls.length, 1);
  assert.equal(drawCalls[0].length, 3);
  assert.equal(drawCalls[0][1], 0);
  assert.equal(drawCalls[0][2], 0);
  assert.deepEqual(harness.posted.at(-1), {
    payload: {
      type: 'hermes-visual-dev:screenshot',
      sessionId: 'session-1',
      screenshot: {
        contentType: 'image/png',
        bytesB64: 'ZmFrZS1zY3JlZW5zaG90',
        label: 'viewport screenshot',
        width: 640,
        height: 360,
        source: 'toolbar',
        capture: 'full',
      },
    },
    targetOrigin: 'https://miniapp.example.com',
  });
});

test('module auto-installs a visual-dev bridge listener in browser-like preview contexts', () => {
  const listeners = new Map();
  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;
  try {
    globalThis.window = {
      parent: { postMessage() {} },
      location: { href: 'https://preview.example.com/app', origin: 'https://preview.example.com' },
      addEventListener(type, handler) {
        listeners.set(type, handler);
      },
      removeEventListener(type) {
        listeners.delete(type);
      },
    };
    globalThis.window.window = globalThis.window;
    globalThis.document = {
      title: 'Preview title',
      documentElement: { dataset: {} },
      addEventListener() {},
      removeEventListener() {},
      createElement() {
        throw new Error('not used in this test');
      },
    };
    globalThis.window.document = globalThis.document;

    const freshBridge = loadBridgeFresh();
    assert.ok(freshBridge);
    assert.equal(typeof listeners.get('message'), 'function');
  } finally {
    if (previousWindow === undefined) {
      delete globalThis.window;
    } else {
      globalThis.window = previousWindow;
    }
    if (previousDocument === undefined) {
      delete globalThis.document;
    } else {
      globalThis.document = previousDocument;
    }
    delete require.cache[bridgeModulePath];
    require(bridgeModulePath);
  }
});

test('buildScreenshotPlan captures the current visible viewport by honoring scroll offsets', () => {
  const plan = bridge._test.buildScreenshotPlan({
    innerWidth: 640,
    innerHeight: 360,
    scrollX: 25,
    scrollY: 180,
  }, {
    documentElement: {
      clientWidth: 640,
      clientHeight: 360,
      scrollWidth: 1280,
      scrollHeight: 2400,
    },
    body: {
      clientWidth: 640,
      clientHeight: 360,
      scrollWidth: 1280,
      scrollHeight: 2400,
    },
  }, { capture: 'full' });

  assert.deepEqual(plan, {
    capture: 'full',
    sourceWidth: 1280,
    sourceHeight: 2400,
    canvasWidth: 640,
    canvasHeight: 360,
    offsetLeft: 25,
    offsetTop: 180,
    region: null,
  });
});

test('serializeVisibleDocument omits hidden nodes, including descendants of hidden parents, and preserves visible computed styling', () => {
  function createSnapshotNode(tagName = '', nodeType = 1, textContent = '') {
    return {
      nodeType,
      tagName,
      textContent,
      attributes: [],
      childNodes: [],
      namespaceURI: 'http://www.w3.org/1999/xhtml',
      style: {
        cssText: '',
        setProperty(name, value) {
          this.cssText += `${name}:${value};`;
        },
      },
      setAttribute(name, value) {
        const existing = this.attributes.find((attribute) => attribute.name === name);
        if (existing) existing.value = String(value);
        else this.attributes.push({ name: String(name), value: String(value) });
      },
      appendChild(child) {
        this.childNodes.push(child);
        return child;
      },
      get outerHTML() {
        if (this.nodeType === 3) {
          return this.textContent;
        }
        const attrs = [];
        if (this.style.cssText) {
          attrs.push(`style="${this.style.cssText}"`);
        }
        this.attributes.forEach((attribute) => {
          attrs.push(`${attribute.name}="${attribute.value}"`);
        });
        const open = attrs.length ? `<${this.tagName.toLowerCase()} ${attrs.join(' ')}>` : `<${this.tagName.toLowerCase()}>`;
        return `${open}${this.childNodes.map((child) => child.outerHTML || child.textContent || '').join('')}</${this.tagName.toLowerCase()}>`;
      },
    };
  }

  function createSourceElement(tagName, { text = '', hidden = false, attrs = [] } = {}) {
    return {
      nodeType: 1,
      tagName,
      hidden,
      attributes: attrs.map(([name, value]) => ({ name, value })),
      childNodes: text ? [{ nodeType: 3, textContent: text }] : [],
      namespaceURI: 'http://www.w3.org/1999/xhtml',
      getAttribute(name) {
        const match = this.attributes.find((attribute) => attribute.name === name);
        return match ? match.value : null;
      },
      getBoundingClientRect() {
        return { left: 0, top: 0, width: 100, height: 20 };
      },
    };
  }

  const visibleNode = createSourceElement('DIV', { text: 'Visible content', attrs: [['data-role', 'visible']] });
  const hiddenParent = createSourceElement('SECTION', { attrs: [['data-role', 'hidden-parent']] });
  const hiddenDescendant = createSourceElement('BUTTON', { text: 'Hidden by parent' });
  hiddenDescendant.parentElement = hiddenParent;
  hiddenParent.childNodes = [hiddenDescendant];
  const hiddenNode = createSourceElement('BUTTON', { text: 'Hidden action', hidden: true });
  const sourceDocument = {
    documentElement: createSourceElement('HTML'),
    body: createSourceElement('BODY'),
    implementation: {
      createHTMLDocument() {
        const snapshotRoot = createSnapshotNode('HTML');
        const snapshotBody = createSnapshotNode('BODY');
        return {
          documentElement: snapshotRoot,
          body: snapshotBody,
          createElement(tagName) {
            return createSnapshotNode(tagName);
          },
          createElementNS(_namespace, tagName) {
            return createSnapshotNode(tagName);
          },
          createTextNode(text) {
            return createSnapshotNode('', 3, text);
          },
        };
      },
    },
  };
  sourceDocument.body.childNodes = [visibleNode, hiddenParent, hiddenNode];
  const styleMap = new Map([
    [sourceDocument.documentElement, { display: 'block', visibility: 'visible', position: 'static', cssText: 'background:#000;' }],
    [sourceDocument.body, { display: 'block', visibility: 'visible', position: 'static', cssText: 'margin:0;background:#111;' }],
    [visibleNode, { display: 'block', visibility: 'visible', position: 'static', cssText: 'color: rgb(255, 255, 255);' }],
    [hiddenParent, { display: 'none', visibility: 'visible', position: 'static', cssText: 'display:none;' }],
    [hiddenDescendant, { display: 'inline-flex', visibility: 'visible', position: 'static', cssText: 'display:inline-flex;' }],
    [hiddenNode, { display: 'none', visibility: 'visible', position: 'static', cssText: 'display:none;' }],
  ]);
  const serialized = bridge._test.serializeVisibleDocument({
    getComputedStyle(node) {
      return styleMap.get(node) || { display: 'block', visibility: 'visible', position: 'static', cssText: '' };
    },
    XMLSerializer: class {
      serializeToString(node) {
        return node.outerHTML;
      }
    },
  }, sourceDocument);

  assert.match(serialized, /Visible content/);
  assert.match(serialized, /color: rgb\(255, 255, 255\)/);
  assert.doesNotMatch(serialized, /Hidden action/);
  assert.doesNotMatch(serialized, /Hidden by parent/);
});

test('serializeVisibleDocument omits offscreen nodes outside the current viewport', () => {
  function createSnapshotNode(tagName = '', nodeType = 1, textContent = '') {
    return {
      nodeType,
      tagName,
      textContent,
      attributes: [],
      childNodes: [],
      namespaceURI: 'http://www.w3.org/1999/xhtml',
      style: {
        cssText: '',
        setProperty(name, value) {
          this.cssText += `${name}:${value};`;
        },
      },
      setAttribute(name, value) {
        const existing = this.attributes.find((attribute) => attribute.name === name);
        if (existing) existing.value = String(value);
        else this.attributes.push({ name: String(name), value: String(value) });
      },
      appendChild(child) {
        this.childNodes.push(child);
        return child;
      },
      get outerHTML() {
        if (this.nodeType === 3) {
          return this.textContent;
        }
        const attrs = [];
        if (this.style.cssText) {
          attrs.push(`style="${this.style.cssText}"`);
        }
        this.attributes.forEach((attribute) => {
          attrs.push(`${attribute.name}="${attribute.value}"`);
        });
        const open = attrs.length ? `<${this.tagName.toLowerCase()} ${attrs.join(' ')}>` : `<${this.tagName.toLowerCase()}>`;
        return `${open}${this.childNodes.map((child) => child.outerHTML || child.textContent || '').join('')}</${this.tagName.toLowerCase()}>`;
      },
    };
  }

  function createSourceElement(tagName, { text = '', rect = { left: 0, top: 0, width: 100, height: 20 } } = {}) {
    return {
      nodeType: 1,
      tagName,
      hidden: false,
      attributes: [],
      childNodes: text ? [{ nodeType: 3, textContent: text }] : [],
      namespaceURI: 'http://www.w3.org/1999/xhtml',
      getBoundingClientRect() {
        return rect;
      },
    };
  }

  const visibleNode = createSourceElement('DIV', { text: 'Visible viewport content', rect: { left: 0, top: 24, width: 180, height: 36 } });
  const offscreenNode = createSourceElement('BUTTON', { text: 'Offscreen action', rect: { left: 0, top: 900, width: 180, height: 36 } });
  const sourceDocument = {
    documentElement: createSourceElement('HTML', { rect: { left: 0, top: 0, width: 320, height: 200 } }),
    body: createSourceElement('BODY', { rect: { left: 0, top: 0, width: 320, height: 200 } }),
    implementation: {
      createHTMLDocument() {
        const snapshotRoot = createSnapshotNode('HTML');
        const snapshotBody = createSnapshotNode('BODY');
        return {
          documentElement: snapshotRoot,
          body: snapshotBody,
          createElement(tagName) {
            return createSnapshotNode(tagName);
          },
          createElementNS(_namespace, tagName) {
            return createSnapshotNode(tagName);
          },
          createTextNode(text) {
            return createSnapshotNode('', 3, text);
          },
        };
      },
    },
  };
  sourceDocument.documentElement.clientWidth = 320;
  sourceDocument.documentElement.clientHeight = 200;
  sourceDocument.body.clientWidth = 320;
  sourceDocument.body.clientHeight = 200;
  sourceDocument.body.childNodes = [visibleNode, offscreenNode];
  const serialized = bridge._test.serializeVisibleDocument({
    innerWidth: 320,
    innerHeight: 200,
    getComputedStyle() {
      return { display: 'block', visibility: 'visible', position: 'static', cssText: '' };
    },
    XMLSerializer: class {
      serializeToString(node) {
        return node.outerHTML;
      }
    },
  }, sourceDocument);

  assert.match(serialized, /Visible viewport content/);
  assert.doesNotMatch(serialized, /Offscreen action/);
});
