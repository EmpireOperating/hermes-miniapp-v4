import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const runtime = require('../static/runtime_helpers.js');
const bootstrapAuth = require('../static/bootstrap_auth_helpers.js');

test('visibility resume only when pending chat has no active stream controller', () => {
  assert.equal(
    runtime.shouldResumeOnVisibilityChange({
      hidden: false,
      activeChatId: 7,
      pendingChats: new Set([7]),
      streamAbortControllers: new Map(),
    }),
    true,
  );

  assert.equal(
    runtime.shouldResumeOnVisibilityChange({
      hidden: false,
      activeChatId: 7,
      pendingChats: new Set([7]),
      streamAbortControllers: new Map([[7, {}]]),
    }),
    false,
  );

  assert.equal(
    runtime.shouldResumeOnVisibilityChange({
      hidden: false,
      activeChatId: 7,
      pendingChats: new Set(),
      streamAbortControllers: new Map(),
    }),
    false,
  );

  assert.equal(
    runtime.shouldResumeOnVisibilityChange({
      hidden: true,
      activeChatId: 7,
      pendingChats: new Set([7]),
      streamAbortControllers: new Map(),
    }),
    false,
  );
});

test('unread increments for backgrounded app even on active chat', () => {
  assert.equal(
    runtime.nextUnreadCount({
      currentUnreadCount: 0,
      targetChatId: 11,
      activeChatId: 11,
      hidden: true,
    }),
    1,
  );

  assert.equal(
    runtime.nextUnreadCount({
      currentUnreadCount: 2,
      targetChatId: 11,
      activeChatId: 11,
      hidden: false,
    }),
    2,
  );

  assert.equal(
    runtime.nextUnreadCount({
      currentUnreadCount: 2,
      targetChatId: 12,
      activeChatId: 11,
      hidden: false,
    }),
    3,
  );
});

test('latestCompletedAssistantHapticKey resolves stable key from most recent completed assistant/hermes message', () => {
  const histories = new Map([
    [
      9,
      [
        { role: 'assistant', body: 'pending first', pending: true, created_at: '2026-03-25T10:00:00Z' },
        { role: 'hermes', body: 'done now', pending: false, id: 42, created_at: '2026-03-25T10:00:05Z' },
      ],
    ],
  ]);

  assert.equal(runtime.latestCompletedAssistantHapticKey({ chatId: 9, histories }), 'chat:9:msg:42');
  assert.equal(runtime.latestCompletedAssistantHapticKey({ chatId: 999, histories }), '');
});

test('createHapticUnreadController dedupes haptics and applies unread policy using active chat + hidden state', () => {
  const histories = new Map([
    [
      7,
      [
        { role: 'assistant', body: 'Pending', pending: true, created_at: '2026-03-25T10:00:00Z' },
        { role: 'hermes', body: 'Complete', pending: false, id: 17, created_at: '2026-03-25T10:00:04Z' },
      ],
    ],
  ]);
  const incomingMessageHapticKeys = new Set();
  const chats = new Map([[7, { unread_count: 0 }]]);
  const hapticCalls = [];
  let activeChatId = 7;
  let hidden = false;

  const controller = runtime.createHapticUnreadController({
    tg: {
      HapticFeedback: {
        impactOccurred: (style) => {
          hapticCalls.push(style);
        },
      },
    },
    histories,
    incomingMessageHapticKeys,
    chats,
    getActiveChatId: () => activeChatId,
    isDocumentHidden: () => hidden,
  });

  controller.triggerIncomingMessageHaptic(7, { fallbackToLatestHistory: true });
  controller.triggerIncomingMessageHaptic(7, { fallbackToLatestHistory: true });
  assert.deepEqual(hapticCalls, ['heavy']);
  assert.ok(incomingMessageHapticKeys.has('chat:7:msg:17'));

  controller.incrementUnread(7);
  assert.equal(chats.get(7).unread_count, 0);

  hidden = true;
  controller.incrementUnread(7);
  assert.equal(chats.get(7).unread_count, 1);

  hidden = false;
  activeChatId = 99;
  controller.incrementUnread(7);
  assert.equal(chats.get(7).unread_count, 2);
});

test('latency chip only updates for active chat while preserving per-chat latency map', () => {
  const latencyByChat = new Map();

  const inactiveUpdate = runtime.nextLatencyState({
    latencyByChat,
    targetChatId: 44,
    text: '321ms',
    activeChatId: 7,
  });
  assert.equal(inactiveUpdate.chipText, null);
  assert.equal(latencyByChat.get(44), '321ms');

  const activeUpdate = runtime.nextLatencyState({
    latencyByChat,
    targetChatId: 7,
    text: '120ms',
    activeChatId: 7,
  });
  assert.equal(activeUpdate.chipText, 'latency: 120ms');
  assert.equal(latencyByChat.get(7), '120ms');
});

test('createLatencyController updates active latency chip via viewport-preserving mutation wrapper', () => {
  const latencyByChat = new Map();
  const chipUpdates = [];
  const debugEvents = [];
  const preserveCalls = [];
  let activeChatId = 7;
  const latencyChip = { id: 'latency-chip' };

  const controller = runtime.createLatencyController({
    latencyByChat,
    getActiveChatId: () => activeChatId,
    setActivityChip: (chip, text) => {
      chipUpdates.push({ chip, text });
    },
    preserveViewportDuringUiMutation: (mutator) => {
      preserveCalls.push(true);
      mutator();
    },
    latencyChip,
    streamDebugLog: (eventName, details) => {
      debugEvents.push({ eventName, details });
    },
  });

  controller.setChatLatency(7, '145ms');

  assert.equal(latencyByChat.get(7), '145ms');
  assert.equal(preserveCalls.length, 1);
  assert.deepEqual(chipUpdates, [{ chip: latencyChip, text: 'latency: 145ms' }]);
  assert.equal(debugEvents.length, 1);
  assert.equal(debugEvents[0].eventName, 'latency-set');
  assert.equal(debugEvents[0].details.hasChipText, true);
});

test('createLatencyController syncActiveLatencyChip resets to placeholder when active chat is missing', () => {
  const latencyByChat = new Map([[7, '88ms']]);
  const chipUpdates = [];
  let activeChatId = null;
  const latencyChip = { id: 'latency-chip' };

  const controller = runtime.createLatencyController({
    latencyByChat,
    getActiveChatId: () => activeChatId,
    setActivityChip: (chip, text) => {
      chipUpdates.push({ chip, text });
    },
    preserveViewportDuringUiMutation: (mutator) => {
      mutator();
    },
    latencyChip,
    streamDebugLog: () => {},
  });

  controller.syncActiveLatencyChip();
  activeChatId = 7;
  controller.syncActiveLatencyChip();

  assert.deepEqual(chipUpdates, [
    { chip: latencyChip, text: 'latency: --' },
    { chip: latencyChip, text: 'latency: 88ms' },
  ]);
});

test('latency storage helpers persist and restore per-chat values', () => {
  const storage = new Map();
  const localStorageRef = {
    getItem: (key) => storage.get(key) || null,
    setItem: (key, value) => storage.set(key, String(value)),
  };
  const latencyByChat = new Map([
    [7, '88ms'],
    [19, '2.4s · live'],
  ]);

  const storedCount = runtime.persistLatencyByChatToStorage({
    localStorageRef,
    storageKey: 'latency-test',
    latencyByChat,
    nowMs: 2_000,
  });
  assert.equal(storedCount, 2);

  const restored = new Map();
  const loadedCount = runtime.loadLatencyByChatFromStorage({
    localStorageRef,
    storageKey: 'latency-test',
    latencyByChat: restored,
    nowMs: 2_500,
    maxAgeMs: 1_000,
  });

  assert.equal(loadedCount, 2);
  assert.deepEqual([...restored.entries()], [
    [7, '88ms'],
    [19, '2.4s · live'],
  ]);
});

test('latency storage helpers drop expired entries by ttl', () => {
  const storage = new Map();
  const localStorageRef = {
    getItem: (key) => storage.get(key) || null,
    setItem: (key, value) => storage.set(key, String(value)),
  };

  storage.set('latency-test', JSON.stringify({
    '7': { value: '90ms', ts: 10_000 },
    '19': { value: '1.9s', ts: 1_000 },
    '44': 'legacy-no-timestamp',
  }));

  const restored = new Map();
  const loadedCount = runtime.loadLatencyByChatFromStorage({
    localStorageRef,
    storageKey: 'latency-test',
    latencyByChat: restored,
    nowMs: 20_000,
    maxAgeMs: 5_000,
  });

  assert.equal(loadedCount, 0);
  assert.deepEqual([...restored.entries()], []);

  const persistedCount = runtime.persistLatencyByChatToStorage({
    localStorageRef,
    storageKey: 'latency-test',
    latencyByChat: new Map([[7, '91ms']]),
    nowMs: 21_000,
  });
  assert.equal(persistedCount, 1);

  const persistedPayload = JSON.parse(storage.get('latency-test'));
  assert.deepEqual(persistedPayload, {
    '7': { value: '91ms', ts: 21_000 },
  });
});

test('latency storage helpers preserve timestamp for unchanged entries', () => {
  const storage = new Map();
  const localStorageRef = {
    getItem: (key) => storage.get(key) || null,
    setItem: (key, value) => storage.set(key, String(value)),
  };

  storage.set('latency-test', JSON.stringify({
    '7': { value: '88ms', ts: 8_000 },
    '19': { value: '1.1s', ts: 9_000 },
  }));

  const persistedCount = runtime.persistLatencyByChatToStorage({
    localStorageRef,
    storageKey: 'latency-test',
    latencyByChat: new Map([
      [7, '88ms'],
      [19, '2.2s'],
    ]),
    nowMs: 10_000,
  });

  assert.equal(persistedCount, 2);
  const persistedPayload = JSON.parse(storage.get('latency-test'));
  assert.deepEqual(persistedPayload, {
    '7': { value: '88ms', ts: 8_000 },
    '19': { value: '2.2s', ts: 10_000 },
  });
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
          histories.delete(chatId);
          pendingChats.delete(chatId);
        }
      }
      chatList.forEach((chat) => {
        chats.set(Number(chat.id), chat);
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

test('createStreamActivityController syncActivePendingStatus and stream active markers preserve chip contract', () => {
  const chats = new Map([[7, { pending: true, title: 'Project Helios' }]]);
  const streamChip = { textContent: '', title: '' };
  const latencyChip = { textContent: '', title: '' };
  const streamStatus = { textContent: '' };
  const updates = [];
  const setActivityChip = (chip, text) => {
    chip.textContent = text;
    updates.push({ chip, text });
  };
  const setStreamStatus = (text) => {
    streamStatus.textContent = text;
  };
  const chatLabel = (id) => (id === 7 ? 'Project Helios' : 'Chat');
  const compactChatLabel = () => 'Project Helios';
  const setChatLatencyCalls = [];

  let activeChatId = 7;
  let hasLive = false;
  let syncActiveLatencyChipCalls = 0;
  const controller = runtime.createStreamActivityController({
    chats,
    getActiveChatId: () => activeChatId,
    hasLiveStreamController: () => hasLive,
    chatLabel,
    compactChatLabel,
    setStreamStatus,
    setActivityChip,
    streamChip,
    latencyChip,
    setChatLatency: (chatId, text) => {
      setChatLatencyCalls.push({ chatId, text });
    },
    syncActiveLatencyChip: () => {
      syncActiveLatencyChipCalls += 1;
    },
  });

  controller.syncActivePendingStatus();
  assert.equal(streamStatus.textContent, 'Waiting for Hermes in Project Helios');
  assert.equal(streamChip.textContent, 'stream: pending · Project Helios');

  chats.set(7, { pending: false, title: 'Project Helios' });
  controller.syncActivePendingStatus();
  assert.equal(streamChip.textContent, 'stream: idle');

  hasLive = true;
  controller.syncActivePendingStatus();
  assert.equal(streamStatus.textContent, 'Hermes responding in Project Helios');
  assert.equal(streamChip.textContent, 'stream: active · Project Helios');
  assert.equal(syncActiveLatencyChipCalls, 1);

  controller.markStreamActive(7);
  assert.equal(streamStatus.textContent, 'Hermes responding in Project Helios');
  assert.equal(streamChip.textContent, 'stream: active · Project Helios');
  assert.equal(latencyChip.textContent, 'latency: calculating...');
  assert.deepEqual(setChatLatencyCalls, [{ chatId: 7, text: 'calculating...' }]);
  assert.ok(updates.length >= 3);
});

test('createStreamActivityController reconnect/complete/failure markers gate on active chat', () => {
  const chats = new Map([[7, { pending: true, title: 'Project Helios' }]]);
  const streamChip = { textContent: '', title: '' };
  const latencyChip = { textContent: '', title: '' };
  const streamStatus = { textContent: '' };
  const updates = [];
  const setActivityChip = (chip, text) => {
    chip.textContent = text;
    updates.push({ chip, text });
  };

  let activeChatId = 7;
  const syncActiveLatencyChipCalls = [];
  const setChatLatencyCalls = [];
  const controller = runtime.createStreamActivityController({
    chats,
    getActiveChatId: () => activeChatId,
    chatLabel: () => 'Project Helios',
    compactChatLabel: () => 'Project Helios',
    setStreamStatus: (text) => {
      streamStatus.textContent = text;
    },
    setActivityChip,
    streamChip,
    latencyChip,
    setChatLatency: (chatId, text) => {
      setChatLatencyCalls.push({ chatId, text });
    },
    syncActiveLatencyChip: () => {
      syncActiveLatencyChipCalls.push(true);
    },
  });

  controller.markStreamReconnecting(7);
  assert.equal(streamStatus.textContent, 'Reconnecting stream in Project Helios...');
  assert.equal(streamChip.textContent, 'stream: reconnecting · Project Helios');
  assert.equal(syncActiveLatencyChipCalls.length, 1);

  controller.markResumeAlreadyComplete(7);
  assert.equal(latencyChip.textContent, 'latency: --');
  assert.equal(streamStatus.textContent, 'Stream already complete in Project Helios');
  assert.equal(streamChip.textContent, 'stream: complete · Project Helios');
  assert.deepEqual(setChatLatencyCalls, [{ chatId: 7, text: '--' }]);

  activeChatId = 99;
  controller.markReconnectFailed(7);
  assert.notEqual(streamChip.textContent, 'stream: reconnect failed');

  activeChatId = 7;
  controller.markReconnectFailed(7);
  assert.equal(streamStatus.textContent, 'Stream reconnect failed');
  assert.equal(streamChip.textContent, 'stream: reconnect failed');
  assert.ok(updates.length >= 4);
});

test('mergeHydratedHistory preserves local pending tool traces while chat is pending', () => {
  const previousHistory = [
    { id: 1, role: 'operator', body: 'run this', created_at: '2026-03-25T10:00:00Z' },
    { role: 'tool', body: 'fetching quote', created_at: '2026-03-25T10:00:01Z', pending: true },
    { role: 'hermes', body: 'Working on it…', created_at: '2026-03-25T10:00:02Z', pending: true },
  ];
  const hydrated = [
    { id: 1, role: 'operator', body: 'run this', created_at: '2026-03-25T10:00:00Z' },
  ];

  const merged = runtime.mergeHydratedHistory({
    previousHistory,
    nextHistory: hydrated,
    chatPending: true,
  });

  assert.equal(merged.length, 3);
  assert.equal(merged[1].role, 'tool');
  assert.equal(merged[1].pending, true);
  assert.equal(merged[2].role, 'hermes');
  assert.equal(merged[2].pending, true);
});

test('mergeHydratedHistory does not preserve local pending traces after chat is no longer pending', () => {
  const previousHistory = [
    { id: 1, role: 'operator', body: 'run this', created_at: '2026-03-25T10:00:00Z' },
    { role: 'tool', body: 'fetching quote', created_at: '2026-03-25T10:00:01Z', pending: true },
  ];
  const hydrated = [
    { id: 1, role: 'operator', body: 'run this', created_at: '2026-03-25T10:00:00Z' },
    { id: 2, role: 'hermes', body: 'done', created_at: '2026-03-25T10:00:04Z', pending: false },
  ];

  const merged = runtime.mergeHydratedHistory({
    previousHistory,
    nextHistory: hydrated,
    chatPending: false,
  });

  assert.deepEqual(merged, hydrated);
});

test('mergeHydratedHistory avoids duplicating pending entries already present in hydrated history', () => {
  const pendingTool = { role: 'tool', body: 'fetching quote', created_at: '2026-03-25T10:00:01Z', pending: true };
  const previousHistory = [
    { id: 1, role: 'operator', body: 'run this', created_at: '2026-03-25T10:00:00Z' },
    pendingTool,
  ];
  const hydrated = [
    { id: 1, role: 'operator', body: 'run this', created_at: '2026-03-25T10:00:00Z' },
    { ...pendingTool },
  ];

  const merged = runtime.mergeHydratedHistory({
    previousHistory,
    nextHistory: hydrated,
    chatPending: true,
  });

  const toolRows = merged.filter((item) => item.role === 'tool');
  assert.equal(toolRows.length, 1);
});

test('shouldUseAppendOnlyRender returns false when new history inserts before current tail', () => {
  const previousTail = {
    role: 'hermes',
    body: 'Working…',
    created_at: '2026-03-25T10:00:02Z',
    pending: true,
  };
  const nextHistory = [
    { id: 1, role: 'operator', body: 'run this', created_at: '2026-03-25T10:00:00Z' },
    { role: 'tool', body: 'calling API', created_at: '2026-03-25T10:00:01Z', pending: true },
    previousTail,
  ];

  const renderedMessageKeys = [
    'id:1',
    'local:hermes:pending:2026-03-25T10:00:02Z:1',
  ];

  const canAppendOnly = runtime.shouldUseAppendOnlyRender({
    history: nextHistory,
    previouslyRenderedLength: 2,
    renderedMessageKeys,
  });

  assert.equal(canAppendOnly, false);
});

test('shouldUseAppendOnlyRender returns true for clean tail append', () => {
  const nextHistory = [
    { id: 1, role: 'operator', body: 'run this', created_at: '2026-03-25T10:00:00Z' },
    { role: 'hermes', body: 'Working…', created_at: '2026-03-25T10:00:02Z', pending: true },
    { role: 'tool', body: 'calling API', created_at: '2026-03-25T10:00:03Z', pending: true },
  ];

  const renderedMessageKeys = [
    'id:1',
    'local:hermes:pending:2026-03-25T10:00:02Z:1',
  ];

  const canAppendOnly = runtime.shouldUseAppendOnlyRender({
    history: nextHistory,
    previouslyRenderedLength: 2,
    renderedMessageKeys,
  });

  assert.equal(canAppendOnly, true);
});

test('getNextChatTabId cycles forward with wrap-around', () => {
  assert.equal(
    runtime.getNextChatTabId({ orderedChatIds: [3, 7, 10], activeChatId: 7, reverse: false }),
    10,
  );

  assert.equal(
    runtime.getNextChatTabId({ orderedChatIds: [3, 7, 10], activeChatId: 10, reverse: false }),
    3,
  );
});

test('getNextChatTabId cycles backward with wrap-around', () => {
  assert.equal(
    runtime.getNextChatTabId({ orderedChatIds: [3, 7, 10], activeChatId: 7, reverse: true }),
    3,
  );

  assert.equal(
    runtime.getNextChatTabId({ orderedChatIds: [3, 7, 10], activeChatId: 3, reverse: true }),
    10,
  );
});

test('getNextChatTabId returns null for invalid or singleton tab lists', () => {
  assert.equal(
    runtime.getNextChatTabId({ orderedChatIds: [7], activeChatId: 7, reverse: false }),
    null,
  );

  assert.equal(
    runtime.getNextChatTabId({ orderedChatIds: [], activeChatId: 7, reverse: false }),
    null,
  );

  assert.equal(
    runtime.getNextChatTabId({ orderedChatIds: [3, 7, 10], activeChatId: 999, reverse: false }),
    null,
  );
});
