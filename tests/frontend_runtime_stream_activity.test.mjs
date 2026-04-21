import { test, assert, runtime, sharedUtils } from './frontend_runtime_test_harness.mjs';

test('createStreamActivityController syncActivePendingStatus restarts live latency ticking for active live chat', () => {
  const chats = new Map([[7, { pending: false, title: 'Project Helios' }]]);
  const streamChip = { textContent: '', title: '' };
  const latencyChip = { textContent: 'latency: 59s · live', title: '' };
  const streamStatus = { textContent: '' };
  const updates = [];
  const setActivityChip = (chip, text) => {
    chip.textContent = text;
    updates.push({ chip, text });
  };
  const realNow = Date.now;
  Date.now = () => 1_000_000;
  try {
    const controller = runtime.createStreamActivityController({
      chats,
      getActiveChatId: () => 7,
      hasLiveStreamController: () => true,
      getChatLatencyText: () => '59s · live',
      chatLabel: () => 'Project Helios',
      compactChatLabel: () => 'Project Helios',
      setStreamStatus: (text) => {
        streamStatus.textContent = text;
      },
      setActivityChip,
      streamChip,
      latencyChip,
      setChatLatency: () => {},
      syncActiveLatencyChip: () => {},
      formatLatency: sharedUtils.formatLatency,
    });

    controller.syncActivePendingStatus();
    assert.equal(streamStatus.textContent, 'Hermes responding in Project Helios');
    assert.equal(streamChip.textContent, 'stream: active · Project Helios');
    assert.equal(latencyChip.textContent, 'latency: 59s · live');

    Date.now = () => 1_003_000;
    controller.markToolActivity(7);
    assert.equal(latencyChip.textContent, 'latency: 1m 2s · live');
    assert.ok(updates.some((entry) => entry.text === 'latency: 1m 2s · live'));
  } finally {
    Date.now = realNow;
  }
});


test('createStreamActivityController syncActivePendingStatus resumes live latency from per-chat state, not the visible chip text', () => {
  const chats = new Map([[7, { pending: false, title: 'Project Helios' }]]);
  const streamChip = { textContent: '', title: '' };
  const latencyChip = { textContent: 'latency: 42s · live', title: '' };
  const streamStatus = { textContent: '' };
  const updates = [];
  const setActivityChip = (chip, text) => {
    chip.textContent = text;
    updates.push({ chip, text });
  };
  const realNow = Date.now;
  Date.now = () => 1_000_000;
  try {
    const controller = runtime.createStreamActivityController({
      chats,
      getActiveChatId: () => 7,
      hasLiveStreamController: () => true,
      getChatLatencyText: () => '5s',
      chatLabel: () => 'Project Helios',
      compactChatLabel: () => 'Project Helios',
      setStreamStatus: (text) => {
        streamStatus.textContent = text;
      },
      setActivityChip,
      streamChip,
      latencyChip,
      setChatLatency: () => {},
      syncActiveLatencyChip: () => {},
      formatLatency: sharedUtils.formatLatency,
    });

    controller.syncActivePendingStatus();
    assert.equal(streamStatus.textContent, 'Hermes responding in Project Helios');
    assert.equal(streamChip.textContent, 'stream: active · Project Helios');
    assert.equal(latencyChip.textContent, 'latency: 5s · live');
    assert.ok(updates.some((entry) => entry.text === 'latency: 5s · live'));
  } finally {
    Date.now = realNow;
  }
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
    getChatLatencyText: () => '',
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
  assert.equal(syncActiveLatencyChipCalls, 1);

  chats.set(7, { pending: false, title: 'Project Helios' });
  controller.syncActivePendingStatus();
  assert.equal(streamChip.textContent, 'stream: idle');

  hasLive = true;
  controller.syncActivePendingStatus();
  assert.equal(streamStatus.textContent, 'Hermes responding in Project Helios');
  assert.equal(streamChip.textContent, 'stream: active · Project Helios');
  assert.equal(syncActiveLatencyChipCalls, 2);

  controller.markStreamActive(7);
  assert.equal(streamStatus.textContent, 'Hermes responding in Project Helios');
  assert.equal(streamChip.textContent, 'stream: active · Project Helios');
  assert.match(latencyChip.textContent, /^latency: [01]s · live$/);
  assert.ok(setChatLatencyCalls.length >= 1);
  assert.equal(setChatLatencyCalls.at(-1).chatId, 7);
  assert.match(setChatLatencyCalls.at(-1).text, /^[01]s · live$/);
  assert.ok(updates.length >= 3);
});


test('createStreamActivityController restores live latency from persisted per-chat state when reopening into a pending active chat', () => {
  const chats = new Map([[8, { pending: true, title: 'Reopened Chat' }]]);
  const streamChip = { textContent: '', title: '' };
  const latencyChip = { textContent: 'latency: 9s · live', title: '' };
  const streamStatus = { textContent: '' };
  const updates = [];
  const setChatLatencyCalls = [];
  let hasLiveController = false;
  const realNow = Date.now;
  const realSetInterval = globalThis.setInterval;
  const realClearInterval = globalThis.clearInterval;
  const intervalCallbacks = [];
  Date.now = () => 1_000_000;
  globalThis.setInterval = (callback) => {
    intervalCallbacks.push(callback);
    return { id: intervalCallbacks.length, unref() {} };
  };
  globalThis.clearInterval = () => {};
  try {
    const controller = runtime.createStreamActivityController({
      chats,
      getActiveChatId: () => 8,
      hasLiveStreamController: () => hasLiveController,
      getChatLatencyText: () => '9s · live',
      getStreamPhase: () => 'pending_tool',
      streamPhases: { PENDING_TOOL: 'pending_tool' },
      chatLabel: () => 'Reopened Chat',
      compactChatLabel: () => 'Reopened Chat',
      setStreamStatus: (text) => {
        streamStatus.textContent = text;
      },
      setActivityChip: (chip, text) => {
        chip.textContent = text;
        updates.push({ chip, text });
      },
      streamChip,
      latencyChip,
      setChatLatency: (chatId, text) => {
        setChatLatencyCalls.push({ chatId, text });
      },
      syncActiveLatencyChip: () => {
        const latest = setChatLatencyCalls.at(-1)?.text || '--';
        latencyChip.textContent = `latency: ${latest}`;
      },
      formatLatency: sharedUtils.formatLatency,
    });

    Date.now = () => 1_002_000;
    controller.syncActivePendingStatus();

    assert.equal(streamStatus.textContent, 'Waiting for Hermes in Reopened Chat');
    assert.equal(streamChip.textContent, 'stream: pending · Reopened Chat');
    assert.equal(latencyChip.textContent, 'latency: 9s · live');
    assert.equal(intervalCallbacks.length, 0);
    assert.deepEqual(setChatLatencyCalls.at(-1), { chatId: 8, text: '9s · live' });
    assert.ok(updates.some((entry) => entry.text === 'latency: 9s · live'));

    hasLiveController = true;
    chats.get(8).pending = false;
    Date.now = () => 1_004_000;
    controller.syncActivePendingStatus();

    assert.equal(streamStatus.textContent, 'Hermes responding in Reopened Chat');
    assert.equal(streamChip.textContent, 'stream: active · Reopened Chat');
    assert.equal(latencyChip.textContent, 'latency: 11s · live');
    assert.equal(intervalCallbacks.length, 1);

    Date.now = () => 1_006_000;
    intervalCallbacks[0]();
    assert.equal(latencyChip.textContent, 'latency: 13s · live');
  } finally {
    Date.now = realNow;
    globalThis.setInterval = realSetInterval;
    globalThis.clearInterval = realClearInterval;
  }
});


test('createStreamActivityController clears stale live latency when switching to a pending tab without a live controller after handoff grace expires', () => {
  const chats = new Map([
    [7, { pending: false, title: 'Working Chat' }],
    [8, { pending: true, title: 'Stuck Chat' }],
  ]);
  const streamChip = { textContent: '', title: '' };
  const latencyChip = { textContent: '', title: '' };
  const streamStatus = { textContent: '' };
  const updates = [];
  const setActivityChip = (chip, text) => {
    chip.textContent = text;
    updates.push({ chip, text });
  };
  const setChatLatencyCalls = [];
  let activeChatId = 8;
  let liveChatId = 8;
  const realNow = Date.now;
  const realSetInterval = globalThis.setInterval;
  const realClearInterval = globalThis.clearInterval;
  const intervalCallbacks = [];
  Date.now = () => 1_000_000;
  globalThis.setInterval = (callback) => {
    intervalCallbacks.push(callback);
    return { id: intervalCallbacks.length, unref() {} };
  };
  globalThis.clearInterval = () => {};
  try {
    const controller = runtime.createStreamActivityController({
      chats,
      getActiveChatId: () => activeChatId,
      hasLiveStreamController: (chatId) => Number(chatId) === liveChatId,
      getChatLatencyText: () => '9s · live',
      getStreamPhase: () => 'streaming_assistant',
      streamPhases: { STREAMING_ASSISTANT: 'streaming_assistant' },
      chatLabel: (chatId) => chats.get(Number(chatId))?.title || 'Chat',
      compactChatLabel: (chatId) => chats.get(Number(chatId))?.title || 'Chat',
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
        latencyChip.textContent = 'latency: --';
      },
      formatLatency: sharedUtils.formatLatency,
    });

    controller.markStreamActive(8, { elapsedMs: 9000 });
    assert.equal(latencyChip.textContent, 'latency: 9s · live');
    assert.equal(intervalCallbacks.length, 1);

    liveChatId = null;
    Date.now = () => 1_005_000;
    controller.syncActivePendingStatus();
    assert.equal(streamStatus.textContent, 'Waiting for Hermes in Stuck Chat');
    assert.equal(streamChip.textContent, 'stream: pending · Stuck Chat');
    assert.equal(latencyChip.textContent, 'latency: --');

    Date.now = () => 1_006_000;
    intervalCallbacks[0]();
    assert.equal(latencyChip.textContent, 'latency: --');
    assert.deepEqual(setChatLatencyCalls, [{ chatId: 8, text: '9s · live' }]);
  } finally {
    Date.now = realNow;
    globalThis.setInterval = realSetInterval;
    globalThis.clearInterval = realClearInterval;
  }
});


test('createStreamActivityController keeps terminal latency monotonic against the live pill', () => {
  const chats = new Map([[7, { pending: true, title: 'Project Helios' }]]);
  const streamChip = { textContent: '', title: '' };
  const latencyChip = { textContent: '', title: '' };
  const streamStatus = { textContent: '' };
  const now = Date.now();
  const realNow = Date.now;
  Date.now = () => now;
  const setChatLatencyCalls = [];
  try {
    const controller = runtime.createStreamActivityController({
      chats,
      getActiveChatId: () => 7,
      hasLiveStreamController: () => true,
      chatLabel: () => 'Project Helios',
      compactChatLabel: () => 'Project Helios',
      setStreamStatus: (text) => {
        streamStatus.textContent = text;
      },
      setActivityChip: (chip, text) => {
        chip.textContent = text;
      },
      streamChip,
      latencyChip,
      setChatLatency: (chatId, text) => {
        setChatLatencyCalls.push({ chatId, text });
      },
      syncActiveLatencyChip: () => {},
      formatLatency: sharedUtils.formatLatency,
    });

    controller.markStreamActive(7, { elapsedMs: 17000 });
    assert.equal(latencyChip.textContent, 'latency: 17s · live');

    controller.markStreamComplete(7, '13s');
    assert.equal(latencyChip.textContent, 'latency: 17s');
    assert.deepEqual(setChatLatencyCalls.at(-1), { chatId: 7, text: '17s' });
    assert.equal(streamStatus.textContent, 'Reply received in Project Helios');
    assert.equal(streamChip.textContent, 'stream: complete · Project Helios');
  } finally {
    Date.now = realNow;
  }
});


test('createStreamActivityController resolves final latency from live elapsed time when visibility resume discovers the stream already completed', () => {
  const chats = new Map([[7, { pending: false, title: 'Project Helios' }]]);
  const streamChip = { textContent: 'stream: active · Project Helios', title: '' };
  const latencyChip = { textContent: 'latency: 12s · live', title: '' };
  const streamStatus = { textContent: '' };
  const setChatLatencyCalls = [];
  const realNow = Date.now;
  Date.now = () => 1_000_000;
  try {
    let hasLiveController = true;
    const controller = runtime.createStreamActivityController({
      chats,
      getActiveChatId: () => 7,
      hasLiveStreamController: () => hasLiveController,
      getChatLatencyText: () => '12s · live',
      chatLabel: () => 'Project Helios',
      compactChatLabel: () => 'Project Helios',
      setStreamStatus: (text) => {
        streamStatus.textContent = text;
      },
      setActivityChip: (chip, text) => {
        chip.textContent = text;
      },
      streamChip,
      latencyChip,
      setChatLatency: (chatId, text) => {
        setChatLatencyCalls.push({ chatId, text });
      },
      syncActiveLatencyChip: () => {
        latencyChip.textContent = 'latency: 12s · live';
      },
      formatLatency: sharedUtils.formatLatency,
    });

    controller.markStreamActive(7, { elapsedMs: 12_000 });
    assert.equal(latencyChip.textContent, 'latency: 12s · live');

    hasLiveController = false;
    Date.now = () => 1_168_000;
    controller.syncActivePendingStatus();

    assert.equal(latencyChip.textContent, 'latency: 3m 0s');
    assert.deepEqual(setChatLatencyCalls.at(-1), { chatId: 7, text: '3m 0s' });
    assert.equal(streamStatus.textContent, 'Reply received in Project Helios');
    assert.equal(streamChip.textContent, 'stream: complete · Project Helios');
  } finally {
    Date.now = realNow;
  }
});


test('createStreamActivityController ignores inactive chat stream/status updates while preserving active tab pills', () => {
  const chats = new Map([
    [7, { pending: false, title: 'Active Chat' }],
    [8, { pending: true, title: 'Background Chat' }],
  ]);
  const streamChip = { textContent: 'stream: active · Active Chat', title: '' };
  const latencyChip = { textContent: 'latency: 11s · live', title: '' };
  const streamStatus = { textContent: 'Hermes responding in Active Chat' };
  const updates = [];
  const setChatLatencyCalls = [];

  const controller = runtime.createStreamActivityController({
    chats,
    getActiveChatId: () => 7,
    hasLiveStreamController: (chatId) => Number(chatId) === 7,
    getChatLatencyText: (chatId) => (Number(chatId) === 7 ? '11s · live' : '4s · live'),
    chatLabel: (chatId) => chats.get(Number(chatId))?.title || 'Chat',
    compactChatLabel: (chatId) => chats.get(Number(chatId))?.title || 'Chat',
    setStreamStatus: (text) => {
      streamStatus.textContent = text;
    },
    setActivityChip: (chip, text) => {
      chip.textContent = text;
      updates.push({ chip, text });
    },
    streamChip,
    latencyChip,
    setChatLatency: (chatId, text) => {
      setChatLatencyCalls.push({ chatId, text });
    },
    syncActiveLatencyChip: () => {},
    formatLatency: sharedUtils.formatLatency,
  });

  controller.markStreamActive(8, { elapsedMs: 4000 });
  controller.markStreamComplete(8, '4s');
  controller.markStreamError(8);
  controller.markNetworkFailure(8);
  controller.markStreamClosedEarly(8);

  assert.equal(streamChip.textContent, 'stream: active · Active Chat');
  assert.equal(streamStatus.textContent, 'Hermes responding in Active Chat');
  assert.equal(latencyChip.textContent, 'latency: 11s · live');
  assert.deepEqual(setChatLatencyCalls, [
    { chatId: 8, text: '4s' },
    { chatId: 8, text: '--' },
  ]);
  assert.ok(!updates.some((entry) => entry.chip === latencyChip && entry.text === 'latency: 4s'));
  assert.ok(!updates.some((entry) => entry.chip === streamChip && /Background Chat|stream: error|stream: network failure|stream: closed early/.test(entry.text)));
});


test('createStreamActivityController ignores inactive chat reconnect resets for the active latency pill', () => {
  const chats = new Map([
    [7, { pending: false, title: 'Active Chat' }],
    [8, { pending: true, title: 'Background Chat' }],
  ]);
  const streamChip = { textContent: '', title: '' };
  const latencyChip = { textContent: 'latency: 9s · live', title: '' };
  const updates = [];
  const setChatLatencyCalls = [];

  const controller = runtime.createStreamActivityController({
    chats,
    getActiveChatId: () => 7,
    hasLiveStreamController: (chatId) => Number(chatId) === 7,
    getChatLatencyText: () => '9s · live',
    chatLabel: (chatId) => chats.get(Number(chatId))?.title || 'Chat',
    compactChatLabel: (chatId) => chats.get(Number(chatId))?.title || 'Chat',
    setStreamStatus: () => {},
    setActivityChip: (chip, text) => {
      chip.textContent = text;
      updates.push({ chip, text });
    },
    streamChip,
    latencyChip,
    setChatLatency: (chatId, text) => {
      setChatLatencyCalls.push({ chatId, text });
    },
    syncActiveLatencyChip: () => {},
    formatLatency: sharedUtils.formatLatency,
  });

  controller.markReconnectFailed(8);

  assert.equal(latencyChip.textContent, 'latency: 9s · live');
  assert.deepEqual(setChatLatencyCalls, []);
  assert.ok(!updates.some((entry) => entry.chip === latencyChip && entry.text === 'latency: --'));
});


test('createStreamActivityController queue markers do not replace the latency pill with queue text', () => {
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
      latencyChip.textContent = 'latency: --';
    },
    formatLatency: sharedUtils.formatLatency,
  });

  controller.markStreamQueued(7, { queuedAhead: 3 });
  assert.equal(streamStatus.textContent, 'Queue update (Project Helios): queued');
  assert.equal(streamChip.textContent, 'stream: queued · Project Helios');
  assert.equal(latencyChip.textContent, 'latency: --');
  assert.deepEqual(setChatLatencyCalls, [{ chatId: 7, text: 'queued · ahead: 3' }]);

  activeChatId = 99;
  controller.markStreamQueued(7, { queuedAhead: 1 });
  assert.equal(streamChip.textContent, 'stream: queued · Project Helios');
  assert.deepEqual(setChatLatencyCalls, [{ chatId: 7, text: 'queued · ahead: 3' }]);
  assert.deepEqual(updates, [{ chip: streamChip, text: 'stream: queued · Project Helios' }]);
});


test('createStreamActivityController preserves live latency across queued transitions during an active run', () => {
  const chats = new Map([[7, { pending: true, title: 'Project Helios' }]]);
  const streamChip = { textContent: '', title: '' };
  const latencyChip = { textContent: '', title: '' };
  const streamStatus = { textContent: '' };
  const now = Date.now();
  const realNow = Date.now;
  Date.now = () => now;
  const setChatLatencyCalls = [];
  try {
    const controller = runtime.createStreamActivityController({
      chats,
      getActiveChatId: () => 7,
      chatLabel: () => 'Project Helios',
      compactChatLabel: () => 'Project Helios',
      setStreamStatus: (text) => {
        streamStatus.textContent = text;
      },
      setActivityChip: (chip, text) => {
        chip.textContent = text;
      },
      streamChip,
      latencyChip,
      setChatLatency: (chatId, text) => {
        setChatLatencyCalls.push({ chatId, text });
      },
      syncActiveLatencyChip: () => {},
      formatLatency: sharedUtils.formatLatency,
    });

    controller.markStreamActive(7, { elapsedMs: 12 * 60 * 1000 });
    controller.markStreamQueued(7, { queuedAhead: 1 });

    assert.equal(streamStatus.textContent, 'Queue update (Project Helios): queued');
    assert.equal(streamChip.textContent, 'stream: queued · Project Helios');
    assert.match(latencyChip.textContent, /^latency: 12m(?: 0s)? · live$/);
    assert.match(setChatLatencyCalls.at(-1)?.text || '', /^12m(?: 0s)? · live$/);
    assert.equal(setChatLatencyCalls.at(-1)?.chatId, 7);
  } finally {
    Date.now = realNow;
  }
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
  const realSetTimeout = globalThis.setTimeout;
  const realClearTimeout = globalThis.clearTimeout;
  const scheduledTimers = [];
  globalThis.setTimeout = (fn, delay, ...args) => {
    const handle = {
      delay,
      cleared: false,
      unref() {},
    };
    scheduledTimers.push(handle);
    fn(...args);
    return handle;
  };
  globalThis.clearTimeout = (handle) => {
    if (handle) {
      handle.cleared = true;
    }
  };

  try {
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
      formatLatency: sharedUtils.formatLatency,
    });

    controller.markStreamActive(7, { elapsedMs: 12 * 60 * 1000 });
    controller.markStreamReconnecting(7);
    assert.equal(streamStatus.textContent, 'Reconnecting stream in Project Helios...');
    assert.equal(streamChip.textContent, 'stream: reconnecting · Project Helios');
    assert.match(latencyChip.textContent, /^latency: 12m [01]s · live$/);
    assert.match(setChatLatencyCalls.at(-1)?.text || '', /^12m [01]s · live$/);
    assert.equal(setChatLatencyCalls.at(-1)?.chatId, 7);
    assert.equal(syncActiveLatencyChipCalls.length, 0);
    assert.equal(scheduledTimers.length, 1);

    controller.markResumeAlreadyComplete(7);
    assert.match(latencyChip.textContent, /^latency: 12m [01]s · live$/);
    assert.equal(streamStatus.textContent, 'Stream already complete in Project Helios');
    assert.equal(streamChip.textContent, 'stream: complete · Project Helios');
    assert.ok(setChatLatencyCalls.length >= 1);
    assert.equal(setChatLatencyCalls.at(-1).chatId, 7);
    assert.match(setChatLatencyCalls.at(-1).text, /^12m [01]s · live$/);

    activeChatId = 99;
    controller.markReconnectFailed(7);
    assert.notEqual(streamChip.textContent, 'stream: recovery paused');

    activeChatId = 7;
    controller.markReconnectFailed(7);
    assert.equal(streamStatus.textContent, 'Reconnect recovery paused — action needed');
    assert.equal(streamChip.textContent, 'stream: recovery paused');
    assert.ok(updates.length >= 4);
  } finally {
    globalThis.setTimeout = realSetTimeout;
    globalThis.clearTimeout = realClearTimeout;
  }
});
