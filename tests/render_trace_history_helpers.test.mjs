import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const renderTraceHistoryHelpers = require('../static/render_trace_history_helpers.js');
const renderTraceMessageHelpers = require('../static/render_trace_message_helpers.js');

test('createHistoryRenderController computes bottom virtual ranges with overscan', () => {
  const controller = renderTraceHistoryHelpers.createHistoryRenderController({
    messagesEl: { scrollHeight: 0, clientHeight: 480, scrollTop: 0, querySelectorAll: () => [], appendChild: () => {} },
    jumpLatestButton: null,
    jumpLastStartButton: null,
    histories: new Map(),
    virtualizationRanges: new Map(),
    virtualMetrics: new Map(),
    renderedHistoryLength: new Map(),
    renderedHistoryVirtualized: new Map(),
    unseenStreamChats: new Set(),
    chatScrollTop: new Map(),
    chatStickToBottom: new Map(),
    getActiveChatId: () => 0,
    getRenderedChatId: () => 0,
    setRenderedChatId: () => {},
    appendMessagesFn: () => {},
    shouldUseAppendOnlyRenderFn: () => false,
    renderTraceLogFn: () => {},
    virtualOverscan: 10,
    estimatedMessageHeight: 100,
  });

  const range = controller.computeVirtualRange({
    total: 200,
    scrollTop: 0,
    viewportHeight: 400,
    forceBottom: true,
    estimatedHeight: 100,
  });

  assert.deepEqual(range, { start: 176, end: 200 });
});

test('createHistoryRenderController markStreamUpdate only marks active off-bottom chat', () => {
  const unseen = new Set();
  const refreshed = [];
  const messagesEl = {
    scrollHeight: 1000,
    clientHeight: 400,
    scrollTop: 200,
    querySelectorAll: () => [],
    appendChild: () => {},
  };
  const controller = renderTraceHistoryHelpers.createHistoryRenderController({
    messagesEl,
    jumpLatestButton: { hidden: true },
    jumpLastStartButton: { hidden: true },
    histories: new Map(),
    virtualizationRanges: new Map(),
    virtualMetrics: new Map(),
    renderedHistoryLength: new Map(),
    renderedHistoryVirtualized: new Map(),
    unseenStreamChats: unseen,
    chatScrollTop: new Map(),
    chatStickToBottom: new Map(),
    getActiveChatId: () => 7,
    getRenderedChatId: () => 0,
    setRenderedChatId: () => {},
    refreshTabNode: (chatId) => refreshed.push(chatId),
    appendMessagesFn: () => {},
    shouldUseAppendOnlyRenderFn: () => false,
    renderTraceLogFn: () => {},
  });

  controller.markStreamUpdate(5);
  assert.equal(unseen.size, 0);

  controller.markStreamUpdate(7);
  assert.equal(unseen.has(7), true);
  assert.deepEqual(refreshed, [7]);
});

test('createHistoryRenderController markStreamUpdate delegates active unseen stream state to read-state authority when available', () => {
  const delegated = [];
  const refreshed = [];
  const messagesEl = {
    scrollHeight: 1000,
    clientHeight: 400,
    scrollTop: 200,
    querySelectorAll: () => [],
    appendChild: () => {},
  };
  const controller = renderTraceHistoryHelpers.createHistoryRenderController({
    messagesEl,
    jumpLatestButton: { hidden: true },
    jumpLastStartButton: { hidden: true },
    histories: new Map(),
    virtualizationRanges: new Map(),
    virtualMetrics: new Map(),
    renderedHistoryLength: new Map(),
    renderedHistoryVirtualized: new Map(),
    unseenStreamChats: new Set(),
    chatScrollTop: new Map(),
    chatStickToBottom: new Map(),
    getActiveChatId: () => 7,
    getRenderedChatId: () => 0,
    setRenderedChatId: () => {},
    refreshTabNode: (chatId) => refreshed.push(chatId),
    syncActiveStreamUnseenState: (chatId, options = {}) => {
      delegated.push([chatId, { atBottom: options.atBottom, hasCallback: typeof options.onBecameUnseen === 'function' }]);
      if (Number(chatId) === 7 && options.atBottom === false) {
        options.onBecameUnseen?.(Number(chatId));
        return true;
      }
      return false;
    },
    appendMessagesFn: () => {},
    shouldUseAppendOnlyRenderFn: () => false,
    renderTraceLogFn: () => {},
  });

  controller.markStreamUpdate(5);
  controller.markStreamUpdate(7);

  assert.deepEqual(delegated, [[7, { atBottom: false, hasCallback: true }]]);
  assert.deepEqual(refreshed, [7]);
});

test('createHistoryRenderController keeps jump-to-last-start visible whenever a final message target exists', () => {
  const jumpLatestButton = { hidden: true };
  const jumpLastStartButton = { hidden: true };
  const renderedMessages = [
    { dataset: { messageKey: '1' }, offsetTop: 0 },
    { dataset: { messageKey: '2' }, offsetTop: 1200 },
  ];
  const messagesEl = {
    scrollHeight: 2400,
    clientHeight: 400,
    scrollTop: 150,
    querySelectorAll(selector) {
      if (selector === '.message') {
        return renderedMessages;
      }
      return [];
    },
    appendChild: () => {},
  };
  const controller = renderTraceHistoryHelpers.createHistoryRenderController({
    messagesEl,
    jumpLatestButton,
    jumpLastStartButton,
    histories: new Map(),
    virtualizationRanges: new Map(),
    virtualMetrics: new Map(),
    renderedHistoryLength: new Map(),
    renderedHistoryVirtualized: new Map(),
    unseenStreamChats: new Set(),
    chatScrollTop: new Map(),
    chatStickToBottom: new Map(),
    getActiveChatId: () => 7,
    getRenderedChatId: () => 7,
    setRenderedChatId: () => {},
    appendMessagesFn: () => {},
    shouldUseAppendOnlyRenderFn: () => false,
    renderTraceLogFn: () => {},
  });

  controller.updateJumpLatestVisibility();

  assert.equal(jumpLatestButton.hidden, false);
  assert.equal(jumpLastStartButton.hidden, false);
});

test('createHistoryRenderController append-only render preserves absolute history indices for appended nodes', () => {
  const histories = new Map([[7, [
    { id: 1, role: 'operator', body: 'prompt', created_at: '2026-04-08T08:00:00Z' },
    { role: 'tool', body: 'read_file', created_at: '2026-04-08T08:00:01Z', pending: true },
  ]]]);
  const renderedHistoryLength = new Map([[7, 1]]);
  const renderedHistoryVirtualized = new Map([[7, false]]);
  const appendedCalls = [];
  const renderedNodes = [{ dataset: { messageKey: 'id:1' } }];
  const messagesEl = {
    scrollHeight: 1000,
    clientHeight: 400,
    scrollTop: 600,
    innerHTML: '',
    appendChild(node) {
      if (node && Array.isArray(node.children)) {
        renderedNodes.push(...node.children);
      }
    },
    querySelectorAll(selector) {
      if (selector === '.message') {
        return renderedNodes;
      }
      return [];
    },
  };
  const controller = renderTraceHistoryHelpers.createHistoryRenderController({
    messagesEl,
    jumpLatestButton: { hidden: true },
    jumpLastStartButton: { hidden: true },
    histories,
    virtualizationRanges: new Map(),
    virtualMetrics: new Map(),
    renderedHistoryLength,
    renderedHistoryVirtualized,
    unseenStreamChats: new Set(),
    chatScrollTop: new Map(),
    chatStickToBottom: new Map(),
    getActiveChatId: () => 7,
    getRenderedChatId: () => 7,
    setRenderedChatId: () => {},
    refreshTabNode: () => {},
    clearSelectionQuoteStateFn: () => {},
    syncLiveToolStreamForChatFn: () => {},
    appendMessagesFn: (fragment, messages, options = {}) => {
      appendedCalls.push({ messages, options });
      messages.forEach((message, offset) => {
        fragment.children.push({
          dataset: { messageKey: renderTraceMessageHelpers.messageStableKey(message, Number(options.startIndex || 0) + offset) },
        });
      });
    },
    shouldUseAppendOnlyRenderFn: () => true,
    renderTraceLogFn: () => {},
    createFragmentFn: () => ({ children: [] }),
  });

  controller.renderMessages(7, { preserveViewport: true });

  assert.equal(appendedCalls.length, 1);
  assert.equal(appendedCalls[0].options.startIndex, 1);
  assert.deepEqual(
    renderedNodes.map((node) => node.dataset.messageKey),
    ['id:1', 'local:tool:pending:2026-04-08T08:00:01Z:1'],
  );
});

test('createHistoryRenderController append-only render preserves viewport when cached bottom stickiness is stale', () => {
  const histories = new Map([[7, [
    { id: 1, role: 'operator', body: 'prompt', created_at: '2026-04-08T08:00:00Z' },
    { role: 'tool', body: 'read_file', created_at: '2026-04-08T08:00:01Z', pending: true },
  ]]]);
  const renderedHistoryLength = new Map([[7, 1]]);
  const renderedHistoryVirtualized = new Map([[7, false]]);
  const renderedNodes = [{ dataset: { messageKey: 'id:1' } }];
  const chatScrollTop = new Map();
  const chatStickToBottom = new Map([[7, true]]);
  const messagesEl = {
    scrollHeight: 1000,
    clientHeight: 400,
    scrollTop: 220,
    innerHTML: '',
    appendChild(node) {
      if (node && Array.isArray(node.children)) {
        renderedNodes.push(...node.children);
      }
    },
    querySelectorAll(selector) {
      if (selector === '.message') {
        return renderedNodes;
      }
      return [];
    },
  };
  const controller = renderTraceHistoryHelpers.createHistoryRenderController({
    messagesEl,
    jumpLatestButton: { hidden: true },
    jumpLastStartButton: { hidden: true },
    histories,
    virtualizationRanges: new Map(),
    virtualMetrics: new Map(),
    renderedHistoryLength,
    renderedHistoryVirtualized,
    unseenStreamChats: new Set(),
    chatScrollTop,
    chatStickToBottom,
    getActiveChatId: () => 7,
    getRenderedChatId: () => 7,
    setRenderedChatId: () => {},
    refreshTabNode: () => {},
    clearSelectionQuoteStateFn: () => {},
    syncLiveToolStreamForChatFn: () => {},
    appendMessagesFn: (fragment, messages, options = {}) => {
      messages.forEach((message, offset) => {
        fragment.children.push({
          dataset: { messageKey: renderTraceMessageHelpers.messageStableKey(message, Number(options.startIndex || 0) + offset) },
        });
      });
    },
    shouldUseAppendOnlyRenderFn: () => true,
    renderTraceLogFn: () => {},
    createFragmentFn: () => ({ children: [] }),
  });

  controller.renderMessages(7, { preserveViewport: true });

  assert.equal(messagesEl.scrollTop, 220);
  assert.equal(chatScrollTop.get(7), 220);
  assert.equal(chatStickToBottom.get(7), false);
});

test('createHistoryRenderController preserves exact bottom viewport on append so new replies stay unread until the user scrolls again', () => {
  const histories = new Map([[7, [
    { id: 1, role: 'operator', body: 'prompt', created_at: '2026-04-08T08:00:00Z' },
    { id: 2, role: 'assistant', body: 'first reply', created_at: '2026-04-08T08:00:01Z' },
    { id: 3, role: 'assistant', body: 'new reply', created_at: '2026-04-08T08:00:02Z' },
  ]]]);
  const renderedHistoryLength = new Map([[7, 2]]);
  const renderedHistoryVirtualized = new Map([[7, false]]);
  const renderedNodes = [
    { dataset: { messageKey: 'id:1' }, offsetTop: 0, offsetHeight: 300 },
    { dataset: { messageKey: 'id:2' }, offsetTop: 300, offsetHeight: 300 },
  ];
  const unreadRefreshes = [];
  const delegatedReadState = [];
  const unseenStreamChats = new Set([7]);
  const chatScrollTop = new Map();
  const chatStickToBottom = new Map([[7, true]]);
  const messagesEl = {
    scrollHeight: 600,
    clientHeight: 300,
    scrollTop: 300,
    innerHTML: '',
    appendChild(node) {
      if (node && Array.isArray(node.children)) {
        renderedNodes.push(...node.children);
      }
    },
    querySelectorAll(selector) {
      if (selector === '.message') {
        return renderedNodes;
      }
      return [];
    },
    querySelector(selector) {
      const keyMatch = /\.message\[data-message-key="([^"]+)"\]/.exec(selector);
      if (!keyMatch) return null;
      return renderedNodes.find((node) => String(node?.dataset?.messageKey || '') === keyMatch[1]) || null;
    },
  };
  const controller = renderTraceHistoryHelpers.createHistoryRenderController({
    messagesEl,
    jumpLatestButton: { hidden: true },
    jumpLastStartButton: { hidden: true },
    histories,
    virtualizationRanges: new Map(),
    virtualMetrics: new Map(),
    renderedHistoryLength,
    renderedHistoryVirtualized,
    unseenStreamChats,
    chatScrollTop,
    chatStickToBottom,
    getActiveChatId: () => 7,
    getRenderedChatId: () => 7,
    setRenderedChatId: () => {},
    refreshTabNode: (chatId) => unreadRefreshes.push(Number(chatId)),
    syncActiveViewportReadState: (chatId, options = {}) => {
      delegatedReadState.push([Number(chatId), { atBottom: options.atBottom }]);
      options.onViewportBottom?.(Number(chatId));
      return true;
    },
    clearSelectionQuoteStateFn: () => {},
    syncLiveToolStreamForChatFn: () => {},
    appendMessagesFn: (fragment, messages, options = {}) => {
      messages.forEach((message, offset) => {
        const index = Number(options.startIndex || 0) + offset;
        fragment.children.push({
          dataset: { messageKey: renderTraceMessageHelpers.messageStableKey(message, index) },
          offsetTop: 300 + (index - 1) * 300,
          offsetHeight: 300,
        });
      });
      messagesEl.scrollHeight = 900;
    },
    shouldUseAppendOnlyRenderFn: () => true,
    renderTraceLogFn: () => {},
    createFragmentFn: () => ({ children: [] }),
  });

  controller.renderMessages(7, { preserveViewport: true });

  assert.equal(messagesEl.scrollTop, 300);
  assert.equal(chatScrollTop.get(7), 300);
  assert.equal(chatStickToBottom.get(7), false);
  assert.deepEqual(delegatedReadState, []);
  assert.equal(unseenStreamChats.has(7), true);
  assert.deepEqual(unreadRefreshes, []);
});

test('createHistoryRenderController renderMessages delegates at-bottom unseen clearing to read-state authority when available', () => {
  const histories = new Map([[7, [
    { id: 1, role: 'assistant', body: 'done', created_at: '2026-04-08T08:00:02Z' },
  ]]]);
  const unseen = new Set([7]);
  const delegated = [];
  const refreshed = [];
  const messagesEl = {
    scrollHeight: 1000,
    clientHeight: 400,
    scrollTop: 600,
    innerHTML: '',
    appendChild(node) {
      return node;
    },
    querySelectorAll() {
      return [];
    },
  };
  const controller = renderTraceHistoryHelpers.createHistoryRenderController({
    messagesEl,
    jumpLatestButton: { hidden: true },
    jumpLastStartButton: { hidden: true },
    histories,
    virtualizationRanges: new Map(),
    virtualMetrics: new Map(),
    renderedHistoryLength: new Map(),
    renderedHistoryVirtualized: new Map(),
    unseenStreamChats: unseen,
    chatScrollTop: new Map(),
    chatStickToBottom: new Map(),
    getActiveChatId: () => 7,
    getRenderedChatId: () => 7,
    setRenderedChatId: () => {},
    refreshTabNode: (chatId) => refreshed.push(Number(chatId)),
    syncActiveViewportReadState: (chatId, options = {}) => {
      delegated.push([Number(chatId), { atBottom: options.atBottom, hasCallback: typeof options.onViewportBottom === 'function' }]);
      unseen.delete(Number(chatId));
      options.onViewportBottom?.(Number(chatId));
      return true;
    },
    clearSelectionQuoteStateFn: () => {},
    syncLiveToolStreamForChatFn: () => {},
    appendMessagesFn: () => {},
    shouldUseAppendOnlyRenderFn: () => false,
    renderTraceLogFn: () => {},
    createFragmentFn: () => ({ children: [] }),
  });

  controller.renderMessages(7, { forceBottom: true });

  assert.deepEqual(delegated, [[7, { atBottom: true, hasCallback: true }]]);
  assert.equal(unseen.has(7), false);
  assert.deepEqual(refreshed, [7]);
});

function createAnchoredMessageNode(messageKey, offsetTop, offsetHeight = 100) {
  return { dataset: { messageKey }, offsetTop, offsetHeight };
}

function createAnchoredMessagesHarness(initialNodes = []) {
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
    get() { return nodes.length ? '[messages]' : ''; },
    set(value) { if (value === '') nodes = []; },
  });
  return { messagesEl };
}

test('createHistoryRenderController preserves anchored viewport when rerender shifts message offsets', () => {
  const harness = createAnchoredMessagesHarness([
    createAnchoredMessageNode('1', 0, 100),
    createAnchoredMessageNode('2', 100, 100),
    createAnchoredMessageNode('3', 200, 100),
  ]);
  const { messagesEl } = harness;
  messagesEl.scrollTop = 150;
  messagesEl.scrollHeight = 600;
  messagesEl.clientHeight = 200;

  const histories = new Map([[
    7,
    [
      { id: 1, role: 'operator', body: 'a' },
      { id: 2, role: 'assistant', body: 'b' },
      { id: 3, role: 'assistant', body: 'c' },
    ],
  ]]);
  const renderNodes = [
    createAnchoredMessageNode('1', 0, 150),
    createAnchoredMessageNode('2', 150, 100),
    createAnchoredMessageNode('3', 250, 100),
  ];
  let renderedChatId = 7;

  const controller = renderTraceHistoryHelpers.createHistoryRenderController({
    messagesEl,
    jumpLatestButton: { hidden: true },
    jumpLastStartButton: { hidden: true },
    histories,
    virtualizationRanges: new Map(),
    virtualMetrics: new Map(),
    renderedHistoryLength: new Map([[7, 3]]),
    renderedHistoryVirtualized: new Map([[7, false]]),
    unseenStreamChats: new Set(),
    chatScrollTop: new Map(),
    chatStickToBottom: new Map(),
    historyCountEl: { textContent: '' },
    getActiveChatId: () => 7,
    getRenderedChatId: () => renderedChatId,
    setRenderedChatId: (value) => {
      renderedChatId = value;
    },
    refreshTabNode: () => {},
    clearSelectionQuoteStateFn: () => {},
    syncLiveToolStreamForChatFn: () => {},
    appendMessagesFn: (fragment, history) => {
      fragment.children.push(...renderNodes.slice(0, history.length));
      messagesEl.scrollHeight = 650;
    },
    shouldUseAppendOnlyRenderFn: () => false,
    renderTraceLogFn: () => {},
    createFragmentFn: () => ({ children: [] }),
  });

  controller.renderMessages(7, { preserveViewport: true });

  assert.equal(messagesEl.scrollTop, 200);
});
