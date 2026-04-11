import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const chatAdmin = require('../static/chat_admin_helpers.js');

function createEventTarget(initial = {}) {
  const listeners = new Map();
  return {
    ...initial,
    addEventListener(type, handler) {
      const bucket = listeners.get(type) || new Set();
      bucket.add(handler);
      listeners.set(type, bucket);
    },
    removeEventListener(type, handler) {
      listeners.get(type)?.delete(handler);
    },
    dispatch(type, event = {}) {
      const payload = {
        preventDefault() {},
        currentTarget: this,
        target: this,
        ...event,
      };
      for (const handler of listeners.get(type) || []) {
        handler(payload);
      }
    },
  };
}

function createModal() {
  const modal = createEventTarget({
    open: false,
    showModal() {
      this.open = true;
    },
    close() {
      this.open = false;
      this.dispatch('close');
    },
    setAttribute(name, value) {
      this.attributes = this.attributes || new Map();
      this.attributes.set(name, value);
    },
    removeAttribute(name) {
      this.attributes?.delete(name);
    },
  });
  return modal;
}

function createButton(tag = null) {
  return createEventTarget({
    dataset: tag ? { chatTitleTag: tag } : {},
    attributes: new Map(),
    classList: {
      toggles: [],
      toggle(name, value) {
        this.toggles.push([name, Boolean(value)]);
      },
    },
    setAttribute(name, value) {
      this.attributes.set(name, value);
    },
  });
}

function buildHarness(overrides = {}) {
  const apiCalls = [];
  const chats = new Map(overrides.initialChats || [
    [7, { id: 7, title: '[bug]Current', is_pinned: true }],
  ]);
  const pinnedChats = new Map(overrides.initialPinnedChats || [
    [7, { id: 7, title: '[bug]Current', is_pinned: true }],
    [11, { id: 11, title: 'Pinned only', is_pinned: true }],
  ]);
  const histories = new Map(overrides.initialHistories || [[7, [{ id: 1, body: 'old' }]]]);
  const pendingChats = new Set();
  const latencyByChat = new Map([[7, '123ms']]);
  const streamPhaseByChat = new Map([[7, 'streaming']]);
  const unseenStreamChats = new Set([7]);
  const settingsModal = overrides.settingsModal || createModal();
  const chatTitleModal = overrides.chatTitleModal || createModal();
  const chatTitleForm = overrides.chatTitleForm || createEventTarget();
  const chatTabContextMenu = overrides.chatTabContextMenu || {
    hidden: true,
    style: { left: '', top: '' },
    contains() {
      return false;
    },
  };
  const createContextButton = (provided = null) => provided || {
    disabled: false,
    title: '',
    textContent: '',
    attributes: new Map(),
    setAttribute(name, value) {
      this.attributes.set(name, value);
    },
  };
  const chatTabContextRename = createContextButton(overrides.chatTabContextRename);
  const chatTabContextPin = createContextButton(overrides.chatTabContextPin);
  const chatTabContextClose = createContextButton(overrides.chatTabContextClose);
  const chatTabContextFork = createContextButton(overrides.chatTabContextFork);
  const chatTitleInput = {
    value: '',
    focusCalls: 0,
    selectCalls: 0,
    focus() {
      this.focusCalls += 1;
    },
    select() {
      this.selectCalls += 1;
    },
  };
  const featButton = createButton('feat');
  const bugButton = createButton('bug');
  const noneButton = createButton('none');
  const chatTitleTagButtons = [noneButton, featButton, bugButton];
  const upsertedChats = [];
  const syncedChats = [];
  const syncedPinnedChats = [];
  const renderedMessages = [];
  const renderedTabs = [];
  const renderedPinnedChats = [];
  const clearedStreamState = [];
  const openChatCalls = [];
  const movedChatIds = [];
  const setActiveCalls = [];
  const setNoActiveCalls = [];
  const syncPinCalls = [];
  const promptCalls = [];
  const latencyMutationCalls = [];
  const focusComposerCalls = [];
  let activeChatId = 7;

  const controller = chatAdmin.createController({
    windowObject: {
      innerWidth: 480,
      innerHeight: 320,
      prompt(message, defaultValue) {
        promptCalls.push([message, defaultValue]);
        return null;
      },
      setTimeout(callback) {
        callback();
        return 1;
      },
      ...(overrides.windowObject || {}),
    },
    tabActionsMenuEnabled: overrides.tabActionsMenuEnabled ?? true,
    settingsModal,
    chatTitleModal,
    chatTitleForm,
    chatTitleHint: { textContent: '', hidden: false },
    chatTitleInput,
    chatTitleCancel: createButton(),
    chatTitleConfirm: { textContent: '' },
    chatTitleTagLabel: { hidden: false },
    chatTitleTagRow: { hidden: false },
    chatTitleTagButtons,
    chatTabContextMenu,
    chatTabContextRename,
    chatTabContextPin,
    chatTabContextClose,
    chatTabContextFork,
    apiPost: async (path, payload) => {
      apiCalls.push({ path, payload });
      if (path === '/api/chats') {
        return { chat: { id: 13, title: payload.title }, history: [{ id: 5, body: 'new history' }] };
      }
      if (path === '/api/chats/rename') {
        return { chat: { id: 7, title: payload.title, is_pinned: true } };
      }
      if (path === '/api/chats/remove') {
        return {
          removed_chat_id: 7,
          active_chat_id: 9,
          active_chat: { id: 9, title: 'Next chat' },
          chats: [{ id: 9, title: 'Next chat' }],
          pinned_chats: [{ id: 7, title: '[bug]Current', is_pinned: true }],
          history: [{ id: 99, body: 'fresh' }],
        };
      }
      if (path === '/api/chats/reopen') {
        return {
          chat: { id: 11, title: 'Pinned only', is_pinned: true },
          chats: [{ id: 11, title: 'Pinned only', is_pinned: true }],
          pinned_chats: [{ id: 11, title: 'Pinned only', is_pinned: true }],
        };
      }
      if (path === '/api/chats/branch') {
        return {
          chat: { id: 19, title: payload.title || 'Current #2', parent_chat_id: 7, is_pinned: false },
          active_chat_id: 19,
          history: [{ id: 200, body: 'old' }],
          chats: [
            { id: 7, title: '[bug]Current', is_pinned: true },
            { id: 19, title: payload.title || 'Current #2', parent_chat_id: 7, is_pinned: false },
          ],
          pinned_chats: [{ id: 7, title: '[bug]Current', is_pinned: true }],
        };
      }
      if (path === '/api/chats/pin' || path === '/api/chats/unpin') {
        return {
          chat: { id: 7, title: 'Current', is_pinned: path === '/api/chats/pin' },
          pinned_chats: [{ id: 7, title: 'Current', is_pinned: path === '/api/chats/pin' }],
        };
      }
      throw new Error(`unexpected api path ${path}`);
    },
    chats,
    pinnedChats,
    histories,
    pendingChats,
    latencyByChat,
    streamPhaseByChat,
    unseenStreamChats,
    normalizeChat: (chat, { forcePinned = null } = {}) => ({
      ...chat,
      is_pinned: forcePinned == null ? Boolean(chat?.is_pinned) : Boolean(forcePinned),
    }),
    clearChatStreamState: (payload) => {
      clearedStreamState.push(payload);
      pendingChats.delete(Number(payload.chatId));
      streamPhaseByChat.delete(Number(payload.chatId));
      unseenStreamChats.delete(Number(payload.chatId));
    },
    upsertChat: (chat) => upsertedChats.push(chat),
    syncChats: (list) => syncedChats.push(list),
    syncPinnedChats: (list) => syncedPinnedChats.push(list),
    setActiveChatMeta: (chatId) => {
      activeChatId = Number(chatId);
      setActiveCalls.push(Number(chatId));
    },
    setNoActiveChatMeta: () => {
      activeChatId = null;
      setNoActiveCalls.push('none');
    },
    renderMessages: (chatId) => renderedMessages.push(Number(chatId)),
    renderTabs: () => renderedTabs.push('tabs'),
    renderPinnedChats: () => renderedPinnedChats.push('pinned'),
    syncPinChatButton: () => syncPinCalls.push('pin'),
    moveChatToEnd: (chatId) => movedChatIds.push(Number(chatId)),
    chatLabel: (chatId) => chats.get(Number(chatId))?.title || `Chat ${chatId}`,
    getActiveChatId: () => activeChatId,
    openChat: async (chatId) => {
      openChatCalls.push(Number(chatId));
    },
    onLatencyByChatMutated: (mapRef) => {
      latencyMutationCalls.push(new Map(mapRef));
    },
    focusComposerForNewChat: (chatId) => {
      focusComposerCalls.push(Number(chatId));
    },
    ...overrides,
  });

  return {
    controller,
    apiCalls,
    chats,
    pinnedChats,
    histories,
    pendingChats,
    latencyByChat,
    streamPhaseByChat,
    unseenStreamChats,
    settingsModal,
    chatTitleModal,
    chatTitleForm,
    chatTabContextMenu,
    chatTabContextRename,
    chatTabContextPin,
    chatTabContextClose,
    chatTabContextFork,
    chatTitleInput,
    chatTitleTagButtons,
    upsertedChats,
    syncedChats,
    syncedPinnedChats,
    renderedMessages,
    renderedTabs,
    renderedPinnedChats,
    clearedStreamState,
    openChatCalls,
    movedChatIds,
    setActiveCalls,
    setNoActiveCalls,
    syncPinCalls,
    promptCalls,
    latencyMutationCalls,
    focusComposerCalls,
    get activeChatId() {
      return activeChatId;
    },
    setActiveChatId(value) {
      activeChatId = Number(value);
    },
    getActiveChatId() {
      return activeChatId;
    },
  };
}

test('askForChatTitle rename modal resolves submitted tagged title before dialog close cancellation', async () => {
  const harness = buildHarness();

  const titlePromise = harness.controller.askForChatTitle({
    mode: 'rename',
    currentTitle: '[bug]Current',
    defaultTitle: 'Current',
  });

  harness.chatTitleTagButtons[1].dispatch('click', { currentTarget: harness.chatTitleTagButtons[1] });
  harness.chatTitleInput.value = 'Fixed title';
  harness.chatTitleForm.dispatch('submit');

  const result = await titlePromise;
  assert.equal(result, '[feat]Fixed title');
  assert.equal(harness.chatTitleModal.open, false);
  assert.equal(harness.chatTitleInput.focusCalls > 0, true);
  assert.equal(harness.chatTitleInput.selectCalls > 0, true);
});

test('askForChatTitle focuses input synchronously before timeout retry', async () => {
  const scheduledCallbacks = [];
  const harness = buildHarness({
    windowObject: {
      prompt() {
        return null;
      },
      setTimeout(callback) {
        scheduledCallbacks.push(callback);
        return scheduledCallbacks.length;
      },
    },
  });

  const titlePromise = harness.controller.askForChatTitle({
    mode: 'rename',
    currentTitle: '[bug]Current',
    defaultTitle: 'Current',
  });

  assert.equal(harness.chatTitleInput.focusCalls > 0, true);
  assert.equal(harness.chatTitleInput.selectCalls > 0, true);
  assert.equal(scheduledCallbacks.length, 1);

  harness.chatTitleModal.dispatch('cancel');
  const result = await titlePromise;
  assert.equal(result, null);
});

test('tag toggle interactions preserve title-input focus for mobile keyboard continuity', async () => {
  const harness = buildHarness();

  const titlePromise = harness.controller.askForChatTitle({
    mode: 'rename',
    currentTitle: '[bug]Current',
    defaultTitle: 'Current',
  });

  const focusBeforeToggle = harness.chatTitleInput.focusCalls;
  harness.chatTitleTagButtons[1].dispatch('mousedown', { currentTarget: harness.chatTitleTagButtons[1] });
  harness.chatTitleTagButtons[1].dispatch('click', { currentTarget: harness.chatTitleTagButtons[1] });
  assert.equal(harness.chatTitleInput.focusCalls > focusBeforeToggle, true);

  harness.chatTitleModal.dispatch('cancel');
  const result = await titlePromise;
  assert.equal(result, null);
});

test('touchstart tag toggle still applies selection when click is suppressed by mobile webview behavior', async () => {
  const harness = buildHarness();

  const titlePromise = harness.controller.askForChatTitle({
    mode: 'rename',
    currentTitle: 'Current',
    defaultTitle: 'Current',
  });

  harness.chatTitleInput.value = 'Zero Tab';
  harness.chatTitleTagButtons[1].dispatch('touchstart', { currentTarget: harness.chatTitleTagButtons[1] });
  harness.chatTitleForm.dispatch('submit');

  const result = await titlePromise;
  assert.equal(result, '[feat]Zero Tab');
});

test('createChat modal applies selected tag and hydrates the new active chat', async () => {
  const harness = buildHarness();

  const createPromise = harness.controller.createChat();
  harness.chatTitleInput.value = 'Launch plan';
  harness.chatTitleTagButtons[2].dispatch('touchstart', { currentTarget: harness.chatTitleTagButtons[2] });
  harness.chatTitleForm.dispatch('submit');
  await createPromise;

  assert.deepEqual(harness.apiCalls[0], {
    path: '/api/chats',
    payload: { title: '[bug]Launch plan' },
  });
  assert.deepEqual(harness.histories.get(13), [{ id: 5, body: 'new history' }]);
  assert.deepEqual(harness.setActiveCalls, [13]);
  assert.deepEqual(harness.renderedMessages, [13]);
  assert.deepEqual(harness.focusComposerCalls, [13]);
});

test('createChat fallback prompt applies selected tag and hydrates the new active chat', async () => {
  const harness = buildHarness({
    chatTitleModal: null,
    chatTitleForm: null,
    chatTitleInput: null,
    chatTitleHint: null,
    chatTitleConfirm: null,
    chatTitleCancel: null,
    windowObject: {
      prompt(message) {
        if (message.includes('New chat')) return 'Launch plan';
        if (message.includes('Tag')) return 'feat';
        return null;
      },
    },
  });

  await harness.controller.createChat();

  assert.deepEqual(harness.apiCalls[0], {
    path: '/api/chats',
    payload: { title: '[feat]Launch plan' },
  });
  assert.deepEqual(harness.histories.get(13), [{ id: 5, body: 'new history' }]);
  assert.deepEqual(harness.setActiveCalls, [13]);
  assert.deepEqual(harness.renderedMessages, [13]);
  assert.deepEqual(harness.focusComposerCalls, [13]);
});

test('removeActiveChat keeps silent-close semantics and preserves removed pinned chats for reopen', async () => {
  const harness = buildHarness();

  await harness.controller.removeActiveChat();

  assert.deepEqual(harness.apiCalls[0], {
    path: '/api/chats/remove',
    payload: { chat_id: 7, allow_empty: true, include_full_state: false },
  });
  assert.equal(harness.histories.has(7), false);
  assert.deepEqual(harness.histories.get(9), [{ id: 99, body: 'fresh' }]);
  assert.equal(harness.pinnedChats.has(7), true);
  assert.deepEqual(harness.clearedStreamState.map((entry) => entry.chatId), [7]);
  assert.equal(harness.latencyByChat.has(7), false);
  assert.equal(harness.latencyMutationCalls.length, 1);
  assert.equal(harness.latencyMutationCalls[0].has(7), false);
  assert.deepEqual(harness.setActiveCalls, [9]);
  assert.deepEqual(harness.renderedPinnedChats, ['pinned']);
  assert.deepEqual(harness.renderedMessages, [9]);
});

test('removeActiveChat restores removed pinned snapshot when backend payload omits pinned list entry', async () => {
  const customApiCalls = [];
  const harness = buildHarness({
    apiPost: async (path, payload) => {
      customApiCalls.push({ path, payload });
      if (path === '/api/chats/remove') {
        return {
          removed_chat_id: 7,
          active_chat_id: 9,
          active_chat: { id: 9, title: 'Next chat' },
          chats: [{ id: 9, title: 'Next chat' }],
          pinned_chats: [],
          history: [{ id: 99, body: 'fresh' }],
        };
      }
      throw new Error(`unexpected api path ${path}`);
    },
  });

  await harness.controller.removeActiveChat();

  assert.deepEqual(customApiCalls[0], {
    path: '/api/chats/remove',
    payload: { chat_id: 7, allow_empty: true, include_full_state: false },
  });
  assert.equal(harness.pinnedChats.has(7), true);
  assert.deepEqual(harness.setActiveCalls, [9]);
  assert.deepEqual(harness.renderedPinnedChats, ['pinned']);
  assert.deepEqual(harness.renderedMessages, [9]);
});

test('removeActiveChat switches away from the closing tab before the backend responds', async () => {
  let resolveRemove;
  const removePromise = new Promise((resolve) => {
    resolveRemove = resolve;
  });
  const harness = buildHarness({
    initialChats: [
      [7, { id: 7, title: '[bug]Current', is_pinned: true }],
      [9, { id: 9, title: 'Next chat', is_pinned: false }],
    ],
    initialHistories: [
      [7, [{ id: 1, body: 'old' }]],
      [9, [{ id: 2, body: 'cached next' }]],
    ],
    apiPost: async (path, payload) => {
      if (path !== '/api/chats/remove') {
        throw new Error(`unexpected api path ${path}`);
      }
      assert.deepEqual(payload, { chat_id: 7, allow_empty: true, include_full_state: false });
      return removePromise;
    },
  });

  const pendingRemoval = harness.controller.removeActiveChat();

  assert.equal(harness.chats.has(7), false);
  assert.equal(harness.activeChatId, 9);
  assert.deepEqual(harness.setActiveCalls, [9]);
  assert.deepEqual(harness.renderedTabs, ['tabs']);
  assert.deepEqual(harness.renderedPinnedChats, ['pinned']);
  assert.deepEqual(harness.renderedMessages, [9]);

  resolveRemove({
    removed_chat_id: 7,
    active_chat_id: 9,
    active_chat: { id: 9, title: 'Next chat' },
    chats: [{ id: 9, title: 'Next chat' }],
    pinned_chats: [{ id: 7, title: '[bug]Current', is_pinned: true }],
    history: [{ id: 99, body: 'fresh' }],
  });

  await pendingRemoval;
  assert.deepEqual(harness.renderedMessages, [9, 9]);
});

test('removeActiveChat rolls back the optimistic close if the backend request fails', async () => {
  const harness = buildHarness({
    initialChats: [
      [7, { id: 7, title: '[bug]Current', is_pinned: true }],
      [9, { id: 9, title: 'Next chat', is_pinned: false }],
    ],
    initialHistories: [
      [7, [{ id: 1, body: 'old' }]],
      [9, [{ id: 2, body: 'cached next' }]],
    ],
    apiPost: async (path) => {
      if (path !== '/api/chats/remove') {
        throw new Error(`unexpected api path ${path}`);
      }
      throw new Error('remove failed');
    },
  });

  await assert.rejects(harness.controller.removeActiveChat(), /remove failed/);

  assert.equal(harness.chats.has(7), true);
  assert.equal(harness.activeChatId, 7);
  assert.deepEqual(harness.setActiveCalls, [9, 7]);
  assert.deepEqual(harness.renderedMessages, [9, 7]);
  assert.equal(harness.histories.has(7), true);
});

test('removeActiveChat can transition to explicit no-active-chat state', async () => {
  const customApiCalls = [];
  const harness = buildHarness({
    apiPost: async (path, payload) => {
      customApiCalls.push({ path, payload });
      if (path === '/api/chats/remove') {
        return {
          removed_chat_id: 7,
          active_chat_id: null,
          active_chat: null,
          chats: [],
          pinned_chats: [],
          history: [],
        };
      }
      throw new Error(`unexpected api path ${path}`);
    },
  });

  await harness.controller.removeActiveChat();

  assert.deepEqual(customApiCalls[0], {
    path: '/api/chats/remove',
    payload: { chat_id: 7, allow_empty: true, include_full_state: false },
  });
  assert.deepEqual(harness.setNoActiveCalls, ['none']);
  assert.deepEqual(harness.setActiveCalls, []);
  assert.deepEqual(harness.renderedMessages, []);
  assert.deepEqual(harness.renderedPinnedChats, ['pinned']);
});

test('removeActiveChat reopens the server-selected next chat when the remove response is lightweight', async () => {
  const harness = buildHarness({
    initialChats: [
      [7, { id: 7, title: '[bug]Current', is_pinned: true }],
      [9, { id: 9, title: 'Next chat', is_pinned: false }],
    ],
    initialHistories: [
      [7, [{ id: 1, body: 'old' }]],
    ],
    apiPost: async (path, payload) => {
      if (path !== '/api/chats/remove') {
        throw new Error(`unexpected api path ${path}`);
      }
      assert.deepEqual(payload, { chat_id: 7, allow_empty: true, include_full_state: false });
      return {
        removed_chat_id: 7,
        active_chat_id: 9,
      };
    },
  });

  await harness.controller.removeActiveChat();

  assert.deepEqual(harness.openChatCalls, [9]);
  assert.deepEqual(harness.renderedPinnedChats, ['pinned', 'pinned']);
});

test('forkChatFrom clones chat history into a new active branch', async () => {
  const harness = buildHarness();

  await harness.controller.forkChatFrom(7);

  assert.deepEqual(harness.apiCalls[0], {
    path: '/api/chats/branch',
    payload: { chat_id: 7, title: '[bug]Current #2' },
  });
  assert.deepEqual(harness.histories.get(19), [{ id: 200, body: 'old' }]);
  assert.deepEqual(harness.setActiveCalls, [19]);
  assert.deepEqual(harness.renderedTabs, ['tabs']);
  assert.deepEqual(harness.renderedPinnedChats, ['pinned']);
  assert.deepEqual(harness.renderedMessages, [19]);
});

test('forkChatFrom rejects chats with active local work before calling the backend', async () => {
  const harness = buildHarness();
  harness.pendingChats.add(7);

  await assert.rejects(
    harness.controller.forkChatFrom(7),
    /Wait for Hermes to finish before branching this chat\./,
  );

  assert.deepEqual(harness.apiCalls, []);
  assert.equal(harness.histories.has(19), false);
  assert.deepEqual(harness.setActiveCalls, []);
});

test('forkChatFrom rejects chats marked pending by server state before calling the backend', async () => {
  const harness = buildHarness();
  harness.chats.set(7, { ...harness.chats.get(7), pending: true });

  await assert.rejects(
    harness.controller.forkChatFrom(7),
    /Wait for Hermes to finish before branching this chat\./,
  );

  assert.deepEqual(harness.apiCalls, []);
  assert.equal(harness.histories.has(19), false);
  assert.deepEqual(harness.setActiveCalls, []);
});

test('openPinnedChat reopens missing pinned chats on the right before delegating to openChat', async () => {
  const harness = buildHarness();

  await harness.controller.openPinnedChat(11);

  assert.deepEqual(harness.apiCalls, [{ path: '/api/chats/reopen', payload: { chat_id: 11 } }]);
  assert.deepEqual(harness.syncedChats, [[{ id: 11, title: 'Pinned only', is_pinned: true }]]);
  assert.deepEqual(harness.syncedPinnedChats, [[{ id: 11, title: 'Pinned only', is_pinned: true }]]);
  assert.deepEqual(harness.upsertedChats, [{ id: 11, title: 'Pinned only', is_pinned: true }]);
  assert.deepEqual(harness.movedChatIds, [11]);
  assert.deepEqual(harness.renderedTabs, ['tabs']);
  assert.deepEqual(harness.renderedPinnedChats, ['pinned']);
  assert.deepEqual(harness.openChatCalls, [11]);
});

test('removePinnedChatById unpins before removing so pinned cleanup disappears from the list', async () => {
  const harness = buildHarness();

  await harness.controller.removePinnedChatById(11);

  assert.deepEqual(harness.apiCalls.slice(0, 2), [
    { path: '/api/chats/unpin', payload: { chat_id: 11 } },
    {
      path: '/api/chats/remove',
      payload: {
        chat_id: 11,
        allow_empty: true,
        include_full_state: true,
      },
    },
  ]);
  assert.equal(harness.renderedPinnedChats.length >= 1, true);
});

test('forkChatFrom clones selected chat into a new active tab and hydrates history', async () => {
  const harness = buildHarness();

  await harness.controller.forkChatFrom(7);

  assert.deepEqual(harness.apiCalls[0], {
    path: '/api/chats/branch',
    payload: { chat_id: 7, title: '[bug]Current #2' },
  });
  assert.deepEqual(harness.histories.get(19), [{ id: 200, body: 'old' }]);
  assert.deepEqual(harness.setActiveCalls, [19]);
  assert.deepEqual(harness.renderedMessages, [19]);
  assert.deepEqual(harness.renderedTabs, ['tabs']);
  assert.deepEqual(harness.renderedPinnedChats, ['pinned']);
});

test('toggleActiveChatPin switches endpoint based on current pin state and refreshes controls', async () => {
  const harness = buildHarness();

  await harness.controller.toggleActiveChatPin();

  assert.equal(harness.apiCalls[0].path, '/api/chats/unpin');
  assert.deepEqual(harness.renderedTabs, ['tabs']);
  assert.deepEqual(harness.renderedPinnedChats, ['pinned']);
  assert.deepEqual(harness.syncPinCalls, ['pin']);
});

test('settings modal helpers support dialog and attribute fallbacks', () => {
  const harness = buildHarness();

  harness.controller.openSettingsModal();
  assert.equal(harness.settingsModal.open, true);

  harness.controller.closeSettingsModal();
  assert.equal(harness.settingsModal.open, false);

  const fallbackHarness = buildHarness({
    settingsModal: {
      attributes: new Map(),
      setAttribute(name, value) {
        this.attributes.set(name, value);
      },
      removeAttribute(name) {
        this.attributes.delete(name);
      },
    },
  });

  fallbackHarness.controller.openSettingsModal();
  assert.equal(fallbackHarness.settingsModal.attributes.get('open'), 'open');
  fallbackHarness.controller.closeSettingsModal();
  assert.equal(fallbackHarness.settingsModal.attributes.has('open'), false);
});

test('chat tab context menu open/close clamps viewport coordinates', () => {
  const harness = buildHarness({
    windowObject: { innerWidth: 210, innerHeight: 120 },
  });

  harness.controller.openChatTabContextMenu(7, 999, 999);
  assert.equal(harness.chatTabContextMenu.hidden, false);
  assert.equal(harness.chatTabContextFork.disabled, false);
  assert.equal(harness.chatTabContextFork.attributes.get('aria-disabled'), 'false');
  assert.equal(harness.chatTabContextMenu.style.left, '30px');
  assert.equal(harness.chatTabContextMenu.style.top, '8px');

  harness.controller.closeChatTabContextMenu();
  assert.equal(harness.chatTabContextMenu.hidden, true);
});

test('chat tab context menu stays open and disables only blocked actions for pending chats', () => {
  const harness = buildHarness();
  harness.chats.set(7, { ...harness.chats.get(7), pending: true });

  harness.controller.openChatTabContextMenu(7, 40, 40);

  assert.equal(harness.chatTabContextMenu.hidden, false);
  assert.equal(harness.chatTabContextRename.disabled, false);
  assert.equal(harness.chatTabContextPin.disabled, false);
  assert.equal(harness.chatTabContextClose.disabled, true);
  assert.equal(harness.chatTabContextFork.disabled, true);
  assert.equal(harness.chatTabContextFork.attributes.get('aria-disabled'), 'true');
  assert.match(harness.chatTabContextFork.title, /Wait for Hermes to finish/);
});

test('getNextBranchTitle follows Hermes lineage numbering semantics', () => {
  const harness = buildHarness();
  harness.chats.set(19, { id: 19, title: '[bug]Current #2', is_pinned: false });
  harness.pinnedChats.set(21, { id: 21, title: '[bug]Current #3', is_pinned: true });

  assert.equal(harness.controller.getNextBranchTitle('Current'), 'Current #4');
  assert.equal(harness.controller.getNextBranchTitle('Current #2'), 'Current #4');
});

test('handleTabOverflowTriggerClick opens/toggles for any chat tab when the feature is enabled', () => {
  const harness = buildHarness();
  const trigger = {
    closest(selector) {
      if (selector === '[data-chat-tab-menu-trigger]') return this;
      if (selector === '.chat-tab') return { dataset: { chatId: '7' } };
      return null;
    },
    getBoundingClientRect() {
      return { right: 100, bottom: 80 };
    },
  };
  const event = {
    target: trigger,
    prevented: false,
    stopped: false,
    preventDefault() {
      this.prevented = true;
    },
    stopPropagation() {
      this.stopped = true;
    },
  };

  harness.controller.handleTabOverflowTriggerClick(event);
  assert.equal(event.prevented, true);
  assert.equal(event.stopped, true);
  assert.equal(harness.chatTabContextMenu.hidden, false);

  harness.controller.handleTabOverflowTriggerClick(event);
  assert.equal(harness.chatTabContextMenu.hidden, true);

  const inactiveTrigger = {
    closest(selector) {
      if (selector === '[data-chat-tab-menu-trigger]') return this;
      if (selector === '.chat-tab') return { dataset: { chatId: '11' } };
      return null;
    },
    getBoundingClientRect() {
      return { right: 120, bottom: 84 };
    },
  };
  harness.controller.handleTabOverflowTriggerClick({ target: inactiveTrigger, preventDefault() {}, stopPropagation() {} });
  assert.equal(harness.chatTabContextMenu.hidden, false);
});

test('tab-context fork and global-dismiss handlers close menu and preserve inside clicks', async () => {
  const menuTarget = {};
  const harness = buildHarness({
    chatTabContextMenu: {
      hidden: true,
      style: { left: '', top: '' },
      contains(target) {
        return target === menuTarget;
      },
    },
  });

  harness.controller.openChatTabContextMenu(7, 40, 40);
  await harness.controller.handleTabContextForkClick({ preventDefault() {} });
  assert.equal(harness.chatTabContextMenu.hidden, true);
  assert.equal(harness.apiCalls.at(-1).path, '/api/chats/branch');

  harness.controller.openChatTabContextMenu(7, 40, 40);
  harness.controller.handleGlobalChatContextMenuDismiss({ target: menuTarget });
  assert.equal(harness.chatTabContextMenu.hidden, false);
  harness.controller.handleGlobalChatContextMenuDismiss({ target: {} });
  assert.equal(harness.chatTabContextMenu.hidden, true);
});
