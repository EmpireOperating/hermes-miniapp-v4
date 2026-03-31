import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const chatUi = require('../static/chat_ui_helpers.js');

test('getTabBadgeState prioritizes pending badge', () => {
  const badge = chatUi.getTabBadgeState({
    chat: { id: 5, pending: true, unread_count: 2 },
    pendingChats: new Set(),
    unseenStreamChats: new Set(),
  });

  assert.equal(badge.text, '…');
  assert.deepEqual(badge.classes, ['is-visible', 'is-pending']);
  assert.equal(badge.ariaLabel, 'Pending response');
});

test('getTabBadgeState emits unread dot when chat has unread', () => {
  const badge = chatUi.getTabBadgeState({
    chat: { id: 6, pending: false, unread_count: 3 },
    pendingChats: new Set(),
    unseenStreamChats: new Set(),
  });

  assert.equal(badge.text, '•');
  assert.deepEqual(badge.classes, ['is-visible', 'is-unread-dot']);
  assert.equal(badge.ariaLabel, '3 unread messages');
});

test('syncActiveTabSelection falls back to full render when missing tab node', () => {
  const tabNodes = new Map([[1, {}]]);
  let renderCalls = 0;
  const refreshed = [];

  chatUi.syncActiveTabSelection({
    previousChatId: 1,
    nextChatId: 2,
    tabNodes,
    renderTabs: () => {
      renderCalls += 1;
    },
    refreshTabNode: (id) => {
      refreshed.push(id);
    },
  });

  assert.equal(renderCalls, 1);
  assert.deepEqual(refreshed, []);
});

test('syncActiveTabSelection refreshes previous and next tabs when both exist', () => {
  const tabNodes = new Map([[1, {}], [2, {}]]);
  let renderCalls = 0;
  const refreshed = [];

  chatUi.syncActiveTabSelection({
    previousChatId: 1,
    nextChatId: 2,
    tabNodes,
    renderTabs: () => {
      renderCalls += 1;
    },
    refreshTabNode: (id) => {
      refreshed.push(id);
    },
  });

  assert.equal(renderCalls, 0);
  assert.deepEqual(refreshed, [1, 2]);
});

test('applyTabNodeState shows overflow trigger only on active tab', () => {
  const badge = {
    classList: { remove() {}, add() {} },
    removeAttribute() {},
    setAttribute() {},
    textContent: '',
  };
  const overflow = { hidden: true };
  const title = { textContent: '' };
  const pin = { textContent: '' };
  const node = {
    classList: { toggle() {} },
    setAttribute() {},
    querySelector(selector) {
      if (selector === '.chat-tab__badge') return badge;
      if (selector === '.chat-tab__title') return title;
      if (selector === '.chat-tab__pin') return pin;
      if (selector === '[data-chat-tab-menu-trigger]') return overflow;
      return null;
    },
  };

  chatUi.applyTabNodeState({
    node,
    chat: { id: 12, title: 'Alpha', is_pinned: false },
    activeChatId: 12,
    pendingChats: new Set(),
    unseenStreamChats: new Set(),
  });
  assert.equal(overflow.hidden, false);

  chatUi.applyTabNodeState({
    node,
    chat: { id: 12, title: 'Alpha', is_pinned: false },
    activeChatId: 7,
    pendingChats: new Set(),
    unseenStreamChats: new Set(),
  });
  assert.equal(overflow.hidden, true);
});
