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

test('handlePinnedChatClick ignores pinned overflow trigger clicks', () => {
  const opened = [];
  const event = {
    target: {
      closest(selector) {
        if (selector === '[data-pinned-chat-menu-trigger]') {
          return { dataset: { chatId: '11' } };
        }
        return null;
      },
    },
  };

  keyboard.handlePinnedChatClick(event, {
    activeChatId: 7,
    chats: new Map([[7, { id: 7 }]]),
    openPinnedChat: (chatId) => opened.push(chatId),
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

test('handleGlobalChatActionShortcut closes active chat on desktop Escape', () => {
  const calls = [];
  let prevented = false;
  keyboard.handleGlobalChatActionShortcut({
    defaultPrevented: false,
    isComposing: false,
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    repeat: false,
    key: 'Escape',
    code: 'Escape',
    target: {},
    preventDefault() {
      prevented = true;
    },
  }, {
    mobileQuoteMode: false,
    isDesktopViewportFn: () => true,
    documentObject: { querySelector: () => null },
    isTextEntryElementFn: () => false,
    activeChatId: 7,
    createChat: async () => calls.push('create'),
    removeActiveChat: async () => calls.push('remove'),
  });

  assert.equal(prevented, true);
  assert.deepEqual(calls, ['remove']);
});

test('handleGlobalChatActionShortcut opens new chat on desktop Backquote', () => {
  const calls = [];
  let prevented = false;
  keyboard.handleGlobalChatActionShortcut({
    defaultPrevented: false,
    isComposing: false,
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    repeat: false,
    key: '`',
    code: 'Backquote',
    target: {},
    preventDefault() {
      prevented = true;
    },
  }, {
    mobileQuoteMode: false,
    isDesktopViewportFn: () => true,
    documentObject: { querySelector: () => null },
    isTextEntryElementFn: () => false,
    activeChatId: 7,
    createChat: async () => calls.push('create'),
    removeActiveChat: async () => calls.push('remove'),
  });

  assert.equal(prevented, true);
  assert.deepEqual(calls, ['create']);
});

test('handleGlobalChatActionShortcut ignores editable targets, repeats, and open dialogs', () => {
  const calls = [];
  const run = (overrides = {}, options = {}) => {
    keyboard.handleGlobalChatActionShortcut({
      defaultPrevented: false,
      isComposing: false,
      altKey: false,
      ctrlKey: false,
      metaKey: false,
      shiftKey: false,
      repeat: false,
      key: 'Escape',
      code: 'Escape',
      target: {},
      preventDefault() {},
      ...overrides,
    }, {
      mobileQuoteMode: false,
      isDesktopViewportFn: () => true,
      documentObject: { querySelector: () => null },
      isTextEntryElementFn: () => false,
      activeChatId: 7,
      createChat: async () => calls.push('create'),
      removeActiveChat: async () => calls.push('remove'),
      ...options,
    });
  };

  run({ target: { id: 'input' } }, { isTextEntryElementFn: () => true });
  run({ repeat: true });
  run({}, { documentObject: { querySelector: () => ({ open: true }) } });

  assert.deepEqual(calls, []);
});

test('createController resolves active chat lazily for keyboard handlers', () => {
  let activeChatId = 4;
  const opened = [];
  const actions = [];
  const controller = keyboard.createController({
    windowObject: { innerWidth: 1200, matchMedia: () => ({ matches: true }), setTimeout: (fn) => fn() },
    documentObject: { activeElement: null, querySelector: () => null },
    messagesEl: { clientHeight: 1000, scrollTop: 0, contains: () => false },
    promptEl: { focus() {} },
    settingsModal: null,
    jumpLatestButton: { hidden: false },
    jumpLastStartButton: { hidden: false },
    chats: new Map([
      [2, { id: 2 }],
      [4, { id: 4 }],
      [8, { id: 8 }],
    ]),
    getActiveChatId: () => activeChatId,
    getMobileQuoteMode: () => false,
    openChat: (chatId) => opened.push(chatId),
    openPinnedChat: () => {},
    getNextChatTabId: ({ activeChatId: current }) => (current === 4 ? 8 : 2),
    handleJumpLatest: () => {},
    handleJumpLastStart: () => {},
    focusMessagesPaneIfActiveChat: () => {},
    createChat: async () => actions.push(`create:${activeChatId}`),
    removeActiveChat: async () => actions.push(`remove:${activeChatId}`),
  });

  controller.handleGlobalTabCycle({
    defaultPrevented: false,
    isComposing: false,
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    key: 'ArrowRight',
    target: {},
    preventDefault() {},
  });
  activeChatId = 8;
  controller.handleGlobalTabCycle({
    defaultPrevented: false,
    isComposing: false,
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    key: 'ArrowRight',
    target: {},
    preventDefault() {},
  });
  controller.handleGlobalChatActionShortcut({
    defaultPrevented: false,
    isComposing: false,
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    repeat: false,
    key: 'Escape',
    code: 'Escape',
    target: {},
    preventDefault() {},
  });
  activeChatId = 2;
  controller.handleGlobalChatActionShortcut({
    defaultPrevented: false,
    isComposing: false,
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    repeat: false,
    key: '`',
    code: 'Backquote',
    target: {},
    preventDefault() {},
  });

  assert.deepEqual(opened, [8, 2]);
  assert.deepEqual(actions, ['remove:8', 'create:2']);
});
