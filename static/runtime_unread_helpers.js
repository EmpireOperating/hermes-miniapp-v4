(function (globalScope) {
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

  function shouldIncrementUnread({ targetChatId, activeChatId, hidden }) {
    const target = normalizeChatId(targetChatId);
    if (!target) return false;
    if (hidden) return true;
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

  function latestCompletedAssistantHapticKey({ chatId, histories }) {
    const key = normalizeChatId(chatId);
    if (!key) return "";
    const history = histories?.get?.(key) || [];
    for (let index = history.length - 1; index >= 0; index -= 1) {
      const item = history[index];
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

  function createHapticUnreadController({
    tg,
    histories,
    incomingMessageHapticKeys,
    chats,
    getActiveChatId,
    isDocumentHidden,
    nextUnreadCountFn = nextUnreadCount,
    renderTraceLog,
  }) {
    function resolveLatestCompletedAssistantHapticKey(chatId) {
      return latestCompletedAssistantHapticKey({ chatId, histories });
    }

    function triggerIncomingMessageHaptic(chatId, { messageKey = "", fallbackToLatestHistory = true } = {}) {
      const key = normalizeChatId(chatId);
      if (!key) return;

      const normalizedMessageKey = String(messageKey || "").trim();
      const resolvedKey = normalizedMessageKey
        || (fallbackToLatestHistory ? resolveLatestCompletedAssistantHapticKey(key) : "");
      if (!resolvedKey || incomingMessageHapticKeys.has(resolvedKey)) {
        return;
      }

      incomingMessageHapticKeys.add(resolvedKey);
      try {
        tg?.HapticFeedback?.impactOccurred?.("heavy");
      } catch {
        // Haptics are best-effort and may be unavailable on some clients/devices.
      }
    }

    function incrementUnread(chatId) {
      const key = normalizeChatId(chatId);
      if (!key || !chats?.has?.(key)) return;
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
      latestCompletedAssistantHapticKey: resolveLatestCompletedAssistantHapticKey,
      triggerIncomingMessageHaptic,
      incrementUnread,
    };
  }

  const api = {
    shouldResumeOnVisibilityChange,
    shouldIncrementUnread,
    nextUnreadCount,
    latestCompletedAssistantHapticKey,
    createHapticUnreadController,
  };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
  globalScope.HermesMiniappRuntimeUnread = api;
})(typeof window !== "undefined" ? window : globalThis);
