import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const visibleHydration = require('../static/runtime_visible_hydration.js');

test('createVisibleHydrationEffectsController triggers hydration haptic and emits trace details when attention fires', () => {
  const traces = [];
  const haptics = [];
  const controller = visibleHydration.createVisibleHydrationEffectsController({
    describeHydrationAttentionEffect: (args) => ({
      shouldTriggerHaptic: true,
      shouldIncrementUnread: false,
      shouldRenderTabs: false,
      messageKey: '',
      fallbackToLatestHistory: true,
      previousAssistantKey: 'chat:7:msg:3',
      nextAssistantKey: 'chat:7:msg:4',
      unreadCount: Number(args.chat?.unread_count || 0),
      newestUnreadMessageId: Number(args.chat?.newest_unread_message_id || 0),
    }),
    executeAttentionEffect: ({ chatId, effect, triggerIncomingMessageHaptic }) => {
      triggerIncomingMessageHaptic(chatId, { messageKey: effect.messageKey, fallbackToLatestHistory: effect.fallbackToLatestHistory });
      return { triggeredHaptic: true, incrementedUnread: false, renderedTabs: false };
    },
    triggerIncomingMessageHaptic: (chatId, options = {}) => haptics.push({ chatId: Number(chatId), options }),
    traceChatHistory: (eventName, details = {}) => traces.push({ eventName, details }),
  });

  const triggered = controller.maybeTriggerVisibleHydrationHaptic({
    targetChatId: 7,
    hidden: false,
    previousHistory: [{ id: 3, role: 'assistant', body: 'old' }],
    finalHistory: [{ id: 4, role: 'assistant', body: 'fresh' }],
    chat: { unread_count: 1, newest_unread_message_id: 4 },
    shouldRenderActiveHistory: true,
  });

  assert.equal(triggered, true);
  assert.deepEqual(haptics, [{ chatId: 7, options: { messageKey: '', fallbackToLatestHistory: true } }]);
  assert.deepEqual(traces, [{
    eventName: 'visible-hydration-haptic',
    details: {
      chatId: 7,
      unreadCount: 1,
      newestUnreadMessageId: 4,
      previousAssistantKey: 'chat:7:msg:3',
      nextAssistantKey: 'chat:7:msg:4',
    },
  }]);
});

test('createVisibleHydrationEffectsController returns false without tracing when no haptic fired', () => {
  const traces = [];
  const controller = visibleHydration.createVisibleHydrationEffectsController({
    describeHydrationAttentionEffect: () => ({ shouldTriggerHaptic: false }),
    executeAttentionEffect: () => ({ triggeredHaptic: false, incrementedUnread: false, renderedTabs: false }),
    triggerIncomingMessageHaptic: () => {
      throw new Error('should not trigger haptic');
    },
    traceChatHistory: (eventName, details = {}) => traces.push({ eventName, details }),
  });

  const triggered = controller.maybeTriggerVisibleHydrationHaptic({
    targetChatId: 9,
    hidden: false,
    previousHistory: [],
    finalHistory: [],
    chat: { unread_count: 0, newest_unread_message_id: 0 },
    shouldRenderActiveHistory: false,
  });

  assert.equal(triggered, false);
  assert.deepEqual(traces, []);
});
