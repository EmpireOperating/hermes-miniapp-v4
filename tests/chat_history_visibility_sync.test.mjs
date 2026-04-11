import test from 'node:test';
import assert from 'node:assert/strict';
import { buildHarness, runtimeHistory } from './chat_history_test_harness.mjs';

test('syncVisibleActiveChat hydrates active history and resumes pending streams when resume conditions match', async () => {
  const streamAbortControllers = new Map();
  const visibilityChecks = [];
  const harness = buildHarness({
    shouldResumeOnVisibilityChange: (args) => {
      visibilityChecks.push(args);
      return true;
    },
  });

  await harness.controller.syncVisibleActiveChat({
    hidden: false,
    streamAbortControllers,
  });
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.deepEqual(harness.histories.get(7), [{ id: 1, role: 'assistant', body: 'hello' }]);
  assert.deepEqual(harness.renderedMessages.at(-1), { chatId: 7, options: { preserveViewport: true } });
  assert.deepEqual(visibilityChecks.at(-1), {
    hidden: false,
    activeChatId: 7,
    pendingChats: harness.pendingChats,
    streamAbortControllers,
  });
  assert.deepEqual(harness.resumedChats, [{ chatId: 7, options: {} }]);
  assert.deepEqual(harness.markReadCalls, []);
});

test('syncVisibleActiveChat resumes when server still reports pending and there is no live stream', async () => {
  const harness = buildHarness({
    shouldResumeOnVisibilityChange: () => false,
    apiPost: async (path, payload) => {
      harness.apiCalls.push({ path, payload });
      if (path === '/api/chats/history') {
        return {
          chat: { id: Number(payload.chat_id), pending: true },
          history: [{ id: 11, role: 'assistant', body: 'pending' }],
        };
      }
      if (path === '/api/chats/mark-read') {
        harness.markReadCalls.push(Number(payload.chat_id));
        return { chat: { id: Number(payload.chat_id), pending: true, unread_count: 0 } };
      }
      throw new Error(`unexpected ${path}`);
    },
  });

  await harness.controller.syncVisibleActiveChat({
    hidden: false,
    streamAbortControllers: new Map(),
  });
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.deepEqual(harness.resumedChats, [{ chatId: 7, options: {} }]);
});

test('syncVisibleActiveChat finalizes stale local pending tool traces when hydrate already includes the completed assistant reply', async () => {
  const harness = buildHarness({
    shouldResumeOnVisibilityChange: () => false,
    pendingChats: new Set(),
    mergeHydratedHistory: runtimeHistory.mergeHydratedHistory,
    apiPost: async (path, payload) => {
      harness.apiCalls.push({ path, payload });
      if (path === '/api/chats/history') {
        return {
          chat: { id: 7, pending: false },
          history: [
            { id: 10, role: 'tool', body: 'read_file', created_at: '2026-04-09T18:15:00Z', pending: false },
            { id: 11, role: 'assistant', body: 'hello', created_at: '2026-04-09T18:16:00Z', pending: false },
          ],
        };
      }
      throw new Error(`unexpected ${path}`);
    },
  });
  harness.histories.set(7, [{ role: 'tool', body: 'read_file', created_at: '2026-04-09T18:15:00Z', pending: true }]);

  await harness.controller.syncVisibleActiveChat({ hidden: false, streamAbortControllers: new Map() });

  assert.deepEqual(harness.restoredSnapshots, []);
  assert.deepEqual(harness.finalizedHydratedPendingChats, [7]);
  assert.deepEqual(harness.histories.get(7), [
    { id: 10, role: 'tool', body: 'read_file', created_at: '2026-04-09T18:15:00Z', pending: false },
    { id: 11, role: 'assistant', body: 'hello', created_at: '2026-04-09T18:16:00Z', pending: false },
  ]);
  assert.deepEqual(harness.resumedChats, []);
});

test('syncVisibleActiveChat restores fresh pending snapshot even when local history is empty and server says not pending', async () => {
  const harness = buildHarness({
    shouldResumeOnVisibilityChange: () => false,
    pendingChats: new Set(),
    apiPost: async (path, payload) => {
      harness.apiCalls.push({ path, payload });
      if (path === '/api/chats/history') {
        return {
          chat: { id: Number(payload.chat_id), pending: false },
          history: [{ id: 1, role: 'assistant', body: 'hello' }],
        };
      }
      if (path === '/api/chats/mark-read') {
        harness.markReadCalls.push(Number(payload.chat_id));
        return { chat: { id: Number(payload.chat_id), pending: false, unread_count: 0 } };
      }
      throw new Error(`unexpected ${path}`);
    },
    hasFreshPendingStreamSnapshot: (chatId) => Number(chatId) === 7,
    restorePendingStreamSnapshot: (chatId) => {
      harness.restoredSnapshots.push(Number(chatId));
      harness.histories.set(Number(chatId), [
        { id: 1, role: 'assistant', body: 'hello' },
        { role: 'tool', body: 'missed tool', pending: true },
      ]);
      return true;
    },
  });

  await harness.controller.syncVisibleActiveChat({ hidden: false, streamAbortControllers: new Map() });

  assert.deepEqual(harness.restoredSnapshots, [7]);
  assert.deepEqual(harness.renderedMessages, [{ chatId: 7, options: { preserveViewport: true } }]);
  assert.deepEqual(harness.resumedChats, [{ chatId: 7, options: { force: true } }]);
});

test('syncVisibleActiveChat rerenders active chat with completed transcript instead of restoring stale pending snapshot when hydrate already completed', async () => {
  const harness = buildHarness({
    shouldResumeOnVisibilityChange: () => false,
    pendingChats: new Set(),
    mergeHydratedHistory: runtimeHistory.mergeHydratedHistory,
    apiPost: async (path, payload) => {
      harness.apiCalls.push({ path, payload });
      if (path === '/api/chats/history') {
        return {
          chat: { id: 7, pending: false },
          history: [
            { id: 10, role: 'tool', body: 'read_file', created_at: '2026-04-09T18:15:00Z', pending: false },
            { id: 11, role: 'assistant', body: 'hello', created_at: '2026-04-09T18:16:00Z', pending: false },
          ],
        };
      }
      throw new Error(`unexpected ${path}`);
    },
    restorePendingStreamSnapshot: (chatId) => {
      harness.restoredSnapshots.push(Number(chatId));
      harness.histories.set(Number(chatId), [
        { id: 10, role: 'tool', body: 'read_file', created_at: '2026-04-09T18:15:00Z', pending: false },
        { id: 11, role: 'assistant', body: 'hello', created_at: '2026-04-09T18:16:00Z', pending: false },
        { role: 'tool', body: 'missed tool', pending: true },
      ]);
      return true;
    },
  });
  harness.histories.set(7, [{ role: 'tool', body: 'read_file', created_at: '2026-04-09T18:15:00Z', pending: true }]);

  await harness.controller.syncVisibleActiveChat({ hidden: false, streamAbortControllers: new Map() });
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.deepEqual(harness.restoredSnapshots, []);
  assert.deepEqual(harness.renderedMessages, [{ chatId: 7, options: { preserveViewport: true } }]);
  assert.deepEqual(harness.histories.get(7), [
    { id: 10, role: 'tool', body: 'read_file', created_at: '2026-04-09T18:15:00Z', pending: false },
    { id: 11, role: 'assistant', body: 'hello', created_at: '2026-04-09T18:16:00Z', pending: false },
  ]);
  assert.deepEqual(harness.resumedChats, []);
});

test('syncVisibleActiveChat forces resume when local pending assistant traces exist without live stream', async () => {
  const harness = buildHarness({
    shouldResumeOnVisibilityChange: () => false,
    pendingChats: new Set(),
    apiPost: async (path, payload) => {
      harness.apiCalls.push({ path, payload });
      if (path === '/api/chats/history') {
        return {
          chat: { id: Number(payload.chat_id), pending: false },
          history: [{ id: 41, role: 'assistant', body: 'stale snapshot' }],
        };
      }
      if (path === '/api/chats/mark-read') {
        harness.markReadCalls.push(Number(payload.chat_id));
        return { chat: { id: Number(payload.chat_id), pending: false, unread_count: 0 } };
      }
      throw new Error(`unexpected ${path}`);
    },
  });

  harness.histories.set(7, [
    { role: 'hermes', body: 'Working…', pending: true },
  ]);

  await harness.controller.syncVisibleActiveChat({
    hidden: false,
    streamAbortControllers: new Map(),
  });
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.deepEqual(harness.restoredSnapshots, [7]);
  assert.deepEqual(harness.resumedChats, [{ chatId: 7, options: { force: true } }]);
});

test('syncVisibleActiveChat skips rerender when hydrated active history is render-identical', async () => {
  const harness = buildHarness({
    shouldResumeOnVisibilityChange: () => false,
    apiPost: async (path, payload) => {
      harness.apiCalls.push({ path, payload });
      if (path === '/api/chats/history') {
        return {
          chat: { id: Number(payload.chat_id), pending: false, unread_count: 0 },
          history: [{ id: 1, role: 'assistant', body: 'hello' }],
        };
      }
      if (path === '/api/chats/mark-read') {
        harness.markReadCalls.push(Number(payload.chat_id));
        return { chat: { id: Number(payload.chat_id), pending: false, unread_count: 0 } };
      }
      throw new Error(`unexpected ${path}`);
    },
  });
  harness.histories.set(7, [{ id: 1, role: 'assistant', body: 'hello' }]);

  await harness.controller.syncVisibleActiveChat({
    hidden: false,
    streamAbortControllers: new Map(),
  });
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.deepEqual(harness.renderedMessages, []);
  assert.deepEqual(harness.resumedChats, []);
  assert.deepEqual(harness.refreshedTabs, [7]);
});

test('syncVisibleActiveChat skips rerender when hydrated active history only adds a server id to the same assistant text', async () => {
  const harness = buildHarness({
    shouldResumeOnVisibilityChange: () => false,
    apiPost: async (path, payload) => {
      harness.apiCalls.push({ path, payload });
      if (path === '/api/chats/history') {
        return {
          chat: { id: Number(payload.chat_id), pending: false, unread_count: 0 },
          history: [{ id: 101, role: 'assistant', body: 'hello' }],
        };
      }
      if (path === '/api/chats/mark-read') {
        harness.markReadCalls.push(Number(payload.chat_id));
        return { chat: { id: Number(payload.chat_id), pending: false, unread_count: 0 } };
      }
      throw new Error(`unexpected ${path}`);
    },
  });
  harness.histories.set(7, [{ role: 'assistant', body: 'hello' }]);

  await harness.controller.syncVisibleActiveChat({
    hidden: false,
    streamAbortControllers: new Map(),
  });
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.deepEqual(harness.renderedMessages, []);
  assert.deepEqual(harness.refreshedTabs, [7]);
});

test('syncVisibleActiveChat finalizes local pending immediately when hydrated completed assistant matches already-visible local pending reply', async () => {
  const harness = buildHarness({
    shouldResumeOnVisibilityChange: () => false,
    apiPost: async (path, payload) => {
      harness.apiCalls.push({ path, payload });
      if (path === '/api/chats/history') {
        return {
          chat: { id: Number(payload.chat_id), pending: false, unread_count: 0 },
          history: [{ id: 99, role: 'assistant', body: 'final answer', pending: false }],
        };
      }
      if (path === '/api/chats/mark-read') {
        harness.markReadCalls.push(Number(payload.chat_id));
        return { chat: { id: Number(payload.chat_id), pending: false, unread_count: 0 } };
      }
      throw new Error(`unexpected ${path}`);
    },
  });
  harness.unseenStreamChats.add(7);
  harness.histories.set(7, [
    { role: 'assistant', body: 'final answer', pending: true },
  ]);

  await harness.controller.syncVisibleActiveChat({
    hidden: false,
    streamAbortControllers: new Map(),
  });
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.deepEqual(harness.finalizedHydratedPendingChats, [7]);
  assert.equal(harness.pendingChats.has(7), false);
  assert.deepEqual(harness.resumedChats, []);
  assert.deepEqual(harness.refreshedTabs, [7]);
  assert.deepEqual(harness.renderedMessages.at(-1), { chatId: 7, options: { preserveViewport: true } });
});

test('syncVisibleActiveChat ignores stale history responses when active chat changes mid-request', async () => {
  let resolveHistory;
  const historyGate = new Promise((resolve) => {
    resolveHistory = resolve;
  });
  const harness = buildHarness({
    apiPost: async (path, payload) => {
      harness.apiCalls.push({ path, payload });
      if (path === '/api/chats/history') {
        await historyGate;
        return {
          chat: { id: Number(payload.chat_id), pending: true },
          history: [{ id: 21, role: 'assistant', body: 'stale response' }],
        };
      }
      if (path === '/api/chats/mark-read') {
        harness.markReadCalls.push(Number(payload.chat_id));
        return { chat: { id: Number(payload.chat_id), pending: false, unread_count: 0 } };
      }
      throw new Error(`unexpected ${path}`);
    },
  });

  const syncPromise = harness.controller.syncVisibleActiveChat({
    hidden: false,
    streamAbortControllers: new Map(),
  });
  harness.setActiveChatId(8);
  resolveHistory();
  await historyGate;
  await syncPromise;
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(harness.histories.has(7), false);
  assert.deepEqual(harness.renderedMessages, []);
  assert.deepEqual(harness.resumedChats, []);
  assert.deepEqual(harness.upsertedChats, []);
  assert.deepEqual(harness.markReadCalls, []);
});

test('syncVisibleActiveChat is a no-op when there is no active chat', async () => {
  const harness = buildHarness();
  harness.setActiveChatId(0);

  await harness.controller.syncVisibleActiveChat({
    hidden: false,
    streamAbortControllers: new Map(),
  });

  assert.equal(harness.apiCalls.some((call) => call.path === '/api/chats/history'), false);
  assert.deepEqual(harness.renderedMessages, []);
  assert.deepEqual(harness.resumedChats, []);
  assert.deepEqual(harness.markReadCalls, []);
});

test('syncVisibleActiveChat preserves local unread when active history sync reports unread_count 0 before bottom threshold is met', async () => {
  const harness = buildHarness({
    apiPost: async (path, payload) => {
      harness.apiCalls.push({ path, payload });
      if (path === '/api/chats/history') {
        return {
          chat: { id: Number(payload.chat_id), pending: false, unread_count: 0 },
          history: [{ id: 1, role: 'assistant', body: 'hello again' }],
        };
      }
      throw new Error(`unexpected ${path}`);
    },
    upsertChat: (chat) => {
      harness.upsertedChats.push(chat);
      const current = harness.chats.get(Number(chat.id)) || {};
      harness.chats.set(Number(chat.id), {
        ...current,
        ...chat,
        id: Number(chat.id),
        unread_count: Number(chat.unread_count || 0),
        pending: Boolean(chat.pending),
      });
    },
  });
  harness.chats.set(7, { id: 7, unread_count: 1, pending: false });
  harness.setRenderedAssistantNodes([{ offsetTop: 420, offsetHeight: 140 }]);
  harness.setMessageViewport({ scrollTop: 320, clientHeight: 260 });

  await harness.controller.openChat(7);
  await harness.controller.syncVisibleActiveChat();

  assert.equal(harness.chats.get(7).unread_count, 1);
  assert.deepEqual(harness.markReadCalls, []);
});

test('syncVisibleActiveChat preserves local unread for the active chat even if activation threshold state was lost but newest unread message is still below viewport', async () => {
  const harness = buildHarness({
    apiPost: async (path, payload) => {
      harness.apiCalls.push({ path, payload });
      if (path === '/api/chats/history') {
        return {
          chat: { id: Number(payload.chat_id), pending: false, unread_count: 0 },
          history: [{ id: 1, role: 'assistant', body: 'hello again' }],
        };
      }
      throw new Error(`unexpected ${path}`);
    },
    upsertChat: (chat) => {
      harness.upsertedChats.push(chat);
      const current = harness.chats.get(Number(chat.id)) || {};
      harness.chats.set(Number(chat.id), {
        ...current,
        ...chat,
        id: Number(chat.id),
        unread_count: Number(chat.unread_count || 0),
        pending: Boolean(chat.pending),
      });
    },
  });
  harness.chats.set(7, { id: 7, unread_count: 1, pending: false });
  harness.setRenderedAssistantNodes([{ offsetTop: 420, offsetHeight: 140 }]);
  harness.setMessageViewport({ scrollTop: 120, clientHeight: 260 });

  await harness.controller.syncVisibleActiveChat();

  assert.equal(harness.chats.get(7).unread_count, 1);
  assert.deepEqual(harness.markReadCalls, []);
});

test('syncVisibleActiveChat does not consume active-chat unread on visibility resume before hydrated history shows the new assistant message below the viewport', async () => {
  const harness = buildHarness({
    apiPost: async (path, payload) => {
      harness.apiCalls.push({ path, payload });
      if (path === '/api/chats/history') {
        return {
          chat: { id: Number(payload.chat_id), pending: false, unread_count: 1 },
          history: [{ id: 55, role: 'assistant', body: 'new unread reply' }],
        };
      }
      if (path === '/api/chats/mark-read') {
        harness.markReadCalls.push(Number(payload.chat_id));
        return {
          chat: { id: Number(payload.chat_id), pending: false, unread_count: 0 },
        };
      }
      throw new Error(`unexpected ${path}`);
    },
    upsertChat: (chat) => {
      harness.upsertedChats.push(chat);
      const current = harness.chats.get(Number(chat.id)) || {};
      harness.chats.set(Number(chat.id), {
        ...current,
        ...chat,
        id: Number(chat.id),
        unread_count: Number(chat.unread_count || 0),
        pending: Boolean(chat.pending),
      });
    },
    renderMessages: (chatId, options = {}) => {
      harness.renderedMessages.push({ chatId: Number(chatId), options });
      harness.setRenderedAssistantNodes([{ offsetTop: 420, offsetHeight: 140 }]);
    },
  });
  harness.chats.set(7, { id: 7, unread_count: 1, pending: false });
  harness.setRenderedAssistantNodes([{ offsetTop: 120, offsetHeight: 80 }]);
  harness.setMessageViewport({ scrollTop: 0, clientHeight: 260 });

  await harness.controller.syncVisibleActiveChat({ hidden: false, streamAbortControllers: new Map() });
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(harness.chats.get(7).unread_count, 1);
  assert.deepEqual(harness.markReadCalls, []);
  assert.deepEqual(harness.renderedMessages, [{ chatId: 7, options: { preserveViewport: true } }]);
});

