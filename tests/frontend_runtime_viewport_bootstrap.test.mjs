import { test, assert, bootstrapAuth, composerViewport, createMessageNode, createMessagesHarness, createComposerViewportHarness } from './frontend_runtime_test_harness.mjs';

test('preserveViewportDuringUiMutation keeps the same reading position when earlier content grows', () => {
  const previousRaf = globalThis.requestAnimationFrame;
  const previousCancelRaf = globalThis.cancelAnimationFrame;
  globalThis.requestAnimationFrame = (callback) => {
    callback();
    return 1;
  };
  globalThis.cancelAnimationFrame = () => {};

  const harness = createMessagesHarness([
    createMessageNode('a', 0, 100),
    createMessageNode('b', 100, 100),
    createMessageNode('c', 200, 100),
  ]);
  const { messagesEl, setNodes } = harness;
  messagesEl.scrollTop = 150;
  messagesEl.scrollHeight = 600;
  messagesEl.clientHeight = 200;

  const controller = composerViewport.createController({
    windowObject: {
      scrollY: 0,
      setTimeout: () => 1,
      clearTimeout: () => {},
      scrollTo: () => {},
      addEventListener: () => {},
    },
    documentObject: { visibilityState: 'visible' },
    tg: null,
    promptEl: null,
    form: null,
    messagesEl,
    tabsEl: null,
    mobileQuoteMode: false,
    isNearBottomFn: (element, threshold = 24) => (Number(element.scrollHeight || 0) - Number(element.clientHeight || 0) - Number(element.scrollTop || 0)) <= threshold,
    getActiveChatId: () => 7,
    chatScrollTop: new Map(),
    chatStickToBottom: new Map(),
    updateJumpLatestVisibility: () => {},
  });

  try {
    controller.preserveViewportDuringUiMutation(() => {
      setNodes([
        createMessageNode('a', 0, 150),
        createMessageNode('b', 150, 100),
        createMessageNode('c', 250, 100),
      ]);
      messagesEl.scrollHeight = 650;
    });

    assert.equal(messagesEl.scrollTop, 200);
  } finally {
    globalThis.requestAnimationFrame = previousRaf;
    globalThis.cancelAnimationFrame = previousCancelRaf;
  }
});


test('installKeyboardViewportSync does not focus composer after touch scroll gesture on prompt', () => {
  const harness = createComposerViewportHarness();
  const touchStartEvent = {
    touches: [{ clientX: 20, clientY: 30 }],
    preventDefaultCalled: false,
    preventDefault() {
      this.preventDefaultCalled = true;
    },
  };
  const touchMoveEvent = {
    touches: [{ clientX: 20, clientY: 54 }],
  };
  const touchEndEvent = {
    changedTouches: [{ clientX: 20, clientY: 54 }],
    preventDefaultCalled: false,
    preventDefault() {
      this.preventDefaultCalled = true;
    },
  };

  harness.dispatchPromptEvent('touchstart', touchStartEvent);
  harness.dispatchPromptEvent('touchmove', touchMoveEvent);
  harness.dispatchPromptEvent('touchend', touchEndEvent);

  assert.equal(harness.promptEl.focusCalls, 0);
  assert.equal(harness.documentObject.activeElement, harness.documentObject.body);
  assert.equal(touchStartEvent.preventDefaultCalled, false);
  assert.equal(touchEndEvent.preventDefaultCalled, false);
});


test('installKeyboardViewportSync focuses composer only after guarded touch tap on prompt', () => {
  const harness = createComposerViewportHarness();
  const touchStartEvent = {
    touches: [{ clientX: 20, clientY: 30 }],
    preventDefaultCalled: false,
    preventDefault() {
      this.preventDefaultCalled = true;
    },
  };
  const touchEndEvent = {
    changedTouches: [{ clientX: 24, clientY: 34 }],
    preventDefaultCalled: false,
    preventDefault() {
      this.preventDefaultCalled = true;
    },
  };

  harness.dispatchPromptEvent('touchstart', touchStartEvent);
  harness.dispatchPromptEvent('touchend', touchEndEvent);

  assert.equal(harness.promptEl.focusCalls, 1);
  assert.equal(harness.documentObject.activeElement, harness.promptEl);
  assert.equal(touchStartEvent.preventDefaultCalled, false);
  assert.equal(touchEndEvent.preventDefaultCalled, false);
});


test('applyAuthBootstrap clears stale tabs when auth bootstrap returns zero open chats', () => {
  const chats = new Map([[1, { id: 1, title: 'main', unread_count: 0, pending: false, is_pinned: false }]]);
  const pinnedChats = new Map([[1, { id: 1, title: 'main', unread_count: 0, pending: false, is_pinned: false }]]);
  const histories = new Map([[1, [{ role: 'user', body: 'stale' }]]]);
  const pendingChats = new Set([1]);
  const syncCalls = [];
  const activeChatMetaCalls = [];
  const operatorName = { textContent: '' };
  const authStatus = { textContent: '' };

  const controller = bootstrapAuth.createController({
    desktopTestingEnabled: false,
    devAuthSessionStorageKey: 'dev-auth',
    devAuthControls: null,
    devModeBadge: null,
    devSignInButton: null,
    getIsAuthenticated: () => false,
    setIsAuthenticated: () => {},
    sessionStorageRef: {
      getItem: () => null,
      setItem: () => {},
    },
    devAuthModal: null,
    devAuthForm: null,
    devAuthSecretInput: null,
    devAuthUserIdInput: null,
    devAuthDisplayNameInput: null,
    devAuthUsernameInput: null,
    devAuthCancelButton: null,
    authStatus,
    appendSystemMessage: () => {},
    safeReadJson: async () => ({}),
    fetchImpl: async () => ({ ok: false, status: 500 }),
    normalizeHandle: (value) => String(value || '').trim(),
    fallbackHandleFromDisplayName: (value) => String(value || '').trim(),
    setOperatorDisplayName: () => {},
    operatorName,
    refreshOperatorRoleLabels: () => {},
    setSkin: () => {},
    syncChats: (chatList) => {
      syncCalls.push(chatList.map((chat) => Number(chat.id)));
      const nextIds = new Set(chatList.map((chat) => Number(chat.id)));
      for (const chatId of [...chats.keys()]) {
        if (!nextIds.has(chatId)) {
          chats.delete(chatId);
          pinnedChats.delete(chatId);
          histories.delete(chatId);
          pendingChats.delete(chatId);
        }
      }
      chatList.forEach((chat) => {
        chats.set(Number(chat.id), chat);
        if (chat?.is_pinned) {
          pinnedChats.set(Number(chat.id), chat);
        } else {
          pinnedChats.delete(Number(chat.id));
        }
      });
    },
    syncPinnedChats: (chatList) => {
      pinnedChats.clear();
      chatList.forEach((chat) => pinnedChats.set(Number(chat.id), chat));
    },
    histories,
    setActiveChatMeta: (chatId) => {
      activeChatMetaCalls.push(chatId);
    },
    renderPinnedChats: () => {},
    renderMessages: () => {},
    warmChatHistoryCache: () => {},
    chats,
    pendingChats,
    resumePendingChatStream: () => Promise.resolve(),
    addLocalMessage: () => {},
  });

  controller.applyAuthBootstrap({
    ok: true,
    user: { display_name: 'Operator', username: 'operator' },
    skin: 'terminal',
    chats: [],
    pinned_chats: [],
    active_chat_id: null,
  });

  assert.deepEqual(syncCalls, [[]]);
  assert.deepEqual(activeChatMetaCalls, [null]);
  assert.equal(chats.size, 0);
  assert.equal(pinnedChats.size, 0);
  assert.equal(histories.size, 0);
  assert.equal(pendingChats.size, 0);
  assert.equal(authStatus.textContent, 'Signed in as operator');
  assert.equal(operatorName.textContent, 'operator');
});
