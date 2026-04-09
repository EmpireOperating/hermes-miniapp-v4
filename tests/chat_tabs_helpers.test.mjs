import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const chatTabsHelpers = require('../static/chat_tabs_helpers.js');

function makeClassList() {
  const values = new Set();
  return {
    toggle(name, enabled) {
      if (enabled) values.add(name);
      else values.delete(name);
    },
    has(name) {
      return values.has(name);
    },
  };
}

function makeElement() {
  const attrs = new Map();
  return {
    hidden: false,
    textContent: '',
    classList: makeClassList(),
    setAttribute(name, value) {
      attrs.set(name, String(value));
    },
    getAttribute(name) {
      return attrs.get(name);
    },
  };
}

function createHarness({ activeChatId = 7, now = 1000 } = {}) {
  const chats = new Map();
  const pinnedChats = new Map();
  const histories = new Map();
  const pendingChats = new Set();
  const streamPhaseByChat = new Map();
  const unseenStreamChats = new Set();
  const prefetchingHistories = new Set();
  const chatScrollTop = new Map();
  const chatStickToBottom = new Map();
  const virtualizationRanges = new Map();
  const virtualMetrics = new Map();
  const renderedHistoryLength = new Map();
  const renderedHistoryVirtualized = new Map();
  const tabNodes = new Map();
  const resumeCooldownUntilByChat = new Map();
  const reconnectResumeBlockedChats = new Set();

  const clearCalls = [];
  const renderPinnedChatsCalls = [];
  const localStorageWrites = [];
  const suppressBlockedPendingCalls = [];

  const pinnedChatsWrap = makeElement();
  const pinnedChatsEl = makeElement();
  const pinnedChatsCountEl = makeElement();
  const pinnedChatsToggleButton = makeElement();
  const pinChatButton = makeElement();

  const localStorageRef = {
    getItem() {
      return null;
    },
    setItem(key, value) {
      localStorageWrites.push([key, value]);
    },
  };

  let pinnedChatsCollapsed = false;
  let hasPreference = false;

  const controller = chatTabsHelpers.createController({
    localStorageRef,
    pinnedChatsCollapsedStorageKey: 'miniapp.pinnedChatsCollapsed',
    pinnedChatsAutoCollapseThreshold: 2,
    chats,
    pinnedChats,
    histories,
    pendingChats,
    streamPhaseByChat,
    unseenStreamChats,
    prefetchingHistories,
    chatScrollTop,
    chatStickToBottom,
    virtualizationRanges,
    virtualMetrics,
    renderedHistoryLength,
    renderedHistoryVirtualized,
    tabNodes,
    clearChatStreamState: (payload) => clearCalls.push(payload),
    chatUiHelpers: {
      renderPinnedChats(payload) {
        renderPinnedChatsCalls.push(payload);
      },
    },
    pinnedChatsWrap,
    pinnedChatsEl,
    pinnedChatsCountEl,
    pinnedChatsToggleButton,
    pinChatButton,
    documentObject: {},
    getActiveChatId: () => activeChatId,
    getPinnedChatsCollapsed: () => pinnedChatsCollapsed,
    setPinnedChatsCollapsedState: (value) => {
      pinnedChatsCollapsed = Boolean(value);
    },
    getHasPinnedChatsCollapsePreference: () => hasPreference,
    setHasPinnedChatsCollapsePreference: (value) => {
      hasPreference = Boolean(value);
    },
    resumeCooldownUntilByChat,
    reconnectResumeBlockedChats,
    suppressBlockedChatPending: (chatId) => suppressBlockedPendingCalls.push(Number(chatId)),
    nowFn: () => now,
  });

  return {
    controller,
    chats,
    pinnedChats,
    histories,
    pendingChats,
    streamPhaseByChat,
    unseenStreamChats,
    prefetchingHistories,
    chatScrollTop,
    chatStickToBottom,
    virtualizationRanges,
    virtualMetrics,
    renderedHistoryLength,
    renderedHistoryVirtualized,
    tabNodes,
    resumeCooldownUntilByChat,
    reconnectResumeBlockedChats,
    clearCalls,
    renderPinnedChatsCalls,
    localStorageWrites,
    suppressBlockedPendingCalls,
    pinnedChatsWrap,
    pinnedChatsEl,
    pinnedChatsCountEl,
    pinnedChatsToggleButton,
    pinChatButton,
    getPinnedChatsCollapsed: () => pinnedChatsCollapsed,
    getHasPreference: () => hasPreference,
  };
}

test('syncPinnedChats normalizes values and enforces pinned state', () => {
  const h = createHarness();

  h.controller.syncPinnedChats([
    { id: '4', pending: 0, unread_count: '3', is_pinned: false },
    { id: 0, is_pinned: true },
  ]);

  assert.equal(h.pinnedChats.size, 1);
  assert.equal(h.pinnedChats.get(4).is_pinned, true);
  assert.equal(h.pinnedChats.get(4).unread_count, 3);
  assert.equal(h.pinnedChats.get(4).pending, false);
});

test('syncChats removes stale chat state and upserts next chats', () => {
  const h = createHarness();

  h.chats.set(1, { id: 1, is_pinned: false });
  h.histories.set(1, [{ id: 'm1' }]);
  h.pendingChats.add(1);
  h.streamPhaseByChat.set(1, 'streaming');
  h.unseenStreamChats.add(1);
  h.prefetchingHistories.add(1);
  h.chatScrollTop.set(1, 15);
  h.chatStickToBottom.set(1, false);
  h.virtualizationRanges.set(1, { start: 0, end: 1 });
  h.virtualMetrics.set(1, { top: 22 });
  h.renderedHistoryLength.set(1, 4);
  h.renderedHistoryVirtualized.set(1, true);
  h.tabNodes.set(1, { removed: false, remove() { this.removed = true; } });

  h.controller.syncChats([{ id: 2, is_pinned: true, unread_count: '2', pending: 1 }]);

  assert.equal(h.chats.has(1), false);
  assert.equal(h.histories.has(1), false);
  assert.equal(h.prefetchingHistories.has(1), false);
  assert.equal(h.chatScrollTop.has(1), false);
  assert.equal(h.chatStickToBottom.has(1), false);
  assert.equal(h.virtualizationRanges.has(1), false);
  assert.equal(h.virtualMetrics.has(1), false);
  assert.equal(h.renderedHistoryLength.has(1), false);
  assert.equal(h.renderedHistoryVirtualized.has(1), false);
  assert.equal(h.tabNodes.has(1), false);
  assert.equal(h.clearCalls.length, 1);
  assert.equal(h.clearCalls[0].chatId, 1);

  assert.equal(h.chats.get(2).pending, true);
  assert.equal(h.pinnedChats.get(2).is_pinned, true);
});

test('upsertChat suppresses pending during resume cooldown and blocked reconnect state', () => {
  const h = createHarness({ now: 1500 });
  h.resumeCooldownUntilByChat.set(9, 2000);
  h.reconnectResumeBlockedChats.add(9);

  const next = h.controller.upsertChat({ id: 9, pending: true, unread_count: 0, is_pinned: false });

  assert.equal(next.pending, false);
  assert.equal(h.chats.get(9).pending, false);
  assert.deepEqual(h.suppressBlockedPendingCalls, [9]);
});

test('setPinnedChatsCollapsed updates UI and persists preference when requested', () => {
  const h = createHarness();
  h.pinnedChats.set(9, { id: 9, is_pinned: true });

  h.controller.setPinnedChatsCollapsed(true);

  assert.equal(h.getPinnedChatsCollapsed(), true);
  assert.equal(h.getHasPreference(), true);
  assert.deepEqual(h.localStorageWrites, [['miniapp.pinnedChatsCollapsed', '1']]);
  assert.equal(h.pinnedChatsToggleButton.hidden, false);
  assert.equal(h.pinnedChatsEl.hidden, true);
  assert.equal(h.pinnedChatsWrap.classList.has('is-collapsed'), true);
  assert.equal(h.pinnedChatsToggleButton.getAttribute('aria-expanded'), 'false');
  assert.equal(h.pinnedChatsToggleButton.textContent, 'Show');
  assert.equal(h.pinnedChatsCountEl.textContent, '(1)');
});

test('maybeAutoCollapsePinnedChats only applies before user preference exists', () => {
  const h = createHarness();
  h.pinnedChats.set(1, { id: 1, is_pinned: true });
  h.pinnedChats.set(2, { id: 2, is_pinned: true });

  h.controller.maybeAutoCollapsePinnedChats();
  assert.equal(h.getPinnedChatsCollapsed(), true);
  assert.equal(h.localStorageWrites.length, 0);

  h.controller.setPinnedChatsCollapsed(false);
  h.controller.maybeAutoCollapsePinnedChats();
  assert.equal(h.getPinnedChatsCollapsed(), false);
});

test('renderPinnedChats delegates to chat ui helper and refreshes collapse UI', () => {
  const h = createHarness();
  h.pinnedChats.set(5, { id: 5, is_pinned: true });

  h.controller.renderPinnedChats();

  assert.equal(h.renderPinnedChatsCalls.length, 1);
  assert.equal(h.renderPinnedChatsCalls[0].pinnedChats, h.pinnedChats);
  assert.equal(h.pinnedChatsToggleButton.hidden, false);
  assert.equal(h.pinnedChatsCountEl.textContent, '(1)');
});

test('syncChats reapplies cooldown suppression after syncing server chats', () => {
  const h = createHarness({ now: 1500 });
  h.resumeCooldownUntilByChat.set(7, 1800);
  h.reconnectResumeBlockedChats.add(11);

  const next = h.controller.syncChats([
    { id: 7, pending: true, unread_count: 0, is_pinned: false },
    { id: 11, pending: true, unread_count: 0, is_pinned: false },
  ]);

  assert.equal(Array.isArray(next), true);
  assert.equal(h.chats.get(7).pending, false);
  assert.equal(h.chats.get(11).pending, true);
  assert.deepEqual(h.suppressBlockedPendingCalls, [7, 11, 11]);
});

test('syncPinChatButton reflects active chat pin state', () => {
  const h = createHarness({ activeChatId: 12 });

  h.chats.set(12, { id: 12, is_pinned: true });
  h.controller.syncPinChatButton();
  assert.equal(h.pinChatButton.textContent, 'Unpin chat');

  h.chats.set(12, { id: 12, is_pinned: false });
  h.controller.syncPinChatButton();
  assert.equal(h.pinChatButton.textContent, 'Pin chat');
});
