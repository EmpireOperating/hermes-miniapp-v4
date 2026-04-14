import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const keyboard = require('../static/keyboard_shortcuts_helpers.js');

function withFakeDomClasses(run) {
  const previousElement = globalThis.Element;
  const previousHTMLElement = globalThis.HTMLElement;
  class FakeElement {}
  class FakeHTMLElement extends FakeElement {}
  globalThis.Element = FakeElement;
  globalThis.HTMLElement = FakeHTMLElement;
  try {
    return run({ FakeElement, FakeHTMLElement });
  } finally {
    if (previousElement === undefined) {
      delete globalThis.Element;
    } else {
      globalThis.Element = previousElement;
    }
    if (previousHTMLElement === undefined) {
      delete globalThis.HTMLElement;
    } else {
      globalThis.HTMLElement = previousHTMLElement;
    }
  }
}

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

test('ensureTabFullyVisible nudges scroller just enough to reveal a clipped right-edge tab', () => {
  const scrollCalls = [];
  const tabsEl = {
    scrollLeft: 24,
    scrollWidth: 600,
    clientWidth: 200,
    getBoundingClientRect: () => ({ left: 100, right: 300 }),
    scrollTo: (options) => scrollCalls.push(options),
  };
  const tabNode = {
    getBoundingClientRect: () => ({ left: 230, right: 332 }),
  };

  const moved = keyboard.ensureTabFullyVisible({ tabsEl, tabNode, visibilityBufferPx: 14 });

  assert.equal(moved, true);
  assert.deepEqual(scrollCalls, [{ left: 70, behavior: 'auto' }]);
});

test('ensureTabFullyVisible nudges scroller left to reveal a clipped left-edge tab', () => {
  const tabsEl = {
    scrollLeft: 90,
    scrollWidth: 600,
    clientWidth: 200,
    getBoundingClientRect: () => ({ left: 100, right: 300 }),
  };
  const tabNode = {
    getBoundingClientRect: () => ({ left: 102, right: 190 }),
  };

  const moved = keyboard.ensureTabFullyVisible({ tabsEl, tabNode, visibilityBufferPx: 14 });

  assert.equal(moved, true);
  assert.equal(tabsEl.scrollLeft, 78);
});

test('handleGlobalTabCycle opens next chat for desktop ArrowRight outside text entry and reveals clipped tab', () => {
  const opened = [];
  let prevented = false;
  const event = {
    defaultPrevented: false,
    isComposing: false,
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    key: 'ArrowRight',
    target: { id: 'outside-input' },
    preventDefault: () => {
      prevented = true;
    },
  };
  const revealed = [];
  const tabNodes = new Map([[8, { dataset: { chatId: '8' } }]]);

  keyboard.handleGlobalTabCycle(event, {
    mobileQuoteMode: false,
    isDesktopViewportFn: () => true,
    settingsModal: null,
    isTextEntryElementFn: () => false,
    activeChatId: 4,
    promptEl: { id: 'composer' },
    chats: new Map([
      [2, { id: 2 }],
      [4, { id: 4 }],
      [8, { id: 8 }],
    ]),
    tabsEl: { id: 'chat-tabs' },
    tabNodes,
    getNextChatTabId: ({ orderedChatIds, activeChatId, reverse }) => {
      assert.deepEqual(orderedChatIds, [2, 4, 8]);
      assert.equal(activeChatId, 4);
      assert.equal(reverse, false);
      return 8;
    },
    openChat: (chatId) => {
      opened.push(chatId);
    },
    ensureTabVisibilityFn: ({ tabsEl, tabNode, visibilityBufferPx, behavior }) => {
      revealed.push({ tabsEl, tabNode, visibilityBufferPx, behavior });
      return true;
    },
  });

  assert.equal(prevented, true);
  assert.deepEqual(opened, [8]);
  assert.deepEqual(revealed, [{
    tabsEl: { id: 'chat-tabs' },
    tabNode: tabNodes.get(8),
    visibilityBufferPx: 14,
    behavior: 'auto',
  }]);
});

test('handleGlobalTabCycle respects externally supplied visual tab order over numeric chat-id order', () => {
  const opened = [];
  let prevented = false;
  const event = {
    defaultPrevented: false,
    isComposing: false,
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
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
    documentObject: { querySelector: () => null },
    isTextEntryElementFn: () => false,
    activeChatId: 11,
    promptEl: { id: 'composer' },
    chats: new Map([
      [2, { id: 2 }],
      [7, { id: 7 }],
      [11, { id: 11 }],
    ]),
    getOrderedChatIdsFromState: () => [7, 11, 2],
    getNextChatTabId: ({ orderedChatIds, activeChatId, reverse }) => {
      assert.deepEqual(orderedChatIds, [7, 11, 2]);
      assert.equal(activeChatId, 11);
      assert.equal(reverse, false);
      return 2;
    },
    openChat: (chatId) => {
      opened.push(chatId);
    },
  });

  assert.equal(prevented, true);
  assert.deepEqual(opened, [2]);
});

test('handleGlobalTabCycle opens previous/next chat from composer only on Ctrl+Alt+ArrowLeft/ArrowRight', () => {
  const opened = [];
  const promptEl = { id: 'composer' };
  const makeEvent = (key, { altKey = false, ctrlKey = false, shiftKey = false } = {}) => {
    let prevented = false;
    return {
      event: {
        defaultPrevented: false,
        isComposing: false,
        altKey,
        ctrlKey,
        metaKey: false,
        shiftKey,
        key,
        target: promptEl,
        preventDefault: () => {
          prevented = true;
        },
      },
      wasPrevented: () => prevented,
    };
  };

  const commonOptions = {
    mobileQuoteMode: false,
    isDesktopViewportFn: () => true,
    settingsModal: null,
    isTextEntryElementFn: (element) => element === promptEl,
    activeChatId: 4,
    promptEl,
    chats: new Map([
      [2, { id: 2 }],
      [4, { id: 4 }],
      [8, { id: 8 }],
    ]),
    getNextChatTabId: ({ reverse }) => (reverse ? 2 : 8),
    openChat: (chatId) => {
      opened.push(chatId);
    },
  };

  const plainRight = makeEvent('ArrowRight');
  keyboard.handleGlobalTabCycle(plainRight.event, commonOptions);
  assert.equal(plainRight.wasPrevented(), false);

  const ctrlOnlyLeft = makeEvent('ArrowLeft', { ctrlKey: true });
  keyboard.handleGlobalTabCycle(ctrlOnlyLeft.event, commonOptions);
  assert.equal(ctrlOnlyLeft.wasPrevented(), false);

  const altOnlyRight = makeEvent('ArrowRight', { altKey: true });
  keyboard.handleGlobalTabCycle(altOnlyRight.event, commonOptions);
  assert.equal(altOnlyRight.wasPrevented(), false);

  const ctrlAltShiftLeft = makeEvent('ArrowLeft', { ctrlKey: true, altKey: true, shiftKey: true });
  keyboard.handleGlobalTabCycle(ctrlAltShiftLeft.event, commonOptions);
  assert.equal(ctrlAltShiftLeft.wasPrevented(), false);

  const ctrlAltLeft = makeEvent('ArrowLeft', { ctrlKey: true, altKey: true });
  keyboard.handleGlobalTabCycle(ctrlAltLeft.event, commonOptions);
  assert.equal(ctrlAltLeft.wasPrevented(), true);

  const ctrlAltRight = makeEvent('ArrowRight', { ctrlKey: true, altKey: true });
  keyboard.handleGlobalTabCycle(ctrlAltRight.event, commonOptions);
  assert.equal(ctrlAltRight.wasPrevented(), true);

  assert.deepEqual(opened, [2, 8]);
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

test('handleGlobalShortcutsHelpShortcut opens shortcuts sheet on desktop question mark', () => {
  const calls = [];
  let prevented = false;

  keyboard.handleGlobalShortcutsHelpShortcut({
    defaultPrevented: false,
    isComposing: false,
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    shiftKey: true,
    repeat: false,
    key: '?',
    target: {},
    preventDefault() {
      prevented = true;
    },
  }, {
    mobileQuoteMode: false,
    isDesktopViewportFn: () => true,
    documentObject: { querySelector: () => null },
    isTextEntryElementFn: () => false,
    openKeyboardShortcutsModal: () => calls.push('open'),
  });

  assert.equal(prevented, true);
  assert.deepEqual(calls, ['open']);
});

test('handleGlobalShortcutsHelpShortcut ignores text entry, modifiers, and open dialogs', () => {
  const calls = [];
  const run = (overrides = {}, options = {}) => {
    keyboard.handleGlobalShortcutsHelpShortcut({
      defaultPrevented: false,
      isComposing: false,
      altKey: false,
      ctrlKey: false,
      metaKey: false,
      shiftKey: true,
      repeat: false,
      key: '?',
      target: {},
      preventDefault() {},
      ...overrides,
    }, {
      mobileQuoteMode: false,
      isDesktopViewportFn: () => true,
      documentObject: { querySelector: () => null },
      isTextEntryElementFn: () => false,
      openKeyboardShortcutsModal: () => calls.push('open'),
      ...options,
    });
  };

  run({ target: { id: 'input' } }, { isTextEntryElementFn: () => true });
  run({ ctrlKey: true });
  run({ repeat: true });
  run({}, { documentObject: { querySelector: () => ({ open: true }) } });

  assert.deepEqual(calls, []);
});

test('handleGlobalControlClickFocusCleanup skips sticky-focus release for quote-style controls that explicitly preserve composer focus', () => {
  withFakeDomClasses(({ FakeElement }) => {
    let releaseCalls = 0;
    const skipTarget = new FakeElement();
    skipTarget.closest = (selector) => selector === keyboard.CONTROL_FOCUS_RELEASE_SKIP_SELECTOR ? skipTarget : null;

    keyboard.handleGlobalControlClickFocusCleanup({ target: skipTarget }, {
      shouldReleaseControlFocusAfterClickFn: () => true,
      shouldSkipControlFocusReleaseAfterClickFn: keyboard.shouldSkipControlFocusReleaseAfterClick,
      releaseStickyControlFocusFn: () => {
        releaseCalls += 1;
      },
      windowObject: {
        setTimeout() {
          throw new Error('skip-marked quote controls should not schedule sticky focus cleanup');
        },
      },
    });

    assert.equal(releaseCalls, 0);
  });
});

test('controller methods read state lazily so chat switching actions use the latest active chat id', () => {
  const opened = [];
  const actions = [];
  let activeChatId = 4;
  const controller = keyboard.createController({
    windowObject: { innerWidth: 1200 },
    documentObject: { activeElement: null, querySelector: () => null },
    tabsEl: {},
    tabNodes: new Map(),
    settingsModal: null,
    promptEl: { focus() {} },
    messagesEl: {},
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
    openKeyboardShortcutsModal: () => actions.push(`help:${activeChatId}`),
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
