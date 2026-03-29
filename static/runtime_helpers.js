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
      chat.unread_count = nextUnreadCountFn({
        currentUnreadCount: chat.unread_count,
        targetChatId: key,
        activeChatId: getActiveChatId?.(),
        hidden: Boolean(isDocumentHidden?.()),
      });
    }

    return {
      latestCompletedAssistantHapticKey: resolveLatestCompletedAssistantHapticKey,
      triggerIncomingMessageHaptic,
      incrementUnread,
    };
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

  function createLatencyController({
    latencyByChat,
    getActiveChatId,
    setActivityChip,
    preserveViewportDuringUiMutation,
    latencyChip,
    streamDebugLog,
  }) {
    function setChatLatency(chatId, text) {
      const activeChatId = normalizeChatId(getActiveChatId?.());
      const result = nextLatencyState({
        latencyByChat,
        targetChatId: chatId,
        text,
        activeChatId,
      });

      streamDebugLog?.("latency-set", {
        chatId: Number(chatId),
        activeChatId: Number(activeChatId),
        text: String(text || "").trim() || "--",
        hasChipText: Boolean(result.chipText),
      });

      if (result.chipText) {
        preserveViewportDuringUiMutation?.(() => {
          setActivityChip?.(latencyChip, result.chipText);
        });
        return;
      }

      // Defensive fallback: when active chat bookkeeping lags behind a send/resume tick,
      // still keep latency chip populated for the current stream chat.
      const targetKey = normalizeChatId(chatId);
      if (targetKey && activeChatId === targetKey) {
        preserveViewportDuringUiMutation?.(() => {
          const normalized = String(text || "--").trim() || "--";
          setActivityChip?.(latencyChip, `latency: ${normalized}`);
        });
        streamDebugLog?.("latency-fallback", {
          chatId: targetKey,
          activeChatId: Number(activeChatId),
        });
      }
    }

    function syncActiveLatencyChip() {
      const key = normalizeChatId(getActiveChatId?.());
      if (!key) {
        setActivityChip?.(latencyChip, "latency: --");
        return;
      }
      const value = latencyByChat.get(key) || "--";
      setActivityChip?.(latencyChip, `latency: ${value}`);
    }

    return {
      setChatLatency,
      syncActiveLatencyChip,
    };
  }

  function createStreamActivityController({
    chats,
    getActiveChatId,
    chatLabel,
    compactChatLabel,
    setStreamStatus,
    setActivityChip,
    streamChip,
    latencyChip,
    setChatLatency,
    syncActiveLatencyChip,
  }) {
    function syncActivePendingStatus() {
      const activeKey = normalizeChatId(getActiveChatId?.());
      const chat = activeKey ? chats.get(activeKey) : null;
      if (chat?.pending) {
        setStreamStatus?.(`Waiting for Hermes in ${chatLabel?.(activeKey) || "Chat"}`);
        setActivityChip?.(streamChip, `stream: pending · ${compactChatLabel?.(activeKey) || "Chat"}`);
        return;
      }
      if ((streamChip?.textContent || "").startsWith("stream: pending")) {
        setActivityChip?.(streamChip, "stream: idle");
      }
    }

    function markStreamActive(chatId) {
      setStreamStatus?.(`Hermes responding in ${chatLabel?.(chatId) || "Chat"}`);
      setActivityChip?.(streamChip, `stream: active · ${compactChatLabel?.(chatId) || "Chat"}`);
      setActivityChip?.(latencyChip, "latency: calculating...");
      setChatLatency?.(chatId, "calculating...");
    }

    function markStreamError() {
      setStreamStatus?.("Stream error");
      setActivityChip?.(streamChip, "stream: error");
    }

    function markNetworkFailure() {
      setStreamStatus?.("Network failure");
      setActivityChip?.(streamChip, "stream: network failure");
    }

    function markStreamReconnecting(chatId) {
      const key = normalizeChatId(chatId);
      const activeKey = normalizeChatId(getActiveChatId?.());
      if (!key || key !== activeKey) return;
      setStreamStatus?.(`Reconnecting stream in ${chatLabel?.(key) || "Chat"}...`);
      setActivityChip?.(streamChip, `stream: reconnecting · ${compactChatLabel?.(key) || "Chat"}`);
      syncActiveLatencyChip?.();
    }

    function markResumeAlreadyComplete(chatId) {
      const key = normalizeChatId(chatId);
      if (!key) return;
      setActivityChip?.(latencyChip, "latency: --");
      setChatLatency?.(key, "--");
      if (normalizeChatId(getActiveChatId?.()) === key) {
        setStreamStatus?.(`Stream already complete in ${chatLabel?.(key) || "Chat"}`);
        setActivityChip?.(streamChip, `stream: complete · ${compactChatLabel?.(key) || "Chat"}`);
      }
    }

    function markReconnectFailed(chatId) {
      const key = normalizeChatId(chatId);
      if (!key || normalizeChatId(getActiveChatId?.()) !== key) return;
      setStreamStatus?.("Stream reconnect failed");
      setActivityChip?.(streamChip, "stream: reconnect failed");
    }

    return {
      syncActivePendingStatus,
      markStreamActive,
      markStreamError,
      markNetworkFailure,
      markStreamReconnecting,
      markResumeAlreadyComplete,
      markReconnectFailed,
    };
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

  function getNextChatTabId({ orderedChatIds, activeChatId, reverse = false }) {
    const ids = Array.isArray(orderedChatIds)
      ? orderedChatIds.map((id) => normalizeChatId(id)).filter(Boolean)
      : [];
    if (ids.length <= 1) return null;

    const active = normalizeChatId(activeChatId);
    if (!active) return null;

    const currentIndex = ids.indexOf(active);
    if (currentIndex < 0) return null;

    const step = reverse ? -1 : 1;
    const nextIndex = (currentIndex + step + ids.length) % ids.length;
    const nextId = ids[nextIndex];
    return Number.isInteger(nextId) && nextId > 0 ? nextId : null;
  }

  const api = {
    shouldResumeOnVisibilityChange,
    shouldIncrementUnread,
    nextUnreadCount,
    latestCompletedAssistantHapticKey,
    createHapticUnreadController,
    nextLatencyState,
    createLatencyController,
    createStreamActivityController,
    mergeHydratedHistory,
    shouldUseAppendOnlyRender,
    getNextChatTabId,
  };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
  globalScope.HermesMiniappRuntime = api;
})(typeof window !== "undefined" ? window : globalThis);
