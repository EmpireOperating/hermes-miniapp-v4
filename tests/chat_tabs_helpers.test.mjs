import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const chatTabsHelpers = require('../static/chat_tabs_helpers.js');

function makeClassList() {
  const values = new Set();
  return {
    add(...names) {
      names.forEach((name) => values.add(name));
    },
    remove(...names) {
      names.forEach((name) => values.delete(name));
    },
    toggle(name, enabled) {
      if (enabled) values.add(name);
      else values.delete(name);
    },
    has(name) {
      return values.has(name);
    },
  };
}

function makeElement(tagName = 'div') {
  const attrs = new Map();
  const listeners = new Map();
  const children = [];
  const element = {
    tagName: String(tagName || 'div').toUpperCase(),
    hidden: false,
    textContent: '',
    classList: makeClassList(),
    dataset: {},
    children,
    parentElement: null,
    appendChild(child) {
      if (!child) return child;
      child.parentElement = element;
      children.push(child);
      return child;
    },
    append(...items) {
      items.forEach((item) => {
        if (item && typeof item === 'object') {
          element.appendChild(item);
        }
      });
    },
    replaceChildren(...items) {
      children.splice(0, children.length);
      items.forEach((item) => {
        if (item && typeof item === 'object') {
          item.parentElement = element;
          children.push(item);
        }
      });
    },
    addEventListener(type, listener) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(listener);
    },
    dispatchEvent(event) {
      const nextEvent = event || {};
      if (!nextEvent.target) {
        nextEvent.target = element;
      }
      for (const listener of listeners.get(nextEvent.type) || []) {
        listener(nextEvent);
      }
    },
    setAttribute(name, value) {
      attrs.set(name, String(value));
    },
    getAttribute(name) {
      return attrs.get(name);
    },
  };
  return element;
}

function createFakeDocument() {
  return {
    createElement(tagName) {
      return makeElement(tagName);
    },
  };
}

function createHarness({
  activeChatId = 7,
  now = 1000,
  mobileTabCarouselEnabled = false,
  mobileViewport = false,
  getCurrentUnreadCount = null,
} = {}) {
  let activeChatIdValue = activeChatId;
  let nowValue = now;
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
  const resumeCycleCountByChat = new Map();

  const clearCalls = [];
  const renderPinnedChatsCalls = [];
  const localStorageWrites = [];

  const pinnedChatsWrap = makeElement();
  const pinnedChatsEl = makeElement();
  const pinnedChatsCountEl = makeElement();
  const pinnedChatsToggleButton = makeElement();
  const pinChatButton = makeElement();
  const tabsEl = makeElement();
  const hiddenUnreadLeftEl = makeElement();
  const hiddenUnreadRightEl = makeElement();
  const hiddenUnreadSummaryEl = makeElement();
  const tabOverviewEl = makeElement();
  const openedChats = [];
  const documentObject = createFakeDocument();

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
    tabsEl,
    hiddenUnreadLeftEl,
    hiddenUnreadRightEl,
    hiddenUnreadSummaryEl,
    tabOverviewEl,
    mobileTabCarouselEnabled,
    getIsMobileCarouselViewport: () => mobileViewport,
    getCurrentUnreadCount,
    openChat: async (chatId) => {
      openedChats.push(Number(chatId));
    },
    clearChatStreamState: (payload) => clearCalls.push(payload),
    chatUiHelpers: {
      renderTabs() {},
      refreshTabNode() {},
      syncActiveTabSelection({ previousChatId, nextChatId, tabNodes: nextTabNodes, renderTabs, refreshTabNode }) {
        const prevKey = Number(previousChatId);
        const nextKey = Number(nextChatId);
        const hasPrevNode = !prevKey || nextTabNodes.has(prevKey);
        const hasNextNode = !!nextKey && nextTabNodes.has(nextKey);
        if (!hasPrevNode || !hasNextNode) {
          renderTabs?.();
          return;
        }
        refreshTabNode?.(prevKey);
        refreshTabNode?.(nextKey);
      },
      renderPinnedChats(payload) {
        renderPinnedChatsCalls.push(payload);
      },
    },
    pinnedChatsWrap,
    pinnedChatsEl,
    pinnedChatsCountEl,
    pinnedChatsToggleButton,
    pinChatButton,
    documentObject,
    getActiveChatId: () => activeChatIdValue,
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
    resumeCycleCountByChat,
    maxAutoResumeCyclesPerChat: 6,
    nowFn: () => nowValue,
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
    resumeCycleCountByChat,
    clearCalls,
    renderPinnedChatsCalls,
    localStorageWrites,
    tabsEl,
    hiddenUnreadLeftEl,
    hiddenUnreadRightEl,
    hiddenUnreadSummaryEl,
    tabOverviewEl,
    openedChats,
    setActiveChatIdForTests: (value) => {
      activeChatIdValue = value == null ? null : Number(value);
    },
    setNowForTests: (value) => {
      nowValue = Number(value);
    },
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
});

test('reconnect resume helpers track budget and blocked chat pending state inside chat tabs controller', () => {
  const h = createHarness();
  h.pendingChats.add(11);
  h.chats.set(11, { id: 11, pending: true, unread_count: 2 });

  assert.deepEqual(h.controller.consumeReconnectResumeBudget(11), {
    allowed: true,
    attempts: 1,
    maxAttempts: 6,
  });
  assert.deepEqual(h.controller.consumeReconnectResumeBudget(11), {
    allowed: true,
    attempts: 2,
    maxAttempts: 6,
  });
  h.controller.blockReconnectResume(11);
  assert.equal(h.controller.isReconnectResumeBlocked(11), true);
  assert.equal(h.pendingChats.has(11), false);
  assert.equal(h.chats.get(11).pending, false);

  h.controller.clearReconnectResumeBlock(11);
  h.controller.resetReconnectResumeBudget(11);
  assert.equal(h.controller.isReconnectResumeBlocked(11), false);
  assert.equal(h.resumeCycleCountByChat.has(11), false);
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
  assert.equal(h.chats.get(11).pending, false);
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

test('renderTabs enables mobile carousel overview strip when feature flag is active on mobile viewport', () => {
  const h = createHarness({ activeChatId: 2, mobileTabCarouselEnabled: true, mobileViewport: true });
  h.tabOverviewEl.clientWidth = 240;
  h.tabOverviewEl.scrollWidth = 180;
  const centeredCalls = [];
  h.tabNodes.set(1, { scrollIntoView() { centeredCalls.push(1); }, classList: makeClassList(), querySelector() { return null; } });
  h.tabNodes.set(2, { scrollIntoView(options) { centeredCalls.push(options); }, classList: makeClassList(), querySelector() { return null; } });
  h.tabNodes.set(3, { scrollIntoView() { centeredCalls.push(3); }, classList: makeClassList(), querySelector() { return null; } });
  h.tabNodes.set(4, { scrollIntoView() { centeredCalls.push(4); }, classList: makeClassList(), querySelector() { return null; } });
  h.tabNodes.set(5, { scrollIntoView() { centeredCalls.push(5); }, classList: makeClassList(), querySelector() { return null; } });

  h.chats.set(1, { id: 1, unread_count: 1, pending: false, is_pinned: false, title: 'One' });
  h.chats.set(2, { id: 2, unread_count: 0, pending: false, is_pinned: false, title: 'Two' });
  h.chats.set(3, { id: 3, unread_count: 1, pending: true, is_pinned: false, title: 'Three' });
  h.chats.set(4, { id: 4, unread_count: 2, pending: false, is_pinned: false, title: 'Four' });
  h.chats.set(5, { id: 5, unread_count: 0, pending: false, is_pinned: false, title: 'Five' });

  h.controller.renderTabs();

  assert.equal(h.tabsEl.classList.has('chat-tabs--mobile-carousel'), true);
  assert.equal(h.hiddenUnreadLeftEl.hidden, true);
  assert.equal(h.hiddenUnreadLeftEl.textContent, '');
  assert.equal(h.hiddenUnreadRightEl.hidden, true);
  assert.equal(h.hiddenUnreadRightEl.textContent, '');
  assert.equal(h.hiddenUnreadSummaryEl.hidden, true);
  assert.equal(h.hiddenUnreadSummaryEl.textContent, '');
  assert.equal(h.tabOverviewEl.hidden, false);
  assert.equal(h.tabOverviewEl.children.length, 5);
  assert.equal(h.tabOverviewEl.children[0].dataset.chatId, '1');
  assert.equal(h.tabOverviewEl.children[0].dataset.state, 'unread');
  assert.equal(h.tabOverviewEl.children[1].dataset.chatId, '2');
  assert.equal(h.tabOverviewEl.children[1].dataset.active, 'true');
  assert.equal(h.tabOverviewEl.children[1].dataset.state, 'idle');
  assert.equal(h.tabOverviewEl.children[1].children[0].textContent, '•');
  assert.equal(h.tabOverviewEl.children[2].dataset.state, 'working');
  assert.equal(h.tabOverviewEl.children[3].dataset.state, 'unread');
  assert.equal(h.tabOverviewEl.children[4].dataset.state, 'idle');
  assert.equal(h.tabOverviewEl.classList.has('chat-tabs__overview--centered'), true);
  assert.deepEqual(centeredCalls, [{ block: 'nearest', inline: 'center' }]);
});

test('manual carousel interaction does not get recentered by later background rerenders', () => {
  const h = createHarness({ activeChatId: 2, mobileTabCarouselEnabled: true, mobileViewport: true, now: 1000 });
  const centeredCalls = [];
  h.tabNodes.set(2, {
    scrollIntoView(options) {
      centeredCalls.push(options);
    },
    classList: makeClassList(),
    querySelector() { return null; },
  });
  h.chats.set(1, { id: 1, unread_count: 0, pending: false, is_pinned: false, title: 'One' });
  h.chats.set(2, { id: 2, unread_count: 0, pending: false, is_pinned: false, title: 'Two' });
  h.chats.set(3, { id: 3, unread_count: 1, pending: false, is_pinned: false, title: 'Three' });

  h.controller.renderTabs();
  h.controller.noteMobileCarouselInteraction();
  h.setNowForTests(1400);
  h.controller.renderTabs();
  h.setNowForTests(5505);
  h.controller.renderTabs();

  assert.deepEqual(centeredCalls, [
    { block: 'nearest', inline: 'center' },
  ]);
});

test('manual carousel browsing does not get force-centered when active tab selection is re-synced to the same chat', () => {
  const h = createHarness({ activeChatId: 2, mobileTabCarouselEnabled: true, mobileViewport: true, now: 1000 });
  const centeredCalls = [];
  h.tabNodes.set(2, {
    scrollIntoView(options) {
      centeredCalls.push(['chat-2', options]);
    },
    classList: makeClassList(),
    querySelector() { return null; },
  });
  h.chats.set(2, { id: 2, unread_count: 0, pending: false, is_pinned: false, title: 'Two' });

  h.controller.renderTabs();
  h.controller.noteMobileCarouselInteraction();
  h.setNowForTests(2200);
  h.controller.syncActiveTabSelection(2, 2);

  assert.deepEqual(centeredCalls, [
    ['chat-2', { block: 'nearest', inline: 'center' }],
  ]);
});

test('manual carousel browsing clears after active tab changes so next active tab can center', () => {
  const h = createHarness({ activeChatId: 2, mobileTabCarouselEnabled: true, mobileViewport: true, now: 1000 });
  const centeredCalls = [];
  h.tabNodes.set(2, {
    scrollIntoView(options) {
      centeredCalls.push(['chat-2', options]);
    },
    classList: makeClassList(),
    querySelector() { return null; },
  });
  h.tabNodes.set(4, {
    scrollIntoView(options) {
      centeredCalls.push(['chat-4', options]);
    },
    classList: makeClassList(),
    querySelector() { return null; },
  });
  h.chats.set(2, { id: 2, unread_count: 0, pending: false, is_pinned: false, title: 'Two' });
  h.chats.set(4, { id: 4, unread_count: 0, pending: false, is_pinned: false, title: 'Four' });

  h.controller.renderTabs();
  h.controller.noteMobileCarouselInteraction();
  h.setActiveChatIdForTests(4);
  h.controller.syncActiveTabSelection(2, 4);

  assert.deepEqual(centeredCalls, [
    ['chat-2', { block: 'nearest', inline: 'center' }],
    ['chat-4', { block: 'nearest', inline: 'center' }],
  ]);
});

test('mobile carousel overview strip updates marker state without relying on hidden unread summary text', () => {
  const effectiveUnreadByChat = new Map([[1, 3], [3, 0], [5, 2]]);
  const h = createHarness({
    activeChatId: 3,
    mobileTabCarouselEnabled: true,
    mobileViewport: true,
    getCurrentUnreadCount: (chatId) => effectiveUnreadByChat.get(Number(chatId)) ?? 0,
  });
  h.chats.set(1, { id: 1, unread_count: 3, pending: false, is_pinned: false, title: 'One' });
  h.chats.set(2, { id: 2, unread_count: 0, pending: true, is_pinned: false, title: 'Two' });
  h.chats.set(3, { id: 3, unread_count: 0, pending: false, is_pinned: false, title: 'Three' });
  h.chats.set(4, { id: 4, unread_count: 0, pending: false, is_pinned: false, title: 'Four' });
  h.chats.set(5, { id: 5, unread_count: 2, pending: false, is_pinned: false, title: 'Five' });

  h.controller.renderTabs();
  assert.equal(h.hiddenUnreadLeftEl.hidden, true);
  assert.equal(h.hiddenUnreadRightEl.hidden, true);
  assert.equal(h.hiddenUnreadSummaryEl.hidden, true);
  assert.deepEqual(
    h.tabOverviewEl.children.map((child) => child.dataset.state),
    ['unread', 'working', 'idle', 'idle', 'unread'],
  );
  assert.equal(h.tabOverviewEl.children[2].children[0].textContent, '•');

  h.chats.get(1).unread_count = 0;
  effectiveUnreadByChat.set(1, 0);
  h.controller.refreshTabNode(1);
  assert.deepEqual(
    h.tabOverviewEl.children.map((child) => child.dataset.state),
    ['idle', 'working', 'idle', 'idle', 'unread'],
  );
  assert.equal(h.tabOverviewEl.children[2].children[0].textContent, '•');

  h.chats.get(5).unread_count = 0;
  effectiveUnreadByChat.set(5, 0);
  h.controller.refreshTabNode(5);
  assert.deepEqual(
    h.tabOverviewEl.children.map((child) => child.dataset.state),
    ['idle', 'working', 'idle', 'idle', 'idle'],
  );
  assert.equal(h.tabOverviewEl.children[2].children[0].textContent, '•');
});

test('mobile carousel overview markers keep idle active chats dot-only and can jump directly to a non-active chat', async () => {
  const effectiveUnreadByChat = new Map([[1, 1], [2, 0], [3, 2]]);
  const h = createHarness({
    activeChatId: 2,
    mobileTabCarouselEnabled: true,
    mobileViewport: true,
    getCurrentUnreadCount: (chatId) => effectiveUnreadByChat.get(Number(chatId)) ?? 0,
  });
  h.chats.set(1, { id: 1, unread_count: 1, pending: false, is_pinned: false, title: 'One' });
  h.chats.set(2, { id: 2, unread_count: 0, pending: false, is_pinned: false, title: 'Two' });
  h.chats.set(3, { id: 3, unread_count: 2, pending: false, is_pinned: false, title: 'Three' });

  h.controller.renderTabs();
  assert.equal(h.tabOverviewEl.children.length, 3);
  assert.equal(h.tabOverviewEl.children[1].children[0].textContent, '•');

  h.tabOverviewEl.children[1].dispatchEvent({ type: 'click' });
  h.tabOverviewEl.children[2].dispatchEvent({ type: 'click' });

  assert.deepEqual(h.openedChats, [3]);
});

test('mobile carousel overview markers keep showing unread counts for active unread chats and fall back to 1 for unread-activity badges without a count', () => {
  const effectiveUnreadByChat = new Map([[1, 0], [2, 4], [3, 0]]);
  const h = createHarness({
    activeChatId: 2,
    mobileTabCarouselEnabled: true,
    mobileViewport: true,
    getCurrentUnreadCount: (chatId) => effectiveUnreadByChat.get(Number(chatId)) ?? 0,
  });
  h.chats.set(1, { id: 1, unread_count: 0, pending: false, is_pinned: false, title: 'One' });
  h.chats.set(2, { id: 2, unread_count: 4, pending: false, is_pinned: false, title: 'Two' });
  h.chats.set(3, { id: 3, unread_count: 0, pending: false, is_pinned: false, title: 'Three' });
  h.unseenStreamChats.add(1);

  h.controller.renderTabs();

  assert.equal(h.tabOverviewEl.children[0].dataset.state, 'unread');
  assert.equal(h.tabOverviewEl.children[0].children[0].textContent, '1');
  assert.equal(h.tabOverviewEl.children[1].dataset.active, 'true');
  assert.equal(h.tabOverviewEl.children[1].dataset.state, 'unread');
  assert.equal(h.tabOverviewEl.children[1].children[0].textContent, '4');
});

test('renderTabs leaves carousel disabled outside flagged mobile mode', () => {
  const h = createHarness({ activeChatId: 2, mobileTabCarouselEnabled: false, mobileViewport: true });
  h.chats.set(1, { id: 1, unread_count: 1, pending: false, is_pinned: false, title: 'One' });
  h.chats.set(2, { id: 2, unread_count: 0, pending: false, is_pinned: false, title: 'Two' });
  h.chats.set(3, { id: 3, unread_count: 1, pending: false, is_pinned: false, title: 'Three' });

  h.controller.renderTabs();

  assert.equal(h.tabsEl.classList.has('chat-tabs--mobile-carousel'), false);
  assert.equal(h.hiddenUnreadLeftEl.hidden, true);
  assert.equal(h.hiddenUnreadRightEl.hidden, true);
  assert.equal(h.hiddenUnreadSummaryEl.hidden, true);
  assert.equal(h.hiddenUnreadSummaryEl.textContent, '');
  assert.equal(h.tabOverviewEl.hidden, true);
  assert.equal(h.tabOverviewEl.children.length, 0);
});
