import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const readState = require('../static/runtime_read_state.js');
const attentionEffects = require('../static/runtime_attention_effects.js');

test('latestCompletedAssistantEffectKey resolves stable key for latest completed assistant reply', () => {
  const histories = new Map([
    [
      5,
      [
        { role: 'assistant', body: 'pending', pending: true, created_at: '2026-04-12T00:00:00Z' },
        { role: 'hermes', body: 'done', pending: false, id: 22, created_at: '2026-04-12T00:00:03Z' },
      ],
    ],
  ]);

  assert.equal(attentionEffects.latestCompletedAssistantEffectKey({ chatId: 5, histories }), 'chat:5:msg:22');
  assert.equal(attentionEffects.latestCompletedAssistantEffectKey({ chatId: 9, histories }), '');
});

test('createAttentionEffectsController dedupes repeated haptics for the same completed reply', () => {
  const histories = new Map([[3, [{ role: 'assistant', body: 'Done', pending: false, id: 91 }]]]);
  const chats = new Map([[3, { unread_count: 0 }]]);
  const haptics = [];
  const controller = attentionEffects.createAttentionEffectsController({
    tg: { HapticFeedback: { impactOccurred: (style) => haptics.push(style) } },
    histories,
    chats,
    incomingMessageHapticKeys: new Set(),
    getActiveChatId: () => 99,
    isDocumentHidden: () => false,
    renderTraceLog: () => {},
  });

  controller.triggerIncomingMessageHaptic(3, { fallbackToLatestHistory: true });
  controller.triggerIncomingMessageHaptic(3, { fallbackToLatestHistory: true });

  assert.deepEqual(haptics, ['heavy']);
  assert.equal(controller.latestCompletedAssistantEffectKey(3), 'chat:3:msg:91');
});

test('applyIncomingUnreadIncrement centralizes inactive unread mutation and trace logging', () => {
  const chats = new Map([[7, { unread_count: 0 }]]);
  const traceEvents = [];

  assert.deepEqual(readState.applyIncomingUnreadIncrement({
    chats,
    chatId: 7,
    nextUnreadCountFn: ({ currentUnreadCount, targetChatId, activeChatId }) => (
      Number(targetChatId) === Number(activeChatId)
        ? Math.max(0, Number(currentUnreadCount || 0))
        : Math.max(0, Number(currentUnreadCount || 0)) + 1
    ),
    activeChatId: 99,
    hidden: false,
    renderTraceLog: (eventName, payload) => traceEvents.push({ eventName, payload }),
  }), {
    chatId: 7,
    beforeUnread: 0,
    afterUnread: 1,
    incremented: true,
  });

  assert.equal(chats.get(7).unread_count, 1);
  assert.deepEqual(traceEvents, [{
    eventName: 'unread-increment',
    payload: {
      chatId: 7,
      activeChatId: 99,
      hidden: false,
      beforeUnread: 0,
      afterUnread: 1,
      incremented: true,
    },
  }]);
});

test('createAttentionEffectsController delegates unread mutation to shared read-state authority when available', () => {
  const traces = [];
  const chats = new Map([[8, { unread_count: 0 }]]);
  const controller = attentionEffects.createAttentionEffectsController({
    tg: { HapticFeedback: { impactOccurred: () => {} } },
    histories: new Map(),
    chats,
    incomingMessageHapticKeys: new Set(),
    getActiveChatId: () => 99,
    isDocumentHidden: () => false,
    renderTraceLog: (eventName, payload) => traces.push({ eventName, payload }),
  });

  controller.incrementUnread(8);

  assert.equal(chats.get(8).unread_count, 1);
  assert.deepEqual(traces, [{
    eventName: 'unread-increment',
    payload: {
      chatId: 8,
      activeChatId: 99,
      hidden: false,
      beforeUnread: 0,
      afterUnread: 1,
      incremented: true,
    },
  }]);
});

test('describeFirstAssistantAttentionEffect centralizes first-chunk unread and haptic rules', () => {
  assert.deepEqual(attentionEffects.describeFirstAssistantAttentionEffect({
    chatId: 9,
    activeChatId: 7,
    hidden: false,
    notificationId: 3,
  }), {
    shouldTriggerHaptic: true,
    shouldIncrementUnread: true,
    shouldRenderTabs: true,
    messageKey: 'chat:9:assistant-stream:3',
    fallbackToLatestHistory: false,
  });

  assert.deepEqual(attentionEffects.describeFirstAssistantAttentionEffect({
    chatId: 7,
    activeChatId: 7,
    hidden: false,
    notificationId: 4,
  }), {
    shouldTriggerHaptic: true,
    shouldIncrementUnread: false,
    shouldRenderTabs: false,
    messageKey: 'chat:7:assistant-stream:4',
    fallbackToLatestHistory: false,
  });

  assert.deepEqual(attentionEffects.describeFirstAssistantAttentionEffect({
    chatId: 7,
    activeChatId: 7,
    hidden: true,
    notificationId: 5,
  }), {
    shouldTriggerHaptic: false,
    shouldIncrementUnread: false,
    shouldRenderTabs: false,
    messageKey: '',
    fallbackToLatestHistory: false,
  });
});

test('first assistant notification increments unread once for inactive chat and fires only haptic for visible active chat', () => {
  const unread = [];
  const haptics = [];
  const controller = attentionEffects.createFirstAssistantNotificationController({
    getActiveChatId: () => 7,
    isDocumentHidden: () => false,
    triggerIncomingMessageHaptic: (chatId, { messageKey }) => haptics.push({ chatId: Number(chatId), messageKey }),
    incrementUnread: (chatId) => unread.push(Number(chatId)),
    renderTabs: () => unread.push('render'),
  });

  assert.equal(controller.notifyFirstAssistantChunk(9), true);
  assert.equal(controller.notifyFirstAssistantChunk(9), false);
  assert.deepEqual(unread, [9, 'render']);
  assert.deepEqual(haptics, [{ chatId: 9, messageKey: 'chat:9:assistant-stream:1' }]);
  assert.deepEqual(controller.consumeFirstAssistantNotification(9), {
    messageKey: 'chat:9:assistant-stream:1',
    unreadIncremented: true,
  });

  assert.equal(controller.notifyFirstAssistantChunk(7), true);
  assert.deepEqual(controller.consumeFirstAssistantNotification(7), {
    messageKey: 'chat:7:assistant-stream:2',
    unreadIncremented: false,
  });
  assert.deepEqual(haptics, [
    { chatId: 9, messageKey: 'chat:9:assistant-stream:1' },
    { chatId: 7, messageKey: 'chat:7:assistant-stream:2' },
  ]);
});

test('hidden active chat does not increment unread on first assistant chunk', () => {
  const unread = [];
  const haptics = [];
  const controller = attentionEffects.createFirstAssistantNotificationController({
    getActiveChatId: () => 11,
    isDocumentHidden: () => true,
    triggerIncomingMessageHaptic: (chatId, { messageKey }) => haptics.push({ chatId: Number(chatId), messageKey }),
    incrementUnread: (chatId) => unread.push(Number(chatId)),
    renderTabs: () => unread.push('render'),
  });

  assert.equal(controller.notifyFirstAssistantChunk(11), true);
  assert.deepEqual(unread, []);
  assert.deepEqual(haptics, []);
  assert.deepEqual(controller.consumeFirstAssistantNotification(11), {
    messageKey: '',
    unreadIncremented: false,
  });
});

test('describeHydrationAttentionEffect captures visible hydration haptic decision and keys', () => {
  const previousHistory = [
    { role: 'assistant', body: 'Older', pending: false, id: 30 },
  ];
  const finalHistory = [
    { role: 'assistant', body: 'Older', pending: false, id: 30 },
    { role: 'assistant', body: 'Newer', pending: false, id: 31 },
  ];

  assert.deepEqual(attentionEffects.describeHydrationAttentionEffect({
    chatId: 4,
    hidden: false,
    shouldRenderActiveHistory: true,
    previousHistory,
    finalHistory,
    chat: { unread_count: 1, newest_unread_message_id: 31 },
  }), {
    shouldTriggerHaptic: true,
    shouldIncrementUnread: false,
    shouldRenderTabs: false,
    messageKey: '',
    fallbackToLatestHistory: true,
    previousAssistantKey: 'chat:4:msg:30',
    nextAssistantKey: 'chat:4:msg:31',
    unreadCount: 1,
    newestUnreadMessageId: 31,
  });

  assert.equal(attentionEffects.shouldTriggerHydrationAttentionEffect({
    chatId: 4,
    hidden: false,
    shouldRenderActiveHistory: true,
    previousHistory: finalHistory,
    finalHistory,
    chat: { unread_count: 1, newest_unread_message_id: 31 },
  }), false);
});

test('executeAttentionEffect centralizes haptic, unread, and tab side effects', () => {
  const haptics = [];
  const unread = [];
  const tabs = [];

  assert.deepEqual(attentionEffects.executeAttentionEffect({
    chatId: 12,
    effect: {
      shouldTriggerHaptic: true,
      shouldIncrementUnread: true,
      shouldRenderTabs: true,
      messageKey: 'chat:12:turn:5',
      fallbackToLatestHistory: false,
    },
    triggerIncomingMessageHaptic: (chatId, options = {}) => haptics.push({ chatId: Number(chatId), options }),
    incrementUnread: (chatId) => unread.push(Number(chatId)),
    renderTabs: () => tabs.push('render'),
  }), {
    triggeredHaptic: true,
    incrementedUnread: true,
    renderedTabs: true,
  });

  assert.deepEqual(haptics, [{
    chatId: 12,
    options: { messageKey: 'chat:12:turn:5', fallbackToLatestHistory: false },
  }]);
  assert.deepEqual(unread, [12]);
  assert.deepEqual(tabs, ['render']);
});

test('describeDoneAttentionEffect centralizes exactly-once done haptic and unread rules', () => {
  assert.deepEqual(attentionEffects.describeDoneAttentionEffect({
    chatId: 9,
    activeChatId: 9,
    hidden: false,
    updateUnread: true,
    earlyAssistantNotification: { messageKey: '', unreadIncremented: false },
    doneTurnCount: 3,
  }), {
    shouldTriggerHaptic: false,
    shouldIncrementUnread: false,
    shouldRenderTabs: false,
    messageKey: 'chat:9:turn:3',
    fallbackToLatestHistory: false,
    hadEarlyAssistantHaptic: false,
    hadEarlyAssistantUnread: false,
  });

  assert.deepEqual(attentionEffects.describeDoneAttentionEffect({
    chatId: 9,
    activeChatId: 5,
    hidden: true,
    updateUnread: true,
    earlyAssistantNotification: { messageKey: '', unreadIncremented: false },
    doneTurnCount: 4,
  }), {
    shouldTriggerHaptic: true,
    shouldIncrementUnread: true,
    shouldRenderTabs: true,
    messageKey: 'chat:9:turn:4',
    fallbackToLatestHistory: false,
    hadEarlyAssistantHaptic: false,
    hadEarlyAssistantUnread: false,
  });

  assert.deepEqual(attentionEffects.describeDoneAttentionEffect({
    chatId: 9,
    activeChatId: 5,
    hidden: true,
    updateUnread: true,
    earlyAssistantNotification: { messageKey: 'chat:9:assistant-stream:1', unreadIncremented: true },
    doneTurnCount: 4,
  }), {
    shouldTriggerHaptic: false,
    shouldIncrementUnread: false,
    shouldRenderTabs: false,
    messageKey: 'chat:9:turn:4',
    fallbackToLatestHistory: false,
    hadEarlyAssistantHaptic: true,
    hadEarlyAssistantUnread: true,
  });
});

test('describeEarlyCloseAttentionEffect centralizes fallback haptic and unread rules', () => {
  assert.deepEqual(attentionEffects.describeEarlyCloseAttentionEffect({
    chatId: 7,
    activeChatId: 7,
    hidden: false,
    earlyAssistantNotification: { unreadIncremented: false },
  }), {
    shouldTriggerHaptic: false,
    shouldIncrementUnread: false,
    shouldRenderTabs: false,
    fallbackToLatestHistory: true,
    hadEarlyAssistantHaptic: false,
    hadEarlyAssistantUnread: false,
  });

  assert.deepEqual(attentionEffects.describeEarlyCloseAttentionEffect({
    chatId: 7,
    activeChatId: 9,
    hidden: false,
    earlyAssistantNotification: { unreadIncremented: false },
  }), {
    shouldTriggerHaptic: true,
    shouldIncrementUnread: true,
    shouldRenderTabs: true,
    fallbackToLatestHistory: true,
    hadEarlyAssistantHaptic: false,
    hadEarlyAssistantUnread: false,
  });

  assert.deepEqual(attentionEffects.describeEarlyCloseAttentionEffect({
    chatId: 7,
    activeChatId: 7,
    hidden: true,
    earlyAssistantNotification: { unreadIncremented: false },
  }), {
    shouldTriggerHaptic: true,
    shouldIncrementUnread: false,
    shouldRenderTabs: false,
    fallbackToLatestHistory: true,
    hadEarlyAssistantHaptic: false,
    hadEarlyAssistantUnread: false,
  });

  assert.deepEqual(attentionEffects.describeEarlyCloseAttentionEffect({
    chatId: 7,
    activeChatId: 9,
    hidden: true,
    earlyAssistantNotification: {
      unreadIncremented: false,
      messageKey: 'chat:7:assistant-stream:3',
    },
  }), {
    shouldTriggerHaptic: false,
    shouldIncrementUnread: true,
    shouldRenderTabs: true,
    fallbackToLatestHistory: true,
    hadEarlyAssistantHaptic: true,
    hadEarlyAssistantUnread: false,
  });
});

test('describeResumeCompletionAttentionEffect centralizes recovery haptic fallback policy', () => {
  assert.deepEqual(attentionEffects.describeResumeCompletionAttentionEffect({ chatId: 6 }), {
    shouldTriggerHaptic: true,
    shouldIncrementUnread: false,
    shouldRenderTabs: false,
    messageKey: '',
    fallbackToLatestHistory: true,
  });
});
