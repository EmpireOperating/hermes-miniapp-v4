import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const runtime = require('../static/runtime_helpers.js');
const sharedUtils = require('../static/app_shared_utils.js');
const bootstrapAuth=require('../static/bootstrap_auth_helpers.js');
const composerViewport = require('../static/composer_viewport_helpers.js');
const interaction = require('../static/interaction_helpers.js');

function createMessageNode(messageKey, offsetTop, offsetHeight = 100) {
  return {
    dataset: { messageKey },
    offsetTop,
    offsetHeight,
  };
}

function createMessagesHarness(initialNodes = []) {
  let nodes = [...initialNodes];
  const messagesEl = {
    scrollTop: 0,
    scrollHeight: 0,
    clientHeight: 0,
    appendChild(child) {
      if (Array.isArray(child?.children)) {
        nodes.push(...child.children);
        return child;
      }
      if (child) {
        nodes.push(child);
      }
      return child;
    },
    querySelectorAll(selector) {
      if (selector === '.message') return nodes;
      return [];
    },
    querySelector(selector) {
      const keyMatch = /\.message\[data-message-key="([^"]+)"\]/.exec(selector);
      if (!keyMatch) return null;
      return nodes.find((node) => String(node?.dataset?.messageKey || '') === keyMatch[1]) || null;
    },
  };
  Object.defineProperty(messagesEl, 'innerHTML', {
    get() {
      return nodes.length ? '[messages]' : '';
    },
    set(value) {
      if (value === '') {
        nodes = [];
      }
    },
  });
  return {
    messagesEl,
    getNodes: () => nodes,
    setNodes: (nextNodes) => {
      nodes = [...nextNodes];
    },
  };
}


function createComposerViewportHarness() {
  const promptListeners = new Map();
  const windowListeners = new Map();
  const viewportListeners = new Map();
  const documentListeners = new Map();
  const body = { tagName: 'BODY' };
  const documentElement = {
    style: {
      setProperty: () => {},
    },
  };
  const documentObject = {
    visibilityState: 'visible',
    activeElement: body,
    body,
    documentElement,
    querySelector: () => null,
    addEventListener: (eventName, handler) => {
      documentListeners.set(eventName, handler);
    },
  };
  const promptEl = {
    disabled: false,
    value: '',
    focusCalls: 0,
    blurCalls: 0,
    addEventListener: (eventName, handler) => {
      if (!promptListeners.has(eventName)) {
        promptListeners.set(eventName, []);
      }
      promptListeners.get(eventName).push(handler);
    },
    focus: () => {
      promptEl.focusCalls += 1;
      documentObject.activeElement = promptEl;
    },
    blur: () => {
      promptEl.blurCalls += 1;
      documentObject.activeElement = body;
    },
    setSelectionRange: () => {},
    getBoundingClientRect: () => ({ top: 600, bottom: 640 }),
  };
  const form = {
    scrollIntoView: () => {},
  };
  const windowObject = {
    innerHeight: 800,
    scrollBy: () => {},
    setTimeout: () => 1,
    clearTimeout: () => {},
    setInterval: () => 1,
    clearInterval: () => {},
    addEventListener: (eventName, handler) => {
      windowListeners.set(eventName, handler);
    },
    visualViewport: {
      height: 800,
      offsetTop: 0,
      addEventListener: (eventName, handler) => {
        viewportListeners.set(eventName, handler);
      },
    },
  };
  const controller = composerViewport.createController({
    windowObject,
    documentObject,
    tg: null,
    promptEl,
    form,
    messagesEl: null,
    tabsEl: null,
    mobileQuoteMode: true,
    isNearBottomFn: () => false,
    getActiveChatId: () => 7,
    chatScrollTop: new Map(),
    chatStickToBottom: new Map(),
    updateJumpLatestVisibility: () => {},
  });
  controller.installKeyboardViewportSync();
  return {
    promptEl,
    documentObject,
    dispatchPromptEvent(eventName, event) {
      for (const handler of promptListeners.get(eventName) || []) {
        handler(event);
      }
    },
  };
}


export {
  test,
  assert,
  runtime,
  sharedUtils,
  bootstrapAuth,
  composerViewport,
  interaction,
  createMessageNode,
  createMessagesHarness,
  createComposerViewportHarness,
};
