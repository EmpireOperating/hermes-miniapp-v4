(function (globalScope) {
  const readStateHelpers = globalScope.HermesMiniappRuntimeReadState || null;

  function normalizeChatId(value) {
    const parsed = Number(value);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
  }

  function hasChat(setLike, chatId) {
    if (!setLike || typeof setLike.has !== "function") return false;
    return setLike.has(chatId) || setLike.has(String(chatId));
  }

  function shouldResumeOnVisibilityChange({ hidden, activeChatId, pendingChats, streamAbortControllers }) {
    if (hidden) return false;
    const chatId = normalizeChatId(activeChatId);
    if (!chatId) return false;
    const hasPending = hasChat(pendingChats, chatId);
    const hasActiveController = hasChat(streamAbortControllers, chatId);
    return hasPending && !hasActiveController;
  }

  function shouldIncrementUnread({ targetChatId, activeChatId }) {
    const target = normalizeChatId(targetChatId);
    if (!target) return false;
    const active = normalizeChatId(activeChatId);
    return active !== target;
  }

  function nextUnreadCount({ currentUnreadCount, targetChatId, activeChatId, hidden }) {
    const current = Math.max(0, Number(currentUnreadCount) || 0);
    if (!shouldIncrementUnread({ targetChatId, activeChatId, hidden })) {
      return current;
    }
    return current + 1;
  }

  function latestCompletedAssistantEffectKey({ chatId, histories, history = null }) {
    const key = normalizeChatId(chatId);
    if (!key) return "";
    const resolvedHistory = Array.isArray(history) ? history : (histories?.get?.(key) || []);
    for (let index = resolvedHistory.length - 1; index >= 0; index -= 1) {
      const item = resolvedHistory[index];
      const role = String(item?.role || "").toLowerCase();
      if (role !== "assistant" && role !== "hermes") continue;
      if (Boolean(item?.pending)) continue;

      const messageId = Number(item?.id || 0);
      if (messageId > 0) {
        return `chat:${key}:msg:${messageId}`;
      }

      return [
        `chat:${key}:local`,
        String(item?.created_at || ""),
        String(item?.body || ""),
      ].join("|");
    }
    return "";
  }

  function describeHydrationAttentionEffect({
    chatId,
    hidden = false,
    shouldRenderActiveHistory = false,
    previousHistory,
    finalHistory,
    chat,
    latestCompletedAssistantEffectKeyFn = latestCompletedAssistantEffectKey,
  }) {
    const key = normalizeChatId(chatId);
    const unreadCount = Math.max(0, Number(chat?.unread_count || 0));
    const newestUnreadMessageId = Math.max(0, Number(chat?.newest_unread_message_id || 0));
    const previousAssistantKey = key
      ? latestCompletedAssistantEffectKeyFn({ chatId: key, history: previousHistory })
      : '';
    const nextAssistantKey = key
      ? latestCompletedAssistantEffectKeyFn({ chatId: key, history: finalHistory })
      : '';
    const shouldTriggerHaptic = Boolean(
      key
      && !hidden
      && shouldRenderActiveHistory
      && nextAssistantKey
      && previousAssistantKey !== nextAssistantKey
      && (unreadCount > 0 || newestUnreadMessageId > 0)
    );
    return {
      shouldTriggerHaptic,
      shouldIncrementUnread: false,
      shouldRenderTabs: false,
      messageKey: '',
      fallbackToLatestHistory: true,
      previousAssistantKey,
      nextAssistantKey,
      unreadCount,
      newestUnreadMessageId,
    };
  }

  function shouldTriggerHydrationAttentionEffect(args) {
    return describeHydrationAttentionEffect(args).shouldTriggerHaptic;
  }

  function executeAttentionEffect({
    chatId,
    effect,
    triggerIncomingMessageHaptic,
    incrementUnread,
    renderTabs,
  }) {
    const normalizedChatId = normalizeChatId(chatId);
    if (!normalizedChatId || !effect) {
      return {
        triggeredHaptic: false,
        incrementedUnread: false,
        renderedTabs: false,
      };
    }

    let triggeredHaptic = false;
    if (effect.shouldTriggerHaptic) {
      triggerIncomingMessageHaptic?.(normalizedChatId, {
        messageKey: String(effect.messageKey || ''),
        fallbackToLatestHistory: effect.fallbackToLatestHistory !== false,
      });
      triggeredHaptic = true;
    }

    let incrementedUnread = false;
    let renderedTabs = false;
    if (effect.shouldIncrementUnread) {
      incrementUnread?.(normalizedChatId);
      incrementedUnread = true;
      if (effect.shouldRenderTabs) {
        renderTabs?.();
        renderedTabs = true;
      }
    }

    return {
      triggeredHaptic,
      incrementedUnread,
      renderedTabs,
    };
  }

  function createAttentionEffectsController({
    tg,
    histories,
    incomingMessageHapticKeys,
    chats,
    getActiveChatId,
    isDocumentHidden,
    nextUnreadCountFn = nextUnreadCount,
    renderTraceLog,
  }) {
    const consumedCompletedReplyKeys = incomingMessageHapticKeys || new Set();

    function resolveLatestCompletedAssistantEffectKey(chatId) {
      return latestCompletedAssistantEffectKey({ chatId, histories });
    }

    function triggerIncomingMessageHaptic(chatId, { messageKey = "", fallbackToLatestHistory = true } = {}) {
      const key = normalizeChatId(chatId);
      if (!key) return;

      const normalizedMessageKey = String(messageKey || "").trim();
      const resolvedKey = normalizedMessageKey
        || (fallbackToLatestHistory ? resolveLatestCompletedAssistantEffectKey(key) : "");
      if (!resolvedKey || consumedCompletedReplyKeys.has(resolvedKey)) {
        return;
      }

      consumedCompletedReplyKeys.add(resolvedKey);
      try {
        tg?.HapticFeedback?.impactOccurred?.("heavy");
      } catch {
        // Haptics are best-effort and may be unavailable on some clients/devices.
      }
    }

    function incrementUnread(chatId) {
      const key = normalizeChatId(chatId);
      if (!key) return;
      if (typeof readStateHelpers?.applyIncomingUnreadIncrement === 'function') {
        readStateHelpers.applyIncomingUnreadIncrement({
          chats,
          chatId: key,
          nextUnreadCountFn,
          activeChatId: getActiveChatId?.(),
          hidden: Boolean(isDocumentHidden?.()),
          renderTraceLog,
        });
        return;
      }
      const chat = chats.get(key);
      const beforeUnread = Math.max(0, Number(chat?.unread_count || 0));
      chat.unread_count = nextUnreadCountFn({
        currentUnreadCount: chat.unread_count,
        targetChatId: key,
        activeChatId: getActiveChatId?.(),
        hidden: Boolean(isDocumentHidden?.()),
      });
      const afterUnread = Math.max(0, Number(chat?.unread_count || 0));
      renderTraceLog?.('unread-increment', {
        chatId: key,
        activeChatId: normalizeChatId(getActiveChatId?.()) || 0,
        hidden: Boolean(isDocumentHidden?.()),
        beforeUnread,
        afterUnread,
        incremented: afterUnread > beforeUnread,
      });
    }

    return {
      latestCompletedAssistantEffectKey: resolveLatestCompletedAssistantEffectKey,
      latestCompletedAssistantHapticKey: resolveLatestCompletedAssistantEffectKey,
      triggerIncomingMessageHaptic,
      incrementUnread,
      consumedCompletedReplyKeys,
    };
  }

  function describeFirstAssistantAttentionEffect({
    chatId,
    activeChatId,
    hidden = false,
    notificationId = 0,
  }) {
    const key = normalizeChatId(chatId);
    const shouldNotifyOnFirstChunk = shouldIncrementUnread({
      targetChatId: key,
      activeChatId,
      hidden: Boolean(hidden),
    });
    return {
      shouldTriggerHaptic: shouldNotifyOnFirstChunk,
      shouldIncrementUnread: shouldNotifyOnFirstChunk,
      shouldRenderTabs: shouldNotifyOnFirstChunk,
      messageKey: shouldNotifyOnFirstChunk ? `chat:${key}:assistant-stream:${Math.max(0, Number(notificationId) || 0)}` : '',
      fallbackToLatestHistory: false,
    };
  }

  function describeDoneAttentionEffect({
    chatId,
    activeChatId,
    hidden = false,
    updateUnread = true,
    earlyAssistantNotification = null,
    doneTurnCount = 0,
  }) {
    const key = normalizeChatId(chatId);
    if (!key) {
      return {
        shouldTriggerHaptic: false,
        shouldIncrementUnread: false,
        messageKey: '',
        hadEarlyAssistantHaptic: false,
        hadEarlyAssistantUnread: false,
      };
    }
    const active = normalizeChatId(activeChatId);
    const hadEarlyAssistantHaptic = Boolean(String(earlyAssistantNotification?.messageKey || '').trim());
    const hadEarlyAssistantUnread = Boolean(earlyAssistantNotification?.unreadIncremented);
    const normalizedDoneTurnCount = Math.max(0, Number(doneTurnCount || 0));
    const messageKey = normalizedDoneTurnCount > 0 ? `chat:${key}:turn:${normalizedDoneTurnCount}` : '';
    const shouldIncrementUnreadOnDone = Boolean(
      updateUnread
      && !hadEarlyAssistantUnread
      && active !== key
    );
    const shouldTriggerHapticOnDone = Boolean(
      !hadEarlyAssistantHaptic
      && !hadEarlyAssistantUnread
      && (active !== key || Boolean(hidden))
    );
    return {
      shouldTriggerHaptic: shouldTriggerHapticOnDone,
      shouldIncrementUnread: shouldIncrementUnreadOnDone,
      shouldRenderTabs: shouldIncrementUnreadOnDone,
      messageKey,
      fallbackToLatestHistory: false,
      hadEarlyAssistantHaptic,
      hadEarlyAssistantUnread,
    };
  }

  function describeEarlyCloseAttentionEffect({
    chatId,
    activeChatId,
    hidden = false,
    earlyAssistantNotification = null,
  }) {
    const key = normalizeChatId(chatId);
    if (!key) {
      return {
        shouldTriggerHaptic: false,
        shouldIncrementUnread: false,
        hadEarlyAssistantUnread: false,
      };
    }
    const active = normalizeChatId(activeChatId);
    const hadEarlyAssistantUnread = Boolean(earlyAssistantNotification?.unreadIncremented);
    const shouldIncrementUnreadOnEarlyClose = Boolean(!hadEarlyAssistantUnread && active !== key);
    return {
      shouldTriggerHaptic: Boolean(!hadEarlyAssistantUnread && (active !== key || Boolean(hidden))),
      shouldIncrementUnread: shouldIncrementUnreadOnEarlyClose,
      shouldRenderTabs: shouldIncrementUnreadOnEarlyClose,
      fallbackToLatestHistory: true,
      hadEarlyAssistantUnread,
    };
  }

  function describeResumeCompletionAttentionEffect({ chatId }) {
    const key = normalizeChatId(chatId);
    return {
      shouldTriggerHaptic: Boolean(key),
      shouldIncrementUnread: false,
      shouldRenderTabs: false,
      messageKey: '',
      fallbackToLatestHistory: true,
    };
  }

  function createFirstAssistantNotificationController({
    getActiveChatId,
    isDocumentHidden = () => (typeof document !== 'undefined' ? document.visibilityState !== 'visible' : false),
    triggerIncomingMessageHaptic,
    incrementUnread,
    renderTabs,
  }) {
    const firstAssistantNotificationStateByChat = new Map();
    const immediateFinalizedChats = new Set();
    let nextAssistantNotificationId = 0;

    function consumeFirstAssistantNotification(chatId) {
      const key = Number(chatId);
      const notificationState = firstAssistantNotificationStateByChat.get(key) || null;
      firstAssistantNotificationStateByChat.delete(key);
      return notificationState;
    }

    function notifyFirstAssistantChunk(chatId) {
      const key = Number(chatId);
      if (!key || firstAssistantNotificationStateByChat.has(key)) {
        return false;
      }
      nextAssistantNotificationId += 1;
      const effect = describeFirstAssistantAttentionEffect({
        chatId: key,
        activeChatId: getActiveChatId?.(),
        hidden: Boolean(isDocumentHidden?.()),
        notificationId: nextAssistantNotificationId,
      });
      const notificationState = {
        messageKey: String(effect.messageKey || ''),
        unreadIncremented: false,
      };
      firstAssistantNotificationStateByChat.set(key, notificationState);
      const execution = executeAttentionEffect({
        chatId: key,
        effect,
        triggerIncomingMessageHaptic,
        incrementUnread,
        renderTabs,
      });
      notificationState.unreadIncremented = Boolean(execution.incrementedUnread);
      return true;
    }

    return {
      firstAssistantNotificationStateByChat,
      immediateFinalizedChats,
      consumeFirstAssistantNotification,
      notifyFirstAssistantChunk,
    };
  }

  const api = {
    shouldResumeOnVisibilityChange,
    shouldIncrementUnread,
    nextUnreadCount,
    latestCompletedAssistantEffectKey,
    createAttentionEffectsController,
    createFirstAssistantNotificationController,
    describeHydrationAttentionEffect,
    shouldTriggerHydrationAttentionEffect,
    describeFirstAssistantAttentionEffect,
    describeDoneAttentionEffect,
    describeEarlyCloseAttentionEffect,
    describeResumeCompletionAttentionEffect,
    executeAttentionEffect,
  };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
  globalScope.HermesMiniappRuntimeAttentionEffects = api;
})(typeof window !== "undefined" ? window : globalThis);
