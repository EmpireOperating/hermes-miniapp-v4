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

  function nextLatencyState({ latencyByChat, targetChatId, text, activeChatId }) {
    const key = normalizeChatId(targetChatId);
    if (!key) {
      return { nextMap: latencyByChat, chipText: null };
    }
    const normalized = String(text || "").trim() || "--";
    latencyByChat.set(key, normalized);
    if (normalizeChatId(activeChatId) === key) {
      return { nextMap: latencyByChat, chipText: `latency: ${normalized}` };
    }
    return { nextMap: latencyByChat, chipText: null };
  }

  function shouldPreservePendingLocalMessage(message) {
    if (!message || !message.pending) return false;
    const role = String(message.role || "").toLowerCase();
    return role === "tool" || role === "hermes" || role === "assistant";
  }
  function messageFingerprint(message) {
    const id = Number(message?.id || 0);
    if (Number.isInteger(id) && id > 0) {
      return `id:${id}`;
    }
    return [
      String(message?.role || "").toLowerCase(),
      String(message?.created_at || ""),
      String(message?.body || ""),
      message?.pending ? "pending" : "sent",
    ].join("|");
  }

  function mergeHydratedHistory({ previousHistory, nextHistory, chatPending }) {
    const incoming = Array.isArray(nextHistory) ? nextHistory.slice() : [];
    if (!chatPending) {
      return incoming;
    }

    const previous = Array.isArray(previousHistory) ? previousHistory : [];
    const localPending = previous.filter(shouldPreservePendingLocalMessage);
    if (!localPending.length) {
      return incoming;
    }

    const existingCounts = new Map();
    for (const item of incoming) {
      const key = messageFingerprint(item);
      existingCounts.set(key, (existingCounts.get(key) || 0) + 1);
    }

    for (const item of localPending) {
      const key = messageFingerprint(item);
      const count = existingCounts.get(key) || 0;
      if (count > 0) {
        existingCounts.set(key, count - 1);
        continue;
      }
      incoming.push({ ...item });
    }
    return incoming;
  }

  function messageStableKey(message, index = 0) {
    const messageId = Number(message?.id || 0);
    if (Number.isFinite(messageId) && messageId > 0) {
      return `id:${messageId}`;
    }

    const role = String(message?.role || "").toLowerCase();
    const pending = Boolean(message?.pending) ? "pending" : "sent";
    const createdAt = String(message?.created_at || "");
    return `local:${role}:${pending}:${createdAt}:${index}`;
  }

  function shouldUseAppendOnlyRender({ history, previouslyRenderedLength, renderedMessageKeys }) {
    const nextHistory = Array.isArray(history) ? history : [];
    const renderedLen = Math.max(0, Number(previouslyRenderedLength) || 0);
    const keys = Array.isArray(renderedMessageKeys) ? renderedMessageKeys : [];

    if (renderedLen <= 0) return false;
    if (nextHistory.length <= renderedLen) return false;
    if (keys.length !== renderedLen) return false;

    for (let index = 0; index < renderedLen; index += 1) {
      if (String(keys[index] || "") !== messageStableKey(nextHistory[index], index)) {
        return false;
      }
    }
    return true;
  }

  const api = {
    shouldResumeOnVisibilityChange,
    shouldIncrementUnread,
    nextUnreadCount,
    nextLatencyState,
    mergeHydratedHistory,
    shouldUseAppendOnlyRender,
  };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
  globalScope.HermesMiniappRuntime = api;
})(typeof window !== "undefined" ? window : globalThis);
