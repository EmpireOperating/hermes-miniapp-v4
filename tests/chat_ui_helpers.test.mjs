import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const chatUi = require('../static/chat_ui_helpers.js');

test('getTabBadgeState prioritizes unread dot over pending when chat already has unread replies', () => {
  const badge = chatUi.getTabBadgeState({
    chat: { id: 5, pending: true, unread_count: 2 },
    pendingChats: new Set(),
    unseenStreamChats: new Set(),
  });

  assert.equal(badge.text, '•');
  assert.deepEqual(badge.classes, ['is-visible', 'is-unread-dot']);
  assert.equal(badge.ariaLabel, '2 unread messages');
});

test('getTabBadgeState keeps pending badge when chat is pending and has no unread or unseen reply', () => {
  const badge = chatUi.getTabBadgeState({
    chat: { id: 5, pending: true, unread_count: 0 },
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

test('applyTabNodeState shows overflow trigger only on active non-pending tab', () => {
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

  chatUi.applyTabNodeState({
    node,
    chat: { id: 12, title: 'Alpha', is_pinned: false, pending: true },
    activeChatId: 12,
    pendingChats: new Set(),
    unseenStreamChats: new Set(),
  });
  assert.equal(overflow.hidden, true);
});

test('createController reuses custom badge delegates and renders pinned chats from injected state', () => {
  const chats = new Map([[4, { id: 4, title: 'Delta', is_pinned: false }]]);
  const pinnedChats = new Map([[7, { id: 7, title: 'Pinned', is_pinned: true }]]);
  const pendingChats = new Set();
  const unseenStreamChats = new Set();
  const tabNodes = new Map();
  const appendedNodes = [];
  const tabsEl = {
    appendChild(node) {
      appendedNodes.push(node);
      node.parentElement = tabsEl;
    },
  };
  const pinnedAppendedNodes = [];
  const pinnedChatsEl = {
    replaced: false,
    replaceChildren() {
      this.replaced = true;
    },
    appendChild(node) {
      pinnedAppendedNodes.push(node);
    },
  };
  const pinnedChatsWrap = { hidden: false };
  const createdButtons = [];
  const documentObject = {
    createElement(tag) {
      const node = {
        tag,
        className: '',
        dataset: {},
        attributes: new Map(),
        textContent: '',
        title: '',
        append(...children) {
          this.children = children;
        },
        setAttribute(name, value) {
          this.attributes.set(name, String(value));
        },
      };
      createdButtons.push(node);
      return node;
    },
  };
  const badgeCalls = [];
  const applyBadgeCalls = [];
  const node = {
    dataset: {},
    parentElement: null,
    classList: { toggle() {} },
    setAttribute() {},
    querySelector(selector) {
      if (selector === '.chat-tab__badge') return { classList: { remove() {}, add() {} }, removeAttribute() {}, setAttribute() {}, textContent: '' };
      if (selector === '.chat-tab__title') return { textContent: '' };
      if (selector === '.chat-tab__pin') return { textContent: '' };
      if (selector === '[data-chat-tab-menu-trigger]') return { hidden: true };
      return null;
    },
  };
  const tabTemplate = {
    content: {
      firstElementChild: {
        cloneNode() {
          return node;
        },
      },
    },
  };

  const controller = chatUi.createController({
    chats,
    pinnedChats,
    pendingChats,
    unseenStreamChats,
    tabNodes,
    tabTemplate,
    tabsEl,
    pinnedChatsWrap,
    pinnedChatsEl,
    documentObject,
    getActiveChatId: () => 4,
    getTabBadgeState(chat) {
      badgeCalls.push(chat.id);
      return { text: '!', classes: ['is-visible'], ariaLabel: 'custom badge' };
    },
    applyTabBadgeState(badge, badgeState) {
      applyBadgeCalls.push({ badge, badgeState });
    },
  });

  controller.renderTabs();
  controller.renderPinnedChats();

  assert.equal(appendedNodes.length, 1);
  assert.deepEqual(badgeCalls, [4]);
  assert.equal(applyBadgeCalls.length, 1);
  assert.equal(pinnedChatsWrap.hidden, false);
  assert.equal(pinnedChatsEl.replaced, true);
  assert.equal(pinnedAppendedNodes.length, 1);
  assert.equal(createdButtons[0].dataset.chatId, '7');
});

test('createController syncActiveTabSelection only falls back to full render when a node is missing', () => {
  const chats = new Map([
    [1, { id: 1, title: 'One', is_pinned: false }],
    [2, { id: 2, title: 'Two', is_pinned: false }],
  ]);
  const tabNodes = new Map([
    [1, { classList: { toggle() {} }, setAttribute() {}, querySelector() { return null; } }],
    [2, { classList: { toggle() {} }, setAttribute() {}, querySelector() { return null; } }],
  ]);
  let cloneCalls = 0;
  const controller = chatUi.createController({
    chats,
    pinnedChats: new Map(),
    pendingChats: new Set(),
    unseenStreamChats: new Set(),
    tabNodes,
    tabTemplate: {
      content: {
        firstElementChild: {
          cloneNode() {
            cloneCalls += 1;
            return { dataset: {}, classList: { toggle() {} }, setAttribute() {}, querySelector() { return null; } };
          },
        },
      },
    },
    tabsEl: { appendChild() {} },
    pinnedChatsWrap: { hidden: true },
    pinnedChatsEl: { replaceChildren() {} },
    getActiveChatId: () => 2,
    getTabBadgeState() {
      return { text: '', classes: [], ariaLabel: '' };
    },
    applyTabBadgeState() {},
  });

  controller.syncActiveTabSelection(1, 2);
  assert.equal(cloneCalls, 0);

  tabNodes.delete(2);
  controller.syncActiveTabSelection(1, 2);
  assert.equal(cloneCalls, 1);
});
