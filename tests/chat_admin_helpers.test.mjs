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
  const chats = new Map([
    [7, { id: 7, title: '[bug]Current', is_pinned: true }],
  ]);
  const pinnedChats = new Map([
    [7, { id: 7, title: '[bug]Current', is_pinned: true }],
    [11, { id: 11, title: 'Pinned only', is_pinned: true }],
  ]);
  const histories = new Map([[7, [{ id: 1, body: 'old' }]]]);
  const pendingChats = new Set();
  const latencyByChat = new Map([[7, '123ms']]);
  const streamPhaseByChat = new Map([[7, 'streaming']]);
  const unseenStreamChats = new Set([7]);
  const settingsModal = overrides.settingsModal || createModal();
  const chatTitleModal = overrides.chatTitleModal || createModal();
  const chatTitleForm = overrides.chatTitleForm || createEventTarget();
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
  const setActiveCalls = [];
  const syncPinCalls = [];
  const promptCalls = [];
  const latencyMutationCalls = [];
  let activeChatId = 7;

  const controller = chatAdmin.createController({
    windowObject: {
      prompt(message, defaultValue) {
        promptCalls.push([message, defaultValue]);
        return null;
      },
      setTimeout(callback) {
        callback();
        return 1;
      },
    },
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
          pinned_chats: [],
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
      if (path === '/api/chats/fork') {
        return {
          chat: { id: 19, title: payload.title || 'Current (fork)', is_pinned: false },
          active_chat_id: 19,
          history: [{ id: 200, body: 'old' }],
          chats: [
            { id: 7, title: '[bug]Current', is_pinned: true },
            { id: 19, title: payload.title || 'Current (fork)', is_pinned: false },
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
    renderMessages: (chatId) => renderedMessages.push(Number(chatId)),
    renderTabs: () => renderedTabs.push('tabs'),
    renderPinnedChats: () => renderedPinnedChats.push('pinned'),
    syncPinChatButton: () => syncPinCalls.push('pin'),
    chatLabel: (chatId) => chats.get(Number(chatId))?.title || `Chat ${chatId}`,
    getActiveChatId: () => activeChatId,
    openChat: async (chatId) => {
      openChatCalls.push(Number(chatId));
    },
    onLatencyByChatMutated: (mapRef) => {
      latencyMutationCalls.push(new Map(mapRef));
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
    setActiveCalls,
    syncPinCalls,
    promptCalls,
    latencyMutationCalls,
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

test('createChat uses modal title and hydrates the new active chat', async () => {
  const harness = buildHarness({
    chatTitleModal: null,
    chatTitleForm: null,
    chatTitleInput: null,
    chatTitleHint: null,
    chatTitleConfirm: null,
    chatTitleCancel: null,
    windowObject: {
      prompt(message) {
        return message.includes('New chat') ? 'Launch plan' : null;
      },
    },
  });

  await harness.controller.createChat();

  assert.deepEqual(harness.apiCalls[0], {
    path: '/api/chats',
    payload: { title: 'Launch plan' },
  });
  assert.deepEqual(harness.histories.get(13), [{ id: 5, body: 'new history' }]);
  assert.deepEqual(harness.setActiveCalls, [13]);
  assert.deepEqual(harness.renderedMessages, [13]);
});

test('removeActiveChat keeps silent-close semantics and restores pinned snapshot state', async () => {
  const harness = buildHarness();

  await harness.controller.removeActiveChat();

  assert.deepEqual(harness.apiCalls[0], {
    path: '/api/chats/remove',
    payload: { chat_id: 7 },
  });
  assert.equal(harness.histories.has(7), false);
  assert.deepEqual(harness.histories.get(9), [{ id: 99, body: 'fresh' }]);
  assert.equal(harness.pinnedChats.get(7)?.is_pinned, true);
  assert.deepEqual(harness.clearedStreamState.map((entry) => entry.chatId), [7]);
  assert.equal(harness.latencyByChat.has(7), false);
  assert.equal(harness.latencyMutationCalls.length, 1);
  assert.equal(harness.latencyMutationCalls[0].has(7), false);
  assert.deepEqual(harness.setActiveCalls, [9]);
  assert.deepEqual(harness.renderedPinnedChats, ['pinned']);
  assert.deepEqual(harness.renderedMessages, [9]);
});

test('openPinnedChat reopens missing pinned chats before delegating to openChat', async () => {
  const harness = buildHarness();

  await harness.controller.openPinnedChat(11);

  assert.deepEqual(harness.apiCalls[0], {
    path: '/api/chats/reopen',
    payload: { chat_id: 11 },
  });
  assert.deepEqual(harness.renderedTabs, ['tabs']);
  assert.deepEqual(harness.renderedPinnedChats, ['pinned']);
  assert.deepEqual(harness.openChatCalls, [11]);
});

test('forkChatFrom clones selected chat into a new active tab and hydrates history', async () => {
  const harness = buildHarness();

  await harness.controller.forkChatFrom(7);

  assert.deepEqual(harness.apiCalls[0], {
    path: '/api/chats/fork',
    payload: { chat_id: 7, title: '[bug]Current (fork)' },
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
