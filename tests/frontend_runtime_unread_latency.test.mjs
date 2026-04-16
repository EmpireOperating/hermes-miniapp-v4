import { test, assert, runtime, sharedUtils } from './frontend_runtime_test_harness.mjs';

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


test('unread never increments for the selected active chat, even when hidden', () => {
  assert.equal(
    runtime.nextUnreadCount({
      currentUnreadCount: 0,
      targetChatId: 11,
      activeChatId: 11,
      hidden: true,
    }),
    0,
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


test('latestCompletedAssistantEffectKey resolves stable key from most recent completed assistant/hermes message', () => {
  const histories = new Map([
    [
      9,
      [
        { role: 'assistant', body: 'pending first', pending: true, created_at: '2026-03-25T10:00:00Z' },
        { role: 'hermes', body: 'done now', pending: false, id: 42, created_at: '2026-03-25T10:00:05Z' },
      ],
    ],
  ]);

  assert.equal(runtime.latestCompletedAssistantEffectKey({ chatId: 9, histories }), 'chat:9:msg:42');
  assert.equal(runtime.latestCompletedAssistantHapticKey({ chatId: 9, histories }), 'chat:9:msg:42');
  assert.equal(runtime.latestCompletedAssistantEffectKey({ chatId: 999, histories }), '');
});


test('createAttentionEffectsController dedupes haptics and applies unread policy using active chat + hidden state', () => {
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
  const traceLogs = [];

  const controller = runtime.createAttentionEffectsController({
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
    renderTraceLog: (eventName, payload) => traceLogs.push({ eventName, payload }),
  });

  controller.triggerIncomingMessageHaptic(7, { fallbackToLatestHistory: true });
  controller.triggerIncomingMessageHaptic(7, { fallbackToLatestHistory: true });
  assert.deepEqual(hapticCalls, ['heavy']);
  assert.ok(incomingMessageHapticKeys.has('chat:7:msg:17'));

  controller.incrementUnread(7);
  assert.equal(chats.get(7).unread_count, 0);

  hidden = true;
  controller.incrementUnread(7);
  assert.equal(chats.get(7).unread_count, 0);

  hidden = false;
  activeChatId = 99;
  controller.incrementUnread(7);
  assert.equal(chats.get(7).unread_count, 1);
  assert.deepEqual(traceLogs, [
    {
      eventName: 'unread-increment',
      payload: {
        chatId: 7,
        activeChatId: 7,
        hidden: false,
        beforeUnread: 0,
        afterUnread: 0,
        incremented: false,
      },
    },
    {
      eventName: 'unread-increment',
      payload: {
        chatId: 7,
        activeChatId: 7,
        hidden: true,
        beforeUnread: 0,
        afterUnread: 0,
        incremented: false,
      },
    },
    {
      eventName: 'unread-increment',
      payload: {
        chatId: 7,
        activeChatId: 99,
        hidden: false,
        beforeUnread: 0,
        afterUnread: 1,
        incremented: true,
      },
    },
  ]);
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
  assert.equal(latencyByChat.get(44), '1s');

  const activeUpdate = runtime.nextLatencyState({
    latencyByChat,
    targetChatId: 7,
    text: '120ms',
    activeChatId: 7,
    shouldDisplayChipText: () => true,
  });
  assert.equal(activeUpdate.chipText, 'latency: 1s');
  assert.equal(latencyByChat.get(7), '1s');
});


test('createLatencyController updates active latency chip via viewport-preserving mutation wrapper', () => {
  const latencyByChat = new Map();
  const chipUpdates = [];
  const debugEvents = [];
  const renderTraceEvents = [];
  const mutationCallbacks = [];
  const persistSnapshots = [];
  let activeChatId = 7;
  const latencyChip = { id: 'latency-chip', textContent: '' };

  const controller = runtime.createLatencyController({
    latencyByChat,
    getActiveChatId: () => activeChatId,
    setActivityChip: (chip, text) => {
      chip.textContent = text;
      chipUpdates.push({ chip, text });
    },
    preserveViewportDuringUiMutation: (mutator) => {
      mutationCallbacks.push(true);
      mutator();
    },
    latencyChip,
    streamDebugLog: (eventName, details) => {
      debugEvents.push({ eventName, details });
    },
    onLatencyMapMutated: (nextMap) => {
      persistSnapshots.push(new Map(nextMap));
    },
    renderTraceLog: (eventName, details) => {
      renderTraceEvents.push({ eventName, details });
    },
    getDocumentVisibilityState: () => 'hidden',
  });

  const result = controller.setChatLatency(7, '145ms');

  assert.equal(result.chipText, 'latency: 1s');
  assert.equal(latencyByChat.get(7), '1s');
  assert.equal(mutationCallbacks.length, 1);
  assert.deepEqual(chipUpdates, [{ chip: latencyChip, text: 'latency: 1s' }]);
  assert.equal(debugEvents.length, 1);
  assert.equal(debugEvents[0].eventName, 'latency-set');
  assert.equal(debugEvents[0].details.hasChipText, true);
  assert.deepEqual([...persistSnapshots[0].entries()], [[7, '1s']]);
  assert.deepEqual(renderTraceEvents, [{
    eventName: 'latency-update',
    details: {
      chatId: 7,
      activeChatId: 7,
      hidden: true,
      latency: '145ms',
      chipText: 'latency: 1s',
    },
  }]);
});


test('createLatencyPersistenceController binds storage config for load/persist delegates', () => {
  const storage = new Map();
  const localStorageRef = {
    getItem: (key) => storage.get(key) || null,
    setItem: (key, value) => storage.set(key, String(value)),
  };
  const latencyByChat = new Map([
    [7, '88ms'],
    [19, '2.4s · live'],
  ]);
  let nowMs = 12_345;

  const controller = runtime.createLatencyPersistenceController({
    localStorageRef,
    storageKey: 'latency-test',
    latencyByChat,
    maxAgeMs: 5_000,
    nowMs: () => nowMs,
  });

  const storedCount = controller.persistLatencyByChatToStorage();
  assert.equal(storedCount, 2);

  latencyByChat.clear();
  nowMs = 12_400;
  const loadedCount = controller.loadLatencyByChatFromStorage();
  assert.equal(loadedCount, 2);
  assert.deepEqual([...latencyByChat.entries()], [
    [7, '1s'],
    [19, '3s · live'],
  ]);
});


test('normalizeLatencyText removes millisecond displays and rolls large second counts into minutes', () => {
  assert.equal(sharedUtils.normalizeLatencyText('145ms'), '1s');
  assert.equal(sharedUtils.normalizeLatencyText('321s'), '5m 21s');
  assert.equal(sharedUtils.normalizeLatencyText('321s · live'), '5m 21s · live');
  assert.equal(sharedUtils.normalizeLatencyText('reconnecting...'), 'reconnecting...');
});


test('createLatencyController syncActiveLatencyChip resets to placeholder when active chat is missing', () => {
  const latencyByChat = new Map([[7, '1s']]);
  const chipUpdates = [];
  let activeChatId = null;
  const latencyChip = { id: 'latency-chip' };

  const controller = runtime.createLatencyController({
    latencyByChat,
    getActiveChatId: () => activeChatId,
    hasLiveStreamController: () => false,
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
    { chip: latencyChip, text: 'latency: 1s' },
  ]);
});


test('createLatencyController syncActiveLatencyChip hides queued and reconnecting latency placeholders', () => {
  const latencyByChat = new Map([
    [7, 'queued · ahead: 3'],
    [8, 'reconnecting...'],
    [9, '14s'],
    [10, '22s · live'],
  ]);
  const chipUpdates = [];
  let activeChatId = 7;
  const activeLiveChats = new Set();
  const latencyChip = { id: 'latency-chip' };

  const controller = runtime.createLatencyController({
    latencyByChat,
    getActiveChatId: () => activeChatId,
    hasLiveStreamController: (chatId) => activeLiveChats.has(Number(chatId)),
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
  activeChatId = 8;
  controller.syncActiveLatencyChip();
  activeChatId = 9;
  controller.syncActiveLatencyChip();
  activeChatId = 10;
  controller.syncActiveLatencyChip();
  activeLiveChats.add(10);
  controller.syncActiveLatencyChip();

  assert.deepEqual(chipUpdates, [
    { chip: latencyChip, text: 'latency: --' },
    { chip: latencyChip, text: 'latency: --' },
    { chip: latencyChip, text: 'latency: 14s' },
    { chip: latencyChip, text: 'latency: --' },
    { chip: latencyChip, text: 'latency: 22s · live' },
  ]);
});


test('createLatencyController does not let calculating placeholders into the active latency pill', () => {
  const latencyByChat = new Map();
  const chipUpdates = [];
  let activeChatId = 7;
  const latencyChip = { id: 'latency-chip', textContent: 'latency: 14s' };

  const controller = runtime.createLatencyController({
    latencyByChat,
    getActiveChatId: () => activeChatId,
    hasLiveStreamController: () => false,
    setActivityChip: (chip, text) => {
      chip.textContent = text;
      chipUpdates.push({ chip, text });
    },
    preserveViewportDuringUiMutation: (mutator) => {
      mutator();
    },
    latencyChip,
    streamDebugLog: () => {},
  });

  controller.setChatLatency(7, 'calculating...');
  controller.setChatLatency(7, 'recalculating...');

  assert.deepEqual(chipUpdates, []);
  assert.equal(latencyChip.textContent, 'latency: 14s');
  assert.equal(latencyByChat.get(7), 'recalculating...');
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
    nowMs: 12_345,
  });
  assert.equal(storedCount, 2);

  const restored = new Map();
  const loadedCount = runtime.loadLatencyByChatFromStorage({
    localStorageRef,
    storageKey: 'latency-test',
    latencyByChat: restored,
    nowMs: 12_400,
  });

  assert.equal(loadedCount, 2);
  assert.deepEqual([...restored.entries()], [
    [7, '1s'],
    [19, '3s · live'],
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
  assert.equal(persistedCount, 2);

  const persistedPayload = JSON.parse(storage.get('latency-test'));
  assert.deepEqual(persistedPayload, {
    '7': { value: '1s', ts: 10_000 },
    '19': { value: '2s', ts: 1_000 },
  });
});


test('latency storage helpers preserve timestamp for unchanged entries and keep remote-only chats', () => {
  const storage = new Map();
  const localStorageRef = {
    getItem: (key) => storage.get(key) || null,
    setItem: (key, value) => storage.set(key, String(value)),
  };

  storage.set('latency-test', JSON.stringify({
    '7': { value: '88ms', ts: 8_000 },
    '19': { value: '1.1s', ts: 9_000 },
    '44': { value: '5.2s', ts: 7_000 },
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

  assert.equal(persistedCount, 3);
  const persistedPayload = JSON.parse(storage.get('latency-test'));
  assert.deepEqual(persistedPayload, {
    '7': { value: '1s', ts: 8_000 },
    '19': { value: '3s', ts: 10_000 },
    '44': { value: '6s', ts: 7_000 },
  });
});
