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

  function isLiveLatencyText(value) {
    return /\s*·\s*live$/i.test(String(value || '').trim());
  }

  function isResolvedLatencyText(value) {
    const text = String(value || '').trim();
    if (!text || text === '--') return false;
    if (isLiveLatencyText(text)) return false;
    return /^(?:\d+s|\d+m\s+\d+s)$/i.test(text);
  }

  function shouldDisplayLatencyText(value, { isLiveActive = false } = {}) {
    const text = String(value || '').trim();
    if (!text) return false;
    if (isLiveActive && isLiveLatencyText(text)) return true;
    return isResolvedLatencyText(text);
  }

  function nextLatencyState({ latencyByChat, targetChatId, text, activeChatId, shouldDisplayChipText }) {
    const key = normalizeChatId(targetChatId);
    if (!key) {
      return { nextMap: latencyByChat, chipText: null };
    }
    const normalized = normalizeLatencyText(text);
    latencyByChat.set(key, normalized);
    if (normalizeChatId(activeChatId) === key && shouldDisplayChipText?.(normalized, key)) {
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

  function createLatencyPersistenceController({
    localStorageRef,
    storageKey,
    latencyByChat,
    maxEntries = 200,
    maxAgeMs = 24 * 60 * 60 * 1000,
    nowMs,
  }) {
    return {
      loadLatencyByChatFromStorage() {
        return loadLatencyByChatFromStorage({
          localStorageRef,
          storageKey,
          latencyByChat,
          maxEntries,
          maxAgeMs,
          nowMs: typeof nowMs === "function" ? nowMs() : nowMs,
        });
      },
      persistLatencyByChatToStorage() {
        return persistLatencyByChatToStorage({
          localStorageRef,
          storageKey,
          latencyByChat,
          maxEntries,
          nowMs: typeof nowMs === "function" ? nowMs() : nowMs,
        });
      },
    };
  }

  function createLatencyController({
    latencyByChat,
    getActiveChatId,
    hasLiveStreamController,
    setActivityChip,
    preserveViewportDuringUiMutation,
    latencyChip,
    streamDebugLog,
    onLatencyMapMutated,
    renderTraceLog,
    getDocumentVisibilityState,
  }) {
    function shouldDisplayChipTextForChat(value, chatId) {
      const key = normalizeChatId(chatId);
      const isLiveActive = Boolean(key) && Boolean(hasLiveStreamController?.(key));
      return shouldDisplayLatencyText(value, { isLiveActive });
    }

    function syncedLatencyChipText(chatId, { fallback = 'latency: --' } = {}) {
      const key = normalizeChatId(chatId);
      if (!key) return fallback;
      const stored = String(latencyByChat.get(key) || '').trim();
      if (shouldDisplayChipTextForChat(stored, key)) {
        return `latency: ${stored}`;
      }
      return fallback;
    }

    function setChatLatency(chatId, text) {
      const activeChatId = normalizeChatId(getActiveChatId?.());
      const targetKey = normalizeChatId(chatId);
      const normalized = String(text || "").trim() || "--";
      const result = nextLatencyState({
        latencyByChat,
        targetChatId: chatId,
        text,
        activeChatId,
        shouldDisplayChipText: shouldDisplayChipTextForChat,
      });

      onLatencyMapMutated?.(latencyByChat);

      streamDebugLog?.("latency-set", {
        chatId: Number(chatId),
        activeChatId: Number(activeChatId),
        text: normalized,
        hasChipText: Boolean(result.chipText),
      });

      if (result.chipText) {
        preserveViewportDuringUiMutation?.(() => {
          setActivityChip?.(latencyChip, result.chipText);
        });
      } else if (targetKey && activeChatId === targetKey && shouldDisplayChipTextForChat(normalized, targetKey)) {
        preserveViewportDuringUiMutation?.(() => {
          setActivityChip?.(latencyChip, `latency: ${normalized}`);
        });
        streamDebugLog?.("latency-fallback", {
          chatId: targetKey,
          activeChatId: Number(activeChatId),
        });
      }

      if (targetKey) {
        renderTraceLog?.("latency-update", {
          chatId: targetKey,
          activeChatId: Number(activeChatId),
          hidden: getDocumentVisibilityState?.() !== "visible",
          latency: normalized,
          chipText: String(latencyChip?.textContent || "").trim(),
        });
      }

      return result;
    }

    function syncActiveLatencyChip() {
      const key = normalizeChatId(getActiveChatId?.());
      setActivityChip?.(latencyChip, syncedLatencyChipText(key));
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
    getChatLatencyText,
    getStreamPhase = null,
    streamPhases = {},
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
    const PENDING_HANDOFF_LATENCY_GRACE_MS = 4000;
    const liveLatencyStartedAtByChat = new Map();
    const liveLatencyTouchedAtByChat = new Map();
    const reconnectDisplayTimerByChat = new Map();
    let liveLatencyIntervalId = null;

    function isActiveChat(chatId) {
      const key = normalizeChatId(chatId);
      return Boolean(key) && key === normalizeChatId(getActiveChatId?.());
    }

    function setLatencyChipForActiveChat(chatId, text) {
      const key = normalizeChatId(chatId);
      if (!key || !isActiveChat(key)) return false;
      setActivityChip?.(latencyChip, text);
      return true;
    }

    function setStreamStatusForActiveChat(chatId, text) {
      const key = normalizeChatId(chatId);
      if (!key || !isActiveChat(key)) return false;
      setStreamStatus?.(text);
      return true;
    }

    function setStreamChipForActiveChat(chatId, text) {
      const key = normalizeChatId(chatId);
      if (!key || !isActiveChat(key)) return false;
      setActivityChip?.(streamChip, text);
      return true;
    }

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

    function clearLiveLatency(chatId) {
      const key = normalizeChatId(chatId);
      if (!key) return;
      liveLatencyStartedAtByChat.delete(key);
      liveLatencyTouchedAtByChat.delete(key);
      stopLiveLatencyLoopIfIdle();
    }

    function touchLiveLatency(chatId, nowMs = Date.now()) {
      const key = normalizeChatId(chatId);
      if (!key) return;
      liveLatencyTouchedAtByChat.set(key, Number(nowMs) || Date.now());
    }

    function shouldPreserveLiveLatencyDuringPendingHandoff(chatId) {
      const key = normalizeChatId(chatId);
      if (!key) return false;
      const touchedAt = Number(liveLatencyTouchedAtByChat.get(key) || 0);
      if (!Number.isFinite(touchedAt) || touchedAt <= 0) return false;
      const now = Date.now();
      if ((now - touchedAt) > PENDING_HANDOFF_LATENCY_GRACE_MS) {
        return false;
      }
      const phase = typeof getStreamPhase === 'function' ? String(getStreamPhase(key) || '').trim().toLowerCase() : '';
      return phase === String(streamPhases.PENDING_TOOL || 'pending_tool')
        || phase === String(streamPhases.STREAMING_TOOL || 'streaming_tool')
        || phase === String(streamPhases.STREAMING_ASSISTANT || 'streaming_assistant');
    }

    function renderLiveLatencyFromStart(chatId) {
      const key = normalizeChatId(chatId);
      if (!key) return false;
      const startedAt = Number(liveLatencyStartedAtByChat.get(key) || 0);
      if (!startedAt) {
        return false;
      }
      const elapsedMs = Math.max(0, Date.now() - startedAt);
      const fallbackSeconds = `${Math.max(0, Math.ceil(elapsedMs / 1000))}s`;
      const runningLatency = `${formatLatency?.(elapsedMs) || fallbackSeconds} · live`;
      touchLiveLatency(key);
      setLatencyChipForActiveChat(key, `latency: ${runningLatency}`);
      setChatLatency?.(key, runningLatency);
      return true;
    }

    function tickLiveLatency() {
      const activeKey = normalizeChatId(getActiveChatId?.());
      if (!activeKey) {
        stopLiveLatencyLoopIfIdle();
        return;
      }
      const hasLiveController = typeof hasLiveStreamController === 'function'
        ? Boolean(hasLiveStreamController(activeKey))
        : liveLatencyStartedAtByChat.has(activeKey);
      if (!hasLiveController) {
        clearLiveLatency(activeKey);
        syncActiveLatencyChip?.();
        return;
      }
      if (!renderLiveLatencyFromStart(activeKey)) {
        stopLiveLatencyLoopIfIdle();
      }
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
      touchLiveLatency(key);
      tickLiveLatency();
      ensureLiveLatencyLoop();
    }

    function ensureResumedLiveLatency(chatId) {
      const key = normalizeChatId(chatId);
      if (!key || liveLatencyStartedAtByChat.has(key)) return;
      const storedLatencyText = String(getChatLatencyText?.(key) || '').trim();
      const resumedSeconds = parseLatencyDisplayToSeconds(storedLatencyText);
      if (resumedSeconds != null) {
        beginLiveLatency(key, { elapsedMs: resumedSeconds * 1000 });
        return;
      }
      beginLiveLatency(key);
    }

    function syncActivePendingStatus() {
      const activeKey = normalizeChatId(getActiveChatId?.());
      const chat = activeKey ? chats.get(activeKey) : null;
      if (chat?.pending) {
        const hasLiveController = activeKey && typeof hasLiveStreamController === 'function'
          ? Boolean(hasLiveStreamController(activeKey))
          : true;
        const preserveLiveLatency = activeKey && !hasLiveController && shouldPreserveLiveLatencyDuringPendingHandoff(activeKey);
        if (activeKey && !hasLiveController && !preserveLiveLatency) {
          clearLiveLatency(activeKey);
          syncActiveLatencyChip?.();
        }
        setStreamStatus?.(`Waiting for Hermes in ${chatLabel?.(activeKey) || "Chat"}`);
        setActivityChip?.(streamChip, `stream: pending · ${compactChatLabel?.(activeKey) || "Chat"}`);
        if (preserveLiveLatency) {
          renderLiveLatencyFromStart(activeKey);
        }
        return;
      }
      if (activeKey && hasLiveStreamController?.(activeKey)) {
        ensureResumedLiveLatency(activeKey);
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
      const key = normalizeChatId(chatId);
      clearReconnectTimer(key);
      setStreamStatusForActiveChat(key, `Hermes responding in ${chatLabel?.(key) || "Chat"}`);
      setStreamChipForActiveChat(key, `stream: active · ${compactChatLabel?.(key) || "Chat"}`);
      beginLiveLatency(key, { elapsedMs });
    }

    function markStreamError(chatId = null) {
      const key = normalizeChatId(chatId || getActiveChatId?.());
      clearReconnectTimer(key);
      clearLiveLatency(key);
      setStreamStatusForActiveChat(key, "Stream error");
      setStreamChipForActiveChat(key, "stream: error");
    }

    function markNetworkFailure(chatId = null) {
      const key = normalizeChatId(chatId || getActiveChatId?.());
      clearReconnectTimer(key);
      clearLiveLatency(key);
      setStreamStatusForActiveChat(key, "Network failure");
      setStreamChipForActiveChat(key, "stream: network failure");
    }

    function markStreamClosedEarly(chatId = null) {
      const key = normalizeChatId(chatId || getActiveChatId?.());
      clearReconnectTimer(key);
      clearLiveLatency(key);
      if (key) {
        setChatLatency?.(key, "--");
      }
      setStreamStatusForActiveChat(key, "Stream closed early");
      setStreamChipForActiveChat(key, "stream: closed early");
    }

    function markStreamQueued(chatId, { queuedAhead = null } = {}) {
      const key = normalizeChatId(chatId);
      const activeKey = normalizeChatId(getActiveChatId?.());
      if (!key || key !== activeKey) return;
      clearReconnectTimer(key);
      const hasLiveLatency = liveLatencyStartedAtByChat.has(key);
      const normalizedQueuedAhead = Number(queuedAhead);
      const queueLabel = Number.isFinite(normalizedQueuedAhead) && normalizedQueuedAhead > 0
        ? `queued · ahead: ${normalizedQueuedAhead}`
        : "queued...";
      setStreamStatus?.(`Queue update (${chatLabel?.(key) || "Chat"}): queued`);
      setActivityChip?.(streamChip, `stream: queued · ${compactChatLabel?.(key) || "Chat"}`);
      if (hasLiveLatency) {
        tickLiveLatency();
        return;
      }
      clearLiveLatency(key);
      setChatLatency?.(key, queueLabel);
      syncActiveLatencyChip?.();
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
        if (liveLatencyStartedAtByChat.has(key)) {
          tickLiveLatency();
          return;
        }
        setChatLatency?.(key, "reconnecting...");
        syncActiveLatencyChip?.();
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
      setLatencyChipForActiveChat(key, `latency: ${resolvedLatency}`);
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
        if (isActiveChat(key)) {
          setActivityChip?.(latencyChip, "latency: --");
        }
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
      setLatencyChipForActiveChat(key, "latency: --");
      setChatLatency?.(key, "--");
    }

    function markToolActivity(chatId) {
      const key = normalizeChatId(chatId);
      const activeKey = normalizeChatId(getActiveChatId?.());
      if (!key || key !== activeKey) return;
      clearReconnectTimer(key);
      ensureResumedLiveLatency(key);
      tickLiveLatency();
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

  const api = {
    nextLatencyState,
    loadLatencyByChatFromStorage,
    persistLatencyByChatToStorage,
    createLatencyPersistenceController,
    createLatencyController,
    createStreamActivityController,
  };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
  globalScope.HermesMiniappRuntimeLatency = api;
})(typeof window !== "undefined" ? window : globalThis);
