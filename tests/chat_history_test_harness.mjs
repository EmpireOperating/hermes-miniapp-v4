import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const chatHistory = require('../static/chat_history_helpers.js');
const runtimeHistory = require('../static/runtime_history_helpers.js');

function buildHarness(overrides = {}) {
  const histories = new Map();
  const chats = new Map([[7, { id: 7, unread_count: 2, pending: false }]]);
  const prefetchingHistories = new Set();
  const upsertedChats = [];
  const activeMeta = [];
  const renderedMessages = [];
  const refreshedTabs = [];
  const resumedChats = [];
  const apiCalls = [];
  const renderTraceLogs = [];
  const persistedSnapshots = [];
  const clearedSnapshots = [];
  const markReadCalls = [];
  const statusSyncCalls = [];
  const pinnedStatusSyncCalls = [];
  let renderPinnedChatsCalls = 0;
  const resumeVisibilityChecks = [];
  const restoredSnapshots = [];
  const abortedStreamChats = [];
  const markReadInFlight = new Set();
  const unseenStreamChats = new Set();
  const finalizedHydratedPendingChats = [];
  const renderedAssistantNodes = [];
  const messagesContainer = {
    scrollTop: 0,
    clientHeight: 0,
    appendedNodes: [],
    appendChild(node) {
      this.appendedNodes.push(node);
      return node;
    },
    querySelectorAll: (selector) => {
      if (selector === '.message[data-role="assistant"]:not(.message--pending), .message[data-role="hermes"]:not(.message--pending)') {
        return renderedAssistantNodes;
      }
      return [];
    },
  };
  const roleNode = { textContent: '' };
  const timeNode = { textContent: '' };
  const bodyNode = {};
  const systemMessageNode = {
    classList: { add() {} },
    querySelector(selector) {
      if (selector === '.message__role') return roleNode;
      if (selector === '.message__time') return timeNode;
      if (selector === '.message__body') return bodyNode;
      return null;
    },
  };
  const template = {
    content: {
      firstElementChild: {
        cloneNode() {
          return systemMessageNode;
        },
      },
    },
  };
  const pendingChats = new Set([7]);
  let renderTabsCalls = 0;
  let syncActivePendingStatusCalls = 0;
  let updateComposerStateCalls = 0;
  let isNearBottom = true;
  let isAuthenticated = true
  let lastOpenChatRequestId = 0;
  let activeChatId = 7;
  let nowMsValue = 1000;

  const deps = {
    apiPost: async (path, payload) => {
      apiCalls.push({ path, payload });
      if (path === '/api/chats/history') {
        return {
          chat: { id: Number(payload.chat_id), pending: false },
          history: [{ id: 1, role: 'assistant', body: 'hello' }],
        };
      }
      if (path === '/api/chats/open') {
        return {
          chat: { id: Number(payload.chat_id), pending: false },
          history: [{ id: 2, role: 'assistant', body: 'opened' }],
        };
      }
      if (path === '/api/chats/mark-read') {
        markReadCalls.push(Number(payload.chat_id));
        return {
          chat: { id: Number(payload.chat_id), pending: false, unread_count: 0 },
        };
      }
      if (path === '/api/chats/status') {
        return {
          chats: [{ id: 7, unread_count: 1 }],
          pinned_chats: [{ id: 9, unread_count: 0 }],
        };
      }
      throw new Error(`unexpected ${path}`);
    },
    histories,
    chats,
    prefetchingHistories,
    upsertChat: (chat) => {
      upsertedChats.push(chat);
      const key = Number(chat?.id || 0);
      if (key > 0 && chat && typeof chat === 'object') {
        chats.set(key, { ...(chats.get(key) || {}), ...chat });
      }
    },
    setActiveChatMeta: (chatId, options = {}) => activeMeta.push({ chatId: Number(chatId), options }),
    renderMessages: (chatId, options = {}) => renderedMessages.push({ chatId: Number(chatId), options }),
    hasLiveStreamController: () => false,
    abortStreamController: (chatId) => {
      abortedStreamChats.push(Number(chatId));
    },
    mergeHydratedHistory: ({ nextHistory }) => nextHistory,
    refreshTabNode: (chatId) => refreshedTabs.push(Number(chatId)),
    getActiveChatId: () => activeChatId,
    resumePendingChatStream: (chatId, options = {}) => resumedChats.push({ chatId: Number(chatId), options }),
    messagesEl: messagesContainer,
    template,
    nowStamp: () => '10:45',
    renderBody: (_container, text) => {
      bodyNode.textContent = String(text);
    },
    getLastOpenChatRequestId: () => lastOpenChatRequestId,
    setLastOpenChatRequestId: (value) => { lastOpenChatRequestId = Number(value); },
    scheduleTimeout: (callback) => callback(),
    requestIdle: null,
    runAfterUiMutation: (callback) => callback(),
    renderTraceLog: (eventName, details = null) => {
      renderTraceLogs.push({ eventName, details });
    },
    nowMs: () => {
      nowMsValue += 5;
      return nowMsValue;
    },
    getIsAuthenticated: () => isAuthenticated,
    isNearBottomFn: () => isNearBottom,
    messagesContainer,
    unseenStreamChats,
    markReadInFlight,
    renderTabs: () => {
      renderTabsCalls += 1;
    },
    syncChats: (items) => {
      statusSyncCalls.push(items);
    },
    syncPinnedChats: (items) => {
      pinnedStatusSyncCalls.push(items);
    },
    renderPinnedChats: () => {
      renderPinnedChatsCalls += 1;
    },
    syncActivePendingStatus: () => {
      syncActivePendingStatusCalls += 1;
    },
    updateComposerState: () => {
      updateComposerStateCalls += 1;
    },
    pendingChats,
    finalizeHydratedPendingState: (chatId) => {
      const key = Number(chatId);
      finalizedHydratedPendingChats.push(key);
      pendingChats.delete(key);
      const chat = chats.get(key);
      if (chat && typeof chat === 'object') {
        chat.pending = false;
      }
    },
    restorePendingStreamSnapshot: (chatId) => {
      restoredSnapshots.push(Number(chatId));
      return false;
    },
    hasFreshPendingStreamSnapshot: () => false,
    persistPendingStreamSnapshot: (chatId) => {
      persistedSnapshots.push(Number(chatId));
      return true;
    },
    clearPendingStreamSnapshot: (chatId) => {
      clearedSnapshots.push(Number(chatId));
      return true;
    },
    shouldResumeOnVisibilityChange: (args) => {
      resumeVisibilityChecks.push(args);
      return false;
    },
    ...overrides,
  };

  return {
    controller: chatHistory.createController(deps),
    histories,
    chats,
    prefetchingHistories,
    upsertedChats,
    activeMeta,
    renderedMessages,
    refreshedTabs,
    resumedChats,
    apiCalls,
    renderTraceLogs,
    persistedSnapshots,
    clearedSnapshots,
    markReadCalls,
    statusSyncCalls,
    pinnedStatusSyncCalls,
    resumeVisibilityChecks,
    restoredSnapshots,
    abortedStreamChats,
    markReadInFlight,
    unseenStreamChats,
    messagesContainer,
    pendingChats,
    finalizedHydratedPendingChats,
    renderedAssistantNodes,
    getRenderTabsCalls: () => renderTabsCalls,
    getRenderPinnedChatsCalls: () => renderPinnedChatsCalls,
    getSyncActivePendingStatusCalls: () => syncActivePendingStatusCalls,
    getUpdateComposerStateCalls: () => updateComposerStateCalls,
    setActiveChatId: (value) => { activeChatId = Number(value); },
    setIsNearBottom: (value) => { isNearBottom = Boolean(value); },
    setRenderedAssistantNodes: (nodes) => {
      renderedAssistantNodes.splice(0, renderedAssistantNodes.length, ...nodes);
    },
    setMessageViewport: ({ scrollTop = messagesContainer.scrollTop, clientHeight = messagesContainer.clientHeight } = {}) => {
      messagesContainer.scrollTop = Number(scrollTop);
      messagesContainer.clientHeight = Number(clientHeight);
    },
    setIsAuthenticated: (value) => { isAuthenticated = Boolean(value); },
  };
}


function buildMetaHarness() {
  const chatScrollTop = new Map();
  const chatStickToBottom = new Map();
  const chats = new Map([
    [3, { id: 3, title: 'Current chat' }],
    [7, { id: 7, title: 'Target chat' }],
    [8, { id: 8, title: 'Second target chat' }],
  ]);
  let activeChatId = 3;
  let renderedChatId = 3;
  const promptEl = { value: 'draft text' };
  const activeChatName = { textContent: '' };
  const panelTitle = { textContent: '' };
  const historyCount = { textContent: '' };
  const messagesEl = {
    scrollTop: 42,
    innerHTML: '<existing />',
    appendChild(node) {
      this.lastAppendedNode = node;
    },
  };

  const roleNode = { textContent: '' };
  const timeNode = { textContent: '' };
  const bodyNode = {};
  const cloneNode = {
    classList: { add() {} },
    querySelector(selector) {
      if (selector === '.message__role') return roleNode;
      if (selector === '.message__time') return timeNode;
      if (selector === '.message__body') return bodyNode;
      return null;
    },
  };
  const template = {
    content: {
      firstElementChild: {
        cloneNode() {
          return cloneNode;
        },
      },
    },
  };

  const calls = {
    setDraft: [],
    renderBody: [],
    updateComposerState: 0,
    syncPinChatButton: 0,
    renderTabs: 0,
    syncActiveTabSelection: [],
    syncLiveToolStreamForChat: [],
    syncActivePendingStatus: 0,
    syncActiveLatencyChip: 0,
    updateJumpLatestVisibility: 0,
    scheduleTimeout: [],
  };

  const controller = chatHistory.createMetaController({
    getActiveChatId: () => activeChatId,
    setActiveChatId: (value) => {
      activeChatId = value == null ? null : Number(value);
    },
    getRenderedChatId: () => renderedChatId,
    setRenderedChatId: (value) => {
      renderedChatId = value == null ? null : Number(value);
    },
    chatScrollTop,
    chatStickToBottom,
    messagesEl,
    isNearBottomFn: () => true,
    setDraft: (chatId, value) => calls.setDraft.push({ chatId: Number(chatId), value }),
    promptEl,
    activeChatName,
    panelTitle,
    template,
    nowStamp: () => '10:30',
    renderBody: (_container, text) => calls.renderBody.push(String(text)),
    historyCount,
    updateComposerState: () => {
      calls.updateComposerState += 1;
    },
    syncPinChatButton: () => {
      calls.syncPinChatButton += 1;
    },
    renderTabs: () => {
      calls.renderTabs += 1;
    },
    syncActiveTabSelection: (previousChatId, nextChatId) => {
      calls.syncActiveTabSelection.push({ previousChatId, nextChatId });
    },
    syncLiveToolStreamForChat: (chatId) => {
      calls.syncLiveToolStreamForChat.push(chatId == null ? null : Number(chatId));
    },
    syncActivePendingStatus: () => {
      calls.syncActivePendingStatus += 1;
    },
    syncActiveLatencyChip: () => {
      calls.syncActiveLatencyChip += 1;
    },
    updateJumpLatestVisibility: () => {
      calls.updateJumpLatestVisibility += 1;
    },
    getDraft: (chatId) => (Number(chatId) === 7 ? 'saved draft' : ''),
    chats,
    scheduleTimeout: (callback, delay) => {
      calls.scheduleTimeout.push({ callback, delay });
    },
  });

  return {
    controller,
    calls,
    chatScrollTop,
    chatStickToBottom,
    promptEl,
    activeChatName,
    panelTitle,
    historyCount,
    messagesEl,
    getActiveChatId: () => activeChatId,
    getRenderedChatId: () => renderedChatId,
    roleNode,
    timeNode,
  };
}


export { buildHarness, buildMetaHarness, runtimeHistory };
