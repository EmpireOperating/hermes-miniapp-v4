(function (globalScope) {
  let normalizeLatencyText = globalScope.HermesMiniappSharedUtils?.normalizeLatencyText || null;
  if (!normalizeLatencyText && typeof module !== "undefined" && module.exports && typeof require === "function") {
    try {
      normalizeLatencyText = require("./app_shared_utils.js").normalizeLatencyText;
    } catch {
      normalizeLatencyText = null;
    }
  }
  if (!normalizeLatencyText) {
    normalizeLatencyText = (value) => String(value || "").trim() || "--";
  }

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
    const normalized = normalizeLatencyText(text);
    latencyByChat.set(key, normalized);
    if (normalizeChatId(activeChatId) === key) {
      return { nextMap: latencyByChat, chipText: `latency: ${normalized}` };
    }
    return { nextMap: latencyByChat, chipText: null };
  }

  function loadLatencyByChatFromStorage({
    localStorageRef,
    storageKey,
    latencyByChat,
    maxEntries = 200,
    maxAgeMs = 24 * 60 * 60 * 1000,
    nowMs = Date.now(),
  }) {
    try {
      const raw = localStorageRef?.getItem?.(storageKey);
      if (!raw) return 0;
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object") return 0;

      const now = Number(nowMs);
      const ttl = Number(maxAgeMs);
      const hasTtl = Number.isFinite(ttl) && ttl > 0;

      let loaded = 0;
      for (const [chatId, value] of Object.entries(parsed)) {
        if (loaded >= maxEntries) break;
        const key = normalizeChatId(chatId);
        if (!key) continue;

        let normalized = "";
        let ts = 0;
        if (value && typeof value === "object") {
          normalized = normalizeLatencyText(value.value);
          ts = Number(value.ts || 0);
        }

        if (!normalized || normalized === "--") continue;
        if (hasTtl) {
          if (!Number.isFinite(ts) || ts <= 0) continue;
          if (Number.isFinite(now) && now - ts > ttl) continue;
        }

        latencyByChat.set(key, normalized);
        loaded += 1;
      }
      return loaded;
    } catch {
      return 0;
    }
  }

  function persistLatencyByChatToStorage({
    localStorageRef,
    storageKey,
    latencyByChat,
    maxEntries = 200,
    nowMs = Date.now(),
  }) {
    try {
      const now = Number(nowMs);
      const timestamp = Number.isFinite(now) && now > 0 ? Math.floor(now) : Date.now();

      let existing = {};
      try {
        const raw = localStorageRef?.getItem?.(storageKey);
        const parsed = raw ? JSON.parse(raw) : {};
        if (parsed && typeof parsed === "object") {
          existing = parsed;
        }
      } catch {
        existing = {};
      }

      const payload = {};
      let stored = 0;
      for (const [chatId, value] of latencyByChat.entries()) {
        if (stored >= maxEntries) break;
        const key = normalizeChatId(chatId);
        if (!key) continue;
        const normalized = normalizeLatencyText(value);
        if (!normalized || normalized === "--") continue;

        const existingEntry = existing[String(key)];
        const existingValue = normalizeLatencyText(existingEntry?.value);
        const existingTs = Number(existingEntry?.ts || 0);
        const preserveTs = existingValue === normalized && Number.isFinite(existingTs) && existingTs > 0;

        payload[String(key)] = {
          value: normalized,
          ts: preserveTs ? Math.floor(existingTs) : timestamp,
        };
        stored += 1;
      }
      localStorageRef?.setItem?.(storageKey, JSON.stringify(payload));
      return stored;
    } catch {
      return 0;
    }
  }

  function createLatencyController({
    latencyByChat,
    getActiveChatId,
    setActivityChip,
    preserveViewportDuringUiMutation,
    latencyChip,
    streamDebugLog,
    onLatencyMapMutated,
  }) {
    function setChatLatency(chatId, text) {
      const activeChatId = normalizeChatId(getActiveChatId?.());
      const result = nextLatencyState({
        latencyByChat,
        targetChatId: chatId,
        text,
        activeChatId,
      });

      onLatencyMapMutated?.(latencyByChat);

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
    hasLiveStreamController,
    chatLabel,
    compactChatLabel,
    setStreamStatus,
    setActivityChip,
    streamChip,
    latencyChip,
    setChatLatency,
    syncActiveLatencyChip,
    formatLatency,
  }) {
    const RECONNECT_PILL_DELAY_MS = 2200;
    const LIVE_LATENCY_TICK_MS = 1000;
    const liveLatencyStartedAtByChat = new Map();
    const reconnectDisplayTimerByChat = new Map();
    let liveLatencyIntervalId = null;

    function clearReconnectTimer(chatId) {
      const key = normalizeChatId(chatId);
      if (!key) return;
      const existing = reconnectDisplayTimerByChat.get(key);
      if (existing) {
        clearTimeout(existing);
        reconnectDisplayTimerByChat.delete(key);
      }
    }

    function parseLatencyDisplayToSeconds(latencyText) {
      const normalized = String(latencyText || '')
        .replace(/·\s*live$/i, '')
        .trim();
      if (!normalized || normalized === '--') return null;
      const match = normalized.match(/^(?:(\d+)m)?\s*(?:(\d+)s)?$/i);
      if (!match) return null;
      const minutes = Number(match[1] || 0);
      const seconds = Number(match[2] || 0);
      if (!Number.isFinite(minutes) || !Number.isFinite(seconds)) return null;
      return (minutes * 60) + seconds;
    }

    function stopLiveLatencyLoopIfIdle() {
      const activeKey = normalizeChatId(getActiveChatId?.());
      if (activeKey && liveLatencyStartedAtByChat.has(activeKey)) {
        return;
      }
      if (liveLatencyIntervalId) {
        clearInterval(liveLatencyIntervalId);
        liveLatencyIntervalId = null;
      }
    }

    function tickLiveLatency() {
      const activeKey = normalizeChatId(getActiveChatId?.());
      if (!activeKey) {
        stopLiveLatencyLoopIfIdle();
        return;
      }
      const activeChat = chats?.get?.(activeKey) || null;
      const isStillLive = Boolean(activeChat?.pending) || Boolean(hasLiveStreamController?.(activeKey));
      if (!isStillLive) {
        clearLiveLatency(activeKey);
        return;
      }
      const startedAt = Number(liveLatencyStartedAtByChat.get(activeKey) || 0);
      if (!startedAt) {
        stopLiveLatencyLoopIfIdle();
        return;
      }
      const elapsedMs = Math.max(0, Date.now() - startedAt);
      const fallbackSeconds = `${Math.max(0, Math.ceil(elapsedMs / 1000))}s`;
      const runningLatency = `${formatLatency?.(elapsedMs) || fallbackSeconds} · live`;
      setActivityChip?.(latencyChip, `latency: ${runningLatency}`);
      setChatLatency?.(activeKey, runningLatency);
    }

    function ensureLiveLatencyLoop() {
      if (liveLatencyIntervalId) return;
      liveLatencyIntervalId = setInterval(tickLiveLatency, LIVE_LATENCY_TICK_MS);
      liveLatencyIntervalId?.unref?.();
    }

    function beginLiveLatency(chatId, { elapsedMs = null } = {}) {
      const key = normalizeChatId(chatId);
      if (!key) return;
      clearReconnectTimer(key);
      const normalizedElapsedMs = Number(elapsedMs);
      if (Number.isFinite(normalizedElapsedMs) && normalizedElapsedMs >= 0) {
        liveLatencyStartedAtByChat.set(key, Date.now() - normalizedElapsedMs);
      } else if (!liveLatencyStartedAtByChat.has(key)) {
        liveLatencyStartedAtByChat.set(key, Date.now());
      }
      tickLiveLatency();
      ensureLiveLatencyLoop();
    }

    function clearLiveLatency(chatId) {
      const key = normalizeChatId(chatId);
      if (!key) return;
      liveLatencyStartedAtByChat.delete(key);
      stopLiveLatencyLoopIfIdle();
    }

    function syncActivePendingStatus() {
      const activeKey = normalizeChatId(getActiveChatId?.());
      const chat = activeKey ? chats.get(activeKey) : null;
      if (chat?.pending) {
        setStreamStatus?.(`Waiting for Hermes in ${chatLabel?.(activeKey) || "Chat"}`);
        setActivityChip?.(streamChip, `stream: pending · ${compactChatLabel?.(activeKey) || "Chat"}`);
        return;
      }
      if (activeKey && hasLiveStreamController?.(activeKey)) {
        setStreamStatus?.(`Hermes responding in ${chatLabel?.(activeKey) || "Chat"}`);
        setActivityChip?.(streamChip, `stream: active · ${compactChatLabel?.(activeKey) || "Chat"}`);
        syncActiveLatencyChip?.();
        return;
      }
      if ((streamChip?.textContent || "").startsWith("stream: pending")
        || (streamChip?.textContent || "").startsWith("stream: active")
        || (streamChip?.textContent || "").startsWith("stream: reconnecting")) {
        setActivityChip?.(streamChip, "stream: idle");
      }
    }

    function markStreamActive(chatId, { elapsedMs = null } = {}) {
      clearReconnectTimer(chatId);
      setStreamStatus?.(`Hermes responding in ${chatLabel?.(chatId) || "Chat"}`);
      setActivityChip?.(streamChip, `stream: active · ${compactChatLabel?.(chatId) || "Chat"}`);
      beginLiveLatency(chatId, { elapsedMs });
    }

    function markStreamError(chatId = null) {
      clearReconnectTimer(chatId);
      clearLiveLatency(chatId || getActiveChatId?.());
      setStreamStatus?.("Stream error");
      setActivityChip?.(streamChip, "stream: error");
    }

    function markNetworkFailure(chatId = null) {
      clearReconnectTimer(chatId);
      clearLiveLatency(chatId || getActiveChatId?.());
      setStreamStatus?.("Network failure");
      setActivityChip?.(streamChip, "stream: network failure");
    }

    function markStreamClosedEarly(chatId = null) {
      clearReconnectTimer(chatId);
      clearLiveLatency(chatId || getActiveChatId?.());
      const key = normalizeChatId(chatId || getActiveChatId?.());
      if (key) {
        setChatLatency?.(key, "--");
      }
      setStreamStatus?.("Stream closed early");
      setActivityChip?.(streamChip, "stream: closed early");
    }

    function markStreamQueued(chatId, { queuedAhead = null } = {}) {
      const key = normalizeChatId(chatId);
      const activeKey = normalizeChatId(getActiveChatId?.());
      if (!key || key !== activeKey) return;
      clearReconnectTimer(key);
      clearLiveLatency(key);
      const normalizedQueuedAhead = Number(queuedAhead);
      const queueLabel = Number.isFinite(normalizedQueuedAhead) && normalizedQueuedAhead > 0
        ? `queued · ahead: ${normalizedQueuedAhead}`
        : "queued...";
      setStreamStatus?.(`Queue update (${chatLabel?.(key) || "Chat"}): queued`);
      setActivityChip?.(streamChip, `stream: queued · ${compactChatLabel?.(key) || "Chat"}`);
      setActivityChip?.(latencyChip, `latency: ${queueLabel}`);
      setChatLatency?.(key, queueLabel);
    }

    function markStreamReconnecting(chatId, { attempt = null, maxAttempts = null } = {}) {
      const key = normalizeChatId(chatId);
      const activeKey = normalizeChatId(getActiveChatId?.());
      if (!key || key !== activeKey) return;
      const normalizedAttempt = Number.isFinite(Number(attempt)) ? Number(attempt) : null;
      const normalizedMaxAttempts = Number.isFinite(Number(maxAttempts)) ? Number(maxAttempts) : null;
      const attemptSuffix = normalizedAttempt && normalizedMaxAttempts
        ? ` (attempt ${normalizedAttempt}/${normalizedMaxAttempts})`
        : "";
      clearReconnectTimer(key);
      const timerId = setTimeout(() => {
        reconnectDisplayTimerByChat.delete(key);
        setStreamStatus?.(`Reconnecting stream in ${chatLabel?.(key) || "Chat"}${attemptSuffix}...`);
        setActivityChip?.(streamChip, `stream: reconnecting · ${compactChatLabel?.(key) || "Chat"}`);
        setActivityChip?.(latencyChip, "latency: reconnecting...");
        setChatLatency?.(key, "reconnecting...");
      }, RECONNECT_PILL_DELAY_MS);
      timerId?.unref?.();
      reconnectDisplayTimerByChat.set(key, timerId);
    }

    function markStreamComplete(chatId, latencyText = "--") {
      const key = normalizeChatId(chatId);
      if (!key) return;
      clearReconnectTimer(key);
      const liveStartedAt = Number(liveLatencyStartedAtByChat.get(key) || 0);
      const activeKey = normalizeChatId(getActiveChatId?.());
      let resolvedLatency = String(latencyText || "").trim() || "--";
      if (liveStartedAt > 0 && activeKey === key) {
        const liveElapsedMs = Math.max(0, Date.now() - liveStartedAt);
        const liveLatency = formatLatency?.(liveElapsedMs) || `${Math.max(0, Math.ceil(liveElapsedMs / 1000))}s`;
        const resolvedSeconds = parseLatencyDisplayToSeconds(resolvedLatency);
        const liveSeconds = parseLatencyDisplayToSeconds(liveLatency);
        if (liveSeconds != null && (resolvedSeconds == null || liveSeconds > resolvedSeconds)) {
          resolvedLatency = liveLatency;
        }
      }
      clearLiveLatency(key);
      setActivityChip?.(latencyChip, `latency: ${resolvedLatency}`);
      setChatLatency?.(key, resolvedLatency);
      if (activeKey === key) {
        setStreamStatus?.(`Reply received in ${chatLabel?.(key) || "Chat"}`);
        setActivityChip?.(streamChip, `stream: complete · ${compactChatLabel?.(key) || "Chat"}`);
      }
    }

    function markResumeAlreadyComplete(chatId) {
      const key = normalizeChatId(chatId);
      if (!key) return;
      clearReconnectTimer(key);
      clearLiveLatency(key);
      const existingLatency = String(latencyChip?.textContent || '').trim();
      const hasResolvedLatency = existingLatency.startsWith('latency: ') && existingLatency !== 'latency: --';
      if (!hasResolvedLatency) {
        setActivityChip?.(latencyChip, "latency: --");
        setChatLatency?.(key, "--");
      }
      if (normalizeChatId(getActiveChatId?.()) === key) {
        setStreamStatus?.(`Stream already complete in ${chatLabel?.(key) || "Chat"}`);
        setActivityChip?.(streamChip, `stream: complete · ${compactChatLabel?.(key) || "Chat"}`);
      }
    }

    function markReconnectFailed(chatId) {
      const key = normalizeChatId(chatId);
      if (!key || normalizeChatId(getActiveChatId?.()) !== key) return;
      clearReconnectTimer(key);
      clearLiveLatency(key);
      setStreamStatus?.("Reconnect recovery paused — action needed");
      setActivityChip?.(streamChip, "stream: recovery paused");
      setActivityChip?.(latencyChip, "latency: --");
      setChatLatency?.(key, "--");
    }

    function markToolActivity(chatId) {
      const key = normalizeChatId(chatId);
      const activeKey = normalizeChatId(getActiveChatId?.());
      if (!key || key !== activeKey) return;
      clearReconnectTimer(key);
      beginLiveLatency(key);
      setStreamStatus?.(`Using tools in ${chatLabel?.(key) || "Chat"}`);
      setActivityChip?.(streamChip, `stream: tools active · ${compactChatLabel?.(key) || "Chat"}`);
    }

    return {
      syncActivePendingStatus,
      markStreamActive,
      markStreamError,
      markNetworkFailure,
      markStreamClosedEarly,
      markStreamQueued,
      markStreamReconnecting,
      markStreamComplete,
      markResumeAlreadyComplete,
      markReconnectFailed,
      markToolActivity,
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
    loadLatencyByChatFromStorage,
    persistLatencyByChatToStorage,
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
