import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const keyboard = require('../static/keyboard_shortcuts_helpers.js');

test('getOrderedChatIds normalizes and sorts valid positive chat ids', () => {
  const chats = new Map([
    [9, { id: '9' }],
    [4, { id: 4 }],
    [0, { id: 0 }],
    [7, { id: '7' }],
    [13, { id: 'not-a-number' }],
  ]);

  assert.deepEqual(keyboard.getOrderedChatIds(chats), [4, 7, 9]);
});

test('handleGlobalTabCycle opens next chat for desktop ArrowRight', () => {
  const opened = [];
  let prevented = false;
  const event = {
    defaultPrevented: false,
    isComposing: false,
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    key: 'ArrowRight',
    target: { id: 'outside-input' },
    preventDefault: () => {
      prevented = true;
    },
  };

  keyboard.handleGlobalTabCycle(event, {
    mobileQuoteMode: false,
    isDesktopViewportFn: () => true,
    settingsModal: null,
    isTextEntryElementFn: () => false,
    activeChatId: 4,
    chats: new Map([
      [2, { id: 2 }],
      [4, { id: 4 }],
      [8, { id: 8 }],
    ]),
    getNextChatTabId: ({ orderedChatIds, activeChatId }) => {
      assert.deepEqual(orderedChatIds, [2, 4, 8]);
      assert.equal(activeChatId, 4);
      return 8;
    },
    openChat: (chatId) => {
      opened.push(chatId);
    },
  });

  assert.equal(prevented, true);
  assert.deepEqual(opened, [8]);
});

test('handleGlobalArrowJump dispatches shift jump action and plain scroll action', () => {
  const calls = [];
  const makeEvent = (key, shiftKey = false) => ({
    defaultPrevented: false,
    isComposing: false,
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    key,
    shiftKey,
    target: {},
    preventDefault: () => calls.push(`prevent:${key}:${shiftKey}`),
  });

  keyboard.handleGlobalArrowJump(makeEvent('ArrowDown', true), {
    mobileQuoteMode: false,
    isDesktopViewportFn: () => true,
    settingsModal: null,
    isTextEntryElementFn: () => false,
    jumpLatestButton: { hidden: false },
    jumpLastStartButton: { hidden: false },
    handleJumpLatest: () => calls.push('jump-latest'),
    handleJumpLastStart: () => calls.push('jump-last-start'),
    scrollMessages: (direction) => calls.push(`scroll:${direction}`),
  });

  keyboard.handleGlobalArrowJump(makeEvent('ArrowUp', false), {
    mobileQuoteMode: false,
    isDesktopViewportFn: () => true,
    settingsModal: null,
    isTextEntryElementFn: () => false,
    jumpLatestButton: { hidden: false },
    jumpLastStartButton: { hidden: false },
    handleJumpLatest: () => calls.push('jump-latest'),
    handleJumpLastStart: () => calls.push('jump-last-start'),
    scrollMessages: (direction) => calls.push(`scroll:${direction}`),
  });

  assert.deepEqual(calls, [
    'prevent:ArrowDown:true',
    'jump-latest',
    'prevent:ArrowUp:false',
    'scroll:up',
  ]);
});

test('scrollMessagesByArrow uses bounded proportional step', () => {
  const messagesEl = {
    clientHeight: 1000,
    scrollTop: 10,
  };

  keyboard.scrollMessagesByArrow(messagesEl, 'down');
  assert.equal(messagesEl.scrollTop, 190);

  keyboard.scrollMessagesByArrow(messagesEl, 'up');
  assert.equal(messagesEl.scrollTop, 10);
});

test('handleTabClick ignores overflow trigger clicks', () => {
  const opened = [];
  const event = {
    target: {
      closest(selector) {
        if (selector === '[data-chat-tab-menu-trigger]') {
          return { dataset: { chatId: '5' } };
        }
        return null;
      },
    },
  };

  keyboard.handleTabClick(event, {
    activeChatId: 4,
    openChat: (chatId) => opened.push(chatId),
  });

  assert.deepEqual(opened, []);
});

test('handleTabClick opens selected chat when clicking a non-active tab', () => {
  const opened = [];
  const tab = { dataset: { chatId: '8' } };
  const event = {
    target: {
      closest(selector) {
        if (selector === '[data-chat-tab-menu-trigger]') return null;
        if (selector === '.chat-tab') return tab;
        return null;
      },
    },
  };

  keyboard.handleTabClick(event, {
    activeChatId: 4,
    openChat: (chatId) => opened.push(chatId),
  });

  assert.deepEqual(opened, [8]);
});
