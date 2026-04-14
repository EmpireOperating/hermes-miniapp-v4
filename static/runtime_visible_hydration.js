(function initHermesMiniappRuntimeVisibleHydration(globalScope) {
  function createVisibleHydrationEffectsController({
    describeHydrationAttentionEffect,
    executeAttentionEffect,
    triggerIncomingMessageHaptic,
    traceChatHistory,
  }) {
    function maybeTriggerVisibleHydrationHaptic({
      targetChatId,
      hidden = false,
      previousHistory,
      finalHistory,
      chat,
      shouldRenderActiveHistory = false,
    }) {
      if (typeof triggerIncomingMessageHaptic !== 'function') return false;
      const hydrationAttention = describeHydrationAttentionEffect({
        chatId: targetChatId,
        hidden,
        shouldRenderActiveHistory,
        previousHistory,
        finalHistory,
        chat,
      });
      const appliedAttention = executeAttentionEffect({
        chatId: targetChatId,
        effect: hydrationAttention,
        triggerIncomingMessageHaptic,
      });
      if (!appliedAttention.triggeredHaptic) return false;
      traceChatHistory('visible-hydration-haptic', {
        chatId: Number(targetChatId),
        unreadCount: hydrationAttention.unreadCount,
        newestUnreadMessageId: hydrationAttention.newestUnreadMessageId,
        previousAssistantKey: hydrationAttention.previousAssistantKey,
        nextAssistantKey: hydrationAttention.nextAssistantKey,
      });
      return true;
    }

    return {
      maybeTriggerVisibleHydrationHaptic,
    };
  }

  const api = {
    createVisibleHydrationEffectsController,
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  globalScope.HermesMiniappRuntimeVisibleHydration = api;
})(typeof window !== 'undefined' ? window : globalThis);
