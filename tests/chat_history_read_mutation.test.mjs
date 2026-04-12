import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { buildHarness } from './chat_history_test_harness.mjs';

const require = createRequire(import.meta.url);
const chatHistory = require('../static/chat_history_helpers.js');

test('unread preservation helper keeps local activation unread until threshold is satisfied', () => {
  const chats = new Map([[7, { id: 7, unread_count: 3, newest_unread_message_id: 22 }]]);
  const unreadStateController = {
    buildChatPreservingUnread: (chat) => ({ ...chat }),
  };
  const thresholdController = {
    hasActivationReadThreshold: (chatId) => Number(chatId) === 7,
    hasReachedNewestUnreadMessageBottom: () => false,
  };
  const helper = chatHistory.createUnreadPreservationController(
    { chats, getActiveChatId: () => 7 },
    unreadStateController,
    thresholdController,
  );

  const nextChat = helper.buildChatPreservingUnread({ id: 7, unread_count: 1, newest_unread_message_id: 11 }, { preserveActivationUnread: true });

  assert.equal(nextChat.unread_count, 3);
  assert.equal(nextChat.newest_unread_message_id, 22);
});

test('addLocalMessage and updatePendingAssistant mutate chat history in place', () => {
  const harness = buildHarness();

  harness.controller.addLocalMessage(7, { role: 'user', body: 'hello' });
  harness.controller.updatePendingAssistant(7, 'streaming', true);
  harness.controller.updatePendingAssistant(7, 'done', false);

  const history = harness.histories.get(7) || [];
  assert.equal(history.length, 2);
  assert.deepEqual(history[0], { role: 'user', body: 'hello' });
  assert.equal(history[1].role, 'hermes');
  assert.equal(history[1].body, 'done');
  assert.equal(history[1].pending, false);
});

test('updatePendingAssistant reuses pending assistant role from hydrated history instead of appending duplicate hermes message', () => {
  const harness = buildHarness();
  harness.histories.set(7, [
    { role: 'assistant', body: 'partial', pending: true, created_at: '2026-04-04T12:00:00Z' },
  ]);

  harness.controller.updatePendingAssistant(7, 'completed', false);

  const history = harness.histories.get(7) || [];
  assert.equal(history.length, 1);
  assert.equal(history[0].role, 'assistant');
  assert.equal(history[0].body, 'completed');
  assert.equal(history[0].pending, false);
});

test('updatePendingAssistant skips empty finalized writes without pending message', () => {
  const harness = buildHarness();

  harness.controller.updatePendingAssistant(7, '   ', false);

  assert.equal((harness.histories.get(7) || []).length, 0);
  assert.deepEqual(harness.persistedSnapshots, []);
  assert.deepEqual(harness.clearedSnapshots, []);
});

test('updatePendingAssistant persists and clears pending stream snapshots inside helper ownership', () => {
  const harness = buildHarness();

  harness.controller.updatePendingAssistant(7, 'streaming', true);
  harness.controller.updatePendingAssistant(7, 'completed', false);

  assert.deepEqual(harness.persistedSnapshots, [7, 7]);
  assert.deepEqual(harness.clearedSnapshots, [7]);
});

test('appendSystemMessage appends inline system card when no active chat is selected', () => {
  const harness = buildHarness();
  harness.setActiveChatId(0);

  harness.controller.appendSystemMessage('Waiting for sign-in');

  assert.equal(harness.messagesContainer.appendedNodes.length, 1);
  assert.equal(harness.messagesContainer.appendedNodes[0].querySelector('.message__role').textContent, 'system');
  assert.equal(harness.messagesContainer.appendedNodes[0].querySelector('.message__time').textContent, '10:45');
  assert.equal(harness.messagesContainer.appendedNodes[0].querySelector('.message__body').textContent, 'Waiting for sign-in');
});

test('appendSystemMessage stores active-chat system notice in history and rerenders active chat', () => {
  const harness = buildHarness();

  harness.controller.appendSystemMessage('Resume failed');

  const history = harness.histories.get(7) || [];
  assert.equal(history.length, 1);
  assert.equal(history[0].role, 'system');
  assert.equal(history[0].body, 'Resume failed');
  assert.equal(harness.renderedMessages.at(-1)?.chatId, 7);
});

test('appendSystemMessage can target a non-active chat without rerendering the active view', () => {
  const harness = buildHarness();

  harness.controller.appendSystemMessage('Refactor failed', 8);

  const targetHistory = harness.histories.get(8) || [];
  assert.equal(targetHistory.length, 1);
  assert.equal(targetHistory[0].role, 'system');
  assert.equal(targetHistory[0].body, 'Refactor failed');
  assert.equal(harness.histories.get(7), undefined);
  assert.equal(harness.renderedMessages.length, 0);
});

test('sync and schedule active message view only render active chat', () => {
  const mutations = [];
  const harness = buildHarness({
    runAfterUiMutation: (callback) => {
      mutations.push('queued');
      callback();
    },
  });

  harness.controller.syncActiveMessageView(8, { preserveViewport: true });
  harness.controller.syncActiveMessageView(7, { preserveViewport: true });
  harness.controller.scheduleActiveMessageView(8);
  harness.controller.scheduleActiveMessageView(7);

  assert.deepEqual(harness.renderedMessages, [
    { chatId: 7, options: { preserveViewport: true } },
    { chatId: 7, options: { preserveViewport: true } },
  ]);
  assert.deepEqual(mutations, ['queued']);
});

test('markRead syncs unread state and active-chat composer status', async () => {
  const harness = buildHarness();

  await harness.controller.markRead(7);

  assert.deepEqual(harness.apiCalls.at(-1), {
    path: '/api/chats/mark-read',
    payload: { chat_id: 7 },
  });
  assert.equal(harness.upsertedChats.length, 1);
  assert.equal(harness.getRenderTabsCalls(), 1);
  assert.equal(harness.getSyncActivePendingStatusCalls(), 1);
  assert.equal(harness.getUpdateComposerStateCalls(), 1);
});

test('markRead skips active-chat UI sync when target chat is inactive', async () => {
  const harness = buildHarness();
  harness.setActiveChatId(99);

  await harness.controller.markRead(7);

  assert.equal(harness.getRenderTabsCalls(), 1);
  assert.equal(harness.getSyncActivePendingStatusCalls(), 0);
  assert.equal(harness.getUpdateComposerStateCalls(), 0);
});

test('maybeMarkRead enforces active/auth/visibility gating before calling markRead', async () => {
  const nearBottomCalls = [];
  let isAuthenticated = true;
  const harness = buildHarness({
    getIsAuthenticated: () => isAuthenticated,
    isNearBottomFn: (container, threshold) => {
      nearBottomCalls.push({ container, threshold });
      return true;
    },
  });

  isAuthenticated = false;
  harness.controller.maybeMarkRead(7);
  isAuthenticated = true;

  harness.setActiveChatId(8);
  harness.controller.maybeMarkRead(7);
  harness.setActiveChatId(7);

  harness.setIsNearBottom(false);
  harness.controller.maybeMarkRead(7);
  harness.setIsNearBottom(true);

  harness.unseenStreamChats.add(7);
  harness.controller.maybeMarkRead(7);
  harness.unseenStreamChats.clear();

  harness.chats.get(7).unread_count = 0;
  harness.controller.maybeMarkRead(7);

  harness.markReadCalls.length = 0;
  harness.chats.get(7).unread_count = 2;
  harness.controller.maybeMarkRead(7);
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(harness.markReadCalls.length, 1);
  assert.deepEqual(harness.markReadCalls, [7]);
  assert.ok(nearBottomCalls.length >= 2);
  assert.deepEqual(nearBottomCalls[0], { container: harness.messagesContainer, threshold: 40 });
});

test('maybeMarkRead force mode bypasses near-bottom/unread gates', async () => {
  const harness = buildHarness({
    isNearBottomFn: () => false,
  });

  harness.chats.get(7).unread_count = 0;
  harness.controller.maybeMarkRead(7, { force: true });
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.deepEqual(harness.markReadCalls, [7]);
});

test('maybeMarkRead waits for the bottom of the anchored newest unread assistant message, not generic chat bottom proximity', async () => {
  const nearBottomCalls = [];
  const harness = buildHarness({
    isNearBottomFn: (container, threshold) => {
      nearBottomCalls.push({ container, threshold });
      return true;
    },
  });

  harness.chats.get(7).unread_count = 1;
  harness.chats.get(7).newest_unread_message_id = 22;
  harness.setRenderedAssistantNodes([
    { dataset: { messageId: '11' }, offsetTop: 120, offsetHeight: 80 },
    { dataset: { messageId: '22' }, offsetTop: 420, offsetHeight: 140 },
  ]);
  harness.setMessageViewport({ scrollTop: 240, clientHeight: 240 });

  harness.controller.maybeMarkRead(7);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(harness.markReadCalls, []);

  harness.setMessageViewport({ scrollTop: 300, clientHeight: 240 });
  harness.controller.maybeMarkRead(7);
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.deepEqual(harness.markReadCalls, [7]);
  assert.deepEqual(nearBottomCalls, []);
});


test('maybeMarkRead does not consume unread when the anchored unread message is still missing from the DOM', async () => {
  const nearBottomCalls = [];
  const harness = buildHarness({
    isNearBottomFn: (container, threshold) => {
      nearBottomCalls.push({ container, threshold });
      return true;
    },
  });

  harness.chats.get(7).unread_count = 1;
  harness.chats.get(7).newest_unread_message_id = 22;
  harness.setRenderedAssistantNodes([
    { dataset: { messageId: '11' }, offsetTop: 420, offsetHeight: 140 },
  ]);
  harness.setMessageViewport({ scrollTop: 1000, clientHeight: 240 });

  harness.controller.maybeMarkRead(7);
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.deepEqual(harness.markReadCalls, []);
  assert.deepEqual(nearBottomCalls, []);
});

test('maybeMarkRead falls back to generic near-bottom gating when newest unread message cannot be measured', async () => {
  const nearBottomCalls = [];
  const harness = buildHarness({
    isNearBottomFn: (container, threshold) => {
      nearBottomCalls.push({ container, threshold });
      return true;
    },
  });

  harness.chats.get(7).unread_count = 1;
  harness.setRenderedAssistantNodes([{ offsetTop: Number.NaN, offsetHeight: Number.NaN }]);
  harness.controller.maybeMarkRead(7);
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.deepEqual(harness.markReadCalls, [7]);
  assert.deepEqual(nearBottomCalls, [{ container: harness.messagesContainer, threshold: 40 }]);
});

test('maybeMarkRead clears unread optimistically as soon as bottom-threshold read sync starts', async () => {
  let resolveMarkRead;
  const markReadStarted = new Promise((resolve) => {
    resolveMarkRead = resolve;
  });
  let releaseMarkRead;
  const markReadSettled = new Promise((resolve) => {
    releaseMarkRead = resolve;
  });

  const harness = buildHarness({
    apiPost: async (path, payload) => {
      if (path === '/api/chats/mark-read') {
        resolveMarkRead();
        await markReadSettled;
        return {
          chat: { id: Number(payload.chat_id), pending: false, unread_count: 0 },
        };
      }
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
      throw new Error(`unexpected ${path}`);
    },
  });

  harness.chats.get(7).unread_count = 2;
  harness.controller.maybeMarkRead(7);
  await markReadStarted;

  assert.equal(harness.chats.get(7).unread_count, 0);
  assert.equal(harness.getRenderTabsCalls(), 1);

  releaseMarkRead();
  await markReadSettled;
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(harness.chats.get(7).unread_count, 0);
  assert.equal(harness.getRenderTabsCalls(), 2);
});

test('maybeMarkRead preserves local pending when mark-read response is stale during a live stream', async () => {
  const harness = buildHarness({
    hasLiveStreamController: (chatId) => Number(chatId) === 7,
    apiPost: async (path, payload) => {
      if (path === '/api/chats/mark-read') {
        harness.markReadCalls.push(Number(payload.chat_id));
        return {
          chat: { id: Number(payload.chat_id), pending: false, unread_count: 0 },
        };
      }
      throw new Error(`unexpected ${path}`);
    },
  });

  harness.chats.set(7, { id: 7, unread_count: 2, pending: true });
  harness.pendingChats.add(7);
  harness.controller.maybeMarkRead(7, { force: true });

  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.deepEqual(harness.markReadCalls, [7]);
  assert.deepEqual(harness.upsertedChats, [{ id: 7, pending: true, unread_count: 0 }]);
});

test('maybeMarkRead retries once after in-flight call settles when a second intent arrived', async () => {
  let resolveFirstMarkRead;
  let markReadCallCount = 0;
  const markReadStarted = [];
  const firstMarkReadPromise = new Promise((resolve) => {
    resolveFirstMarkRead = resolve;
  });

  const harness = buildHarness({
    apiPost: async (path, payload) => {
      if (path === '/api/chats/mark-read') {
        markReadCallCount += 1;
        markReadStarted.push(Number(payload.chat_id));
        if (markReadCallCount === 1) {
          await firstMarkReadPromise;
        }
        return {
          chat: { id: Number(payload.chat_id), pending: false, unread_count: 0 },
        };
      }
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
      throw new Error(`unexpected ${path}`);
    },
  });

  harness.chats.get(7).unread_count = 2;
  harness.controller.maybeMarkRead(7);
  harness.controller.maybeMarkRead(7);

  assert.deepEqual(markReadStarted, [7]);
  assert.equal(harness.markReadInFlight.has(7), true);

  resolveFirstMarkRead();
  await firstMarkReadPromise;
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.deepEqual(markReadStarted, [7, 7]);
  assert.equal(harness.markReadInFlight.has(7), false);
});

test('maybeMarkRead clears in-flight state when markRead fails', async () => {
  const harness = buildHarness({
    apiPost: async (path) => {
      if (path === '/api/chats/mark-read') {
        throw new Error('mark-read failed');
      }
      throw new Error(`unexpected ${path}`);
    },
  });

  harness.controller.maybeMarkRead(7, { force: true });
  assert.equal(harness.markReadInFlight.has(7), true);

  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(harness.markReadInFlight.has(7), false);
});

test('maybeMarkRead restores unread dot if optimistic mark-read sync fails', async () => {
  const harness = buildHarness({
    apiPost: async (path) => {
      if (path === '/api/chats/mark-read') {
        throw new Error('mark-read failed');
      }
      throw new Error(`unexpected ${path}`);
    },
  });

  harness.chats.get(7).unread_count = 2;
  harness.controller.maybeMarkRead(7);

  assert.equal(harness.chats.get(7).unread_count, 0);

  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(harness.chats.get(7).unread_count, 2);
  assert.equal(harness.getRenderTabsCalls(), 2);
});

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

