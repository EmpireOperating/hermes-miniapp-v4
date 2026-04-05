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
  const chatTabContextMenu = overrides.chatTabContextMenu || {
    hidden: true,
    style: { left: '', top: '' },
    contains() {
      return false;
    },
  };
  const chatTabContextFork = overrides.chatTabContextFork || {
    disabled: false,
    title: '',
    attributes: new Map(),
    setAttribute(name, value) {
      this.attributes.set(name, value);
    },
  };
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
  const setNoActiveCalls = [];
  const syncPinCalls = [];
  const promptCalls = [];
  const latencyMutationCalls = [];
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
    setNoActiveChatMeta: () => {
      activeChatId = null;
      setNoActiveCalls.push('none');
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
    chatTabContextMenu,
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
    setActiveCalls,
    setNoActiveCalls,
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
});

test('removeActiveChat keeps silent-close semantics and preserves removed pinned chats for reopen', async () => {
  const harness = buildHarness();

  await harness.controller.removeActiveChat();

  assert.deepEqual(harness.apiCalls[0], {
    path: '/api/chats/remove',
    payload: { chat_id: 7, allow_empty: true },
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
    payload: { chat_id: 7, allow_empty: true },
  });
  assert.equal(harness.pinnedChats.has(7), true);
  assert.deepEqual(harness.setActiveCalls, [9]);
  assert.deepEqual(harness.renderedPinnedChats, ['pinned']);
  assert.deepEqual(harness.renderedMessages, [9]);
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
    payload: { chat_id: 7, allow_empty: true },
  });
  assert.deepEqual(harness.setNoActiveCalls, ['none']);
  assert.deepEqual(harness.setActiveCalls, []);
  assert.deepEqual(harness.renderedMessages, []);
  assert.deepEqual(harness.renderedPinnedChats, ['pinned']);
});

test('forkChatFrom clones chat history into a new active fork', async () => {
  const harness = buildHarness();

  await harness.controller.forkChatFrom(7);

  assert.deepEqual(harness.apiCalls[0], {
    path: '/api/chats/fork',
    payload: { chat_id: 7, title: '[bug]Current (fork)' },
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
    /Wait for Hermes to finish before forking this chat\./,
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
    /Wait for Hermes to finish before forking this chat\./,
  );

  assert.deepEqual(harness.apiCalls, []);
  assert.equal(harness.histories.has(19), false);
  assert.deepEqual(harness.setActiveCalls, []);
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

test('chat tab context menu open/close clamps viewport coordinates', () => {
  const harness = buildHarness({
    windowObject: { innerWidth: 210, innerHeight: 120 },
  });

  harness.controller.openChatTabContextMenu(7, 999, 999);
  assert.equal(harness.chatTabContextMenu.hidden, false);
  assert.equal(harness.chatTabContextFork.disabled, false);
  assert.equal(harness.chatTabContextFork.attributes.get('aria-disabled'), 'false');
  assert.equal(harness.chatTabContextMenu.style.left, '30px');
  assert.equal(harness.chatTabContextMenu.style.top, '68px');

  harness.controller.closeChatTabContextMenu();
  assert.equal(harness.chatTabContextMenu.hidden, true);
});

test('chat tab context menu stays hidden and disables fork action for pending chats', () => {
  const harness = buildHarness();
  harness.chats.set(7, { ...harness.chats.get(7), pending: true });

  harness.controller.openChatTabContextMenu(7, 40, 40);

  assert.equal(harness.chatTabContextMenu.hidden, true);
  assert.equal(harness.chatTabContextFork.disabled, true);
  assert.equal(harness.chatTabContextFork.attributes.get('aria-disabled'), 'true');
  assert.match(harness.chatTabContextFork.title, /Wait for Hermes to finish/);
});

test('handleTabOverflowTriggerClick opens/toggles only for active chat tab', () => {
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
  };
  harness.controller.handleTabOverflowTriggerClick({ target: inactiveTrigger, preventDefault() {}, stopPropagation() {} });
  assert.equal(harness.chatTabContextMenu.hidden, true);
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
  assert.equal(harness.apiCalls.at(-1).path, '/api/chats/fork');

  harness.controller.openChatTabContextMenu(7, 40, 40);
  harness.controller.handleGlobalChatContextMenuDismiss({ target: menuTarget });
  assert.equal(harness.chatTabContextMenu.hidden, false);
  harness.controller.handleGlobalChatContextMenuDismiss({ target: {} });
  assert.equal(harness.chatTabContextMenu.hidden, true);
});
