(function initHermesMiniappStreamController(globalScope) {
  function resolveTranscriptAuthorityHelpers() {
    if (globalScope.HermesMiniappRuntimeTranscriptAuthority) {
      return globalScope.HermesMiniappRuntimeTranscriptAuthority;
    }
    if (typeof module !== "undefined" && module.exports && typeof require === "function") {
      try {
        return require("./runtime_transcript_authority.js");
      } catch {
        return null;
      }
    }
    return null;
  }

  const transcriptAuthority = resolveTranscriptAuthorityHelpers();
  if (!transcriptAuthority) {
    throw new Error("HermesMiniappRuntimeTranscriptAuthority is required before stream_controller.js");
  }

  function resolveAttentionEffectsHelpers() {
    if (globalScope.HermesMiniappRuntimeAttentionEffects) {
      return globalScope.HermesMiniappRuntimeAttentionEffects;
    }
    if (typeof module !== "undefined" && module.exports && typeof require === "function") {
      try {
        return require("./runtime_attention_effects.js");
      } catch {
        return null;
      }
    }
    return null;
  }

  const attentionEffects = resolveAttentionEffectsHelpers();
  if (!attentionEffects) {
    throw new Error("HermesMiniappRuntimeAttentionEffects is required before stream_controller.js");
  }

  const createFirstAssistantNotificationController = attentionEffects.createFirstAssistantNotificationController;
  const describeDoneAttentionEffect = attentionEffects.describeDoneAttentionEffect;
  const describeEarlyCloseAttentionEffect = attentionEffects.describeEarlyCloseAttentionEffect;
  const describeResumeCompletionAttentionEffect = attentionEffects.describeResumeCompletionAttentionEffect;
  const executeAttentionEffect = attentionEffects.executeAttentionEffect;

  function createResumeRecoveryPolicy({
    setTimeoutFn = (...args) => setTimeout(...args),
    randomFn = () => Math.random(),
  } = {}) {
    const RESUME_RECOVERY_MAX_ATTEMPTS = 3;
    const RESUME_RECOVERY_BASE_DELAY_MS = 900;
    const RESUME_REATTACH_MIN_INTERVAL_MS = 1200;
    const RESUME_COMPLETE_SETTLE_MS = 2500;
    const RESUME_RECOVERY_TRANSIENT_ERROR_RE = /load failed|failed to fetch|network(?:error| failure| request failed)?|the network connection was lost|fetch failed|temporarily unavailable/i;

    function delayMs(ms) {
      return new Promise((resolve) => setTimeoutFn(resolve, Math.max(0, Number(ms) || 0)));
    }

    function isTransientResumeRecoveryError(error) {
      const message = String(error?.message || error || "").trim();
      return RESUME_RECOVERY_TRANSIENT_ERROR_RE.test(message);
    }

    function nextResumeRecoveryDelayMs(attempt) {
      const normalizedAttempt = Math.max(1, Number(attempt) || 1);
      const jitterMs = Math.floor(Math.max(0, Number(randomFn()) || 0) * 180);
      return RESUME_RECOVERY_BASE_DELAY_MS * normalizedAttempt + jitterMs;
    }

    return {
      RESUME_RECOVERY_MAX_ATTEMPTS,
      RESUME_REATTACH_MIN_INTERVAL_MS,
      RESUME_COMPLETE_SETTLE_MS,
      delayMs,
      isTransientResumeRecoveryError,
      nextResumeRecoveryDelayMs,
    };
  }

  function createToolTraceController({
    histories,
    cleanDisplayText,
    persistPendingStreamSnapshot,
  }) {
    function resetToolStream() {
      return;
    }

    function findPendingToolTraceMessage(chatId) {
      const key = Number(chatId);
      const history = histories.get(key) || [];
      for (let index = history.length - 1; index >= 0; index -= 1) {
        const item = history[index];
        if (item?.role === "tool" && item?.pending) {
          return item;
        }
      }
      return null;
    }

    function ensurePendingToolTraceMessage(chatId) {
      const key = Number(chatId);
      const history = histories.get(key) || [];
      const existing = findPendingToolTraceMessage(key);
      if (existing) return existing;

      const next = {
        role: "tool",
        body: "",
        created_at: new Date().toISOString(),
        pending: true,
        collapsed: false,
      };

      const firstPendingAssistantIndex = history.findIndex((item) => {
        if (!item?.pending) return false;
        const role = String(item?.role || "").toLowerCase();
        return role === "hermes" || role === "assistant";
      });
      if (firstPendingAssistantIndex >= 0) {
        history.splice(firstPendingAssistantIndex, 0, next);
      } else {
        history.push(next);
      }

      histories.set(key, history);
      return next;
    }

    function parseToolEventPayload(textOrPayload, explicitPayload) {
      if (explicitPayload && typeof explicitPayload === "object") {
        return explicitPayload;
      }
      if (textOrPayload && typeof textOrPayload === "object") {
        return textOrPayload;
      }
      return null;
    }

    function resolveToolLine(textOrPayload, payload) {
      if (typeof textOrPayload === "string" && textOrPayload.trim()) {
        return textOrPayload.trim();
      }
      if (!payload || typeof payload !== "object") return "";
      const line = payload.display || payload.preview || payload.tool_name || "Tool running";
      return String(line || "").trim();
    }

    function resolveToolDedupeKey(payload) {
      if (!payload || typeof payload !== "object") return "";
      const messageId = payload.message_id || payload.msg_id || payload.assistant_message_id || payload.turn_id;
      const toolCallId = payload.tool_call_id || payload.call_id;
      if (!messageId || !toolCallId) {
        return "";
      }
      const phase = payload.phase || payload.status || "";
      return `${messageId}::${toolCallId}::${phase}`;
    }

    function rebuildToolTraceBodyFromEntries(trace) {
      if (!trace || typeof trace !== "object") return;
      const order = Array.isArray(trace._toolTraceOrder) ? trace._toolTraceOrder : [];
      const linesByKey = trace._toolTraceLines && typeof trace._toolTraceLines === "object"
        ? trace._toolTraceLines
        : {};
      const lines = [];
      for (const dedupeKey of order) {
        const line = String(linesByKey[dedupeKey] || "").trim();
        if (line) {
          lines.push(line);
        }
      }
      trace.body = lines.join("\n");
    }

    function seedToolTraceEntriesFromBody(trace) {
      if (!trace || typeof trace !== "object") return;
      if (Array.isArray(trace._toolTraceOrder) && trace._toolTraceOrder.length && trace._toolTraceLines && typeof trace._toolTraceLines === "object") {
        return;
      }
      const existingLines = String(trace.body || "")
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean);
      if (!existingLines.length) {
        if (!Array.isArray(trace._toolTraceOrder)) {
          trace._toolTraceOrder = [];
        }
        if (!trace._toolTraceLines || typeof trace._toolTraceLines !== "object") {
          trace._toolTraceLines = {};
        }
        return;
      }
      trace._toolTraceOrder = existingLines.map((_, index) => `__restored__${index}`);
      trace._toolTraceLines = Object.fromEntries(
        existingLines.map((line, index) => [`__restored__${index}`, line]),
      );
    }

    function appendInlineToolTrace(chatId, textOrPayload, explicitPayload = null) {
      const payload = parseToolEventPayload(textOrPayload, explicitPayload);
      const line = resolveToolLine(textOrPayload, payload);
      if (!line) return;
      const key = Number(chatId);
      const trace = ensurePendingToolTraceMessage(key);
      const dedupeKey = resolveToolDedupeKey(payload);

      if (!dedupeKey) {
        trace.body = trace.body ? `${trace.body}\n${line}` : line;
        persistPendingStreamSnapshot?.(key);
        return;
      }

      seedToolTraceEntriesFromBody(trace);
      if (!Array.isArray(trace._toolTraceOrder)) {
        trace._toolTraceOrder = [];
      }
      if (!trace._toolTraceLines || typeof trace._toolTraceLines !== "object") {
        trace._toolTraceLines = {};
      }
      if (!trace._toolTraceOrder.includes(dedupeKey)) {
        trace._toolTraceOrder.push(dedupeKey);
      }
      trace._toolTraceLines[dedupeKey] = line;
      rebuildToolTraceBodyFromEntries(trace);
      persistPendingStreamSnapshot?.(key);
    }

    function dropPendingToolTraceMessages(chatId) {
      const key = Number(chatId);
      const history = histories.get(key) || [];
      const nextHistory = history.filter((item) => !(item?.role === "tool" && item?.pending));
      if (nextHistory.length !== history.length) {
        histories.set(key, nextHistory);
        persistPendingStreamSnapshot?.(key);
      }
      resetToolStream();
      return nextHistory.length !== history.length;
    }

    function finalizeInlineToolTrace(chatId) {
      const key = Number(chatId);
      const history = histories.get(key) || [];
      let changed = false;

      for (let index = history.length - 1; index >= 0; index -= 1) {
        const item = history[index];
        if (item?.role !== "tool" || !item?.pending) continue;

        const content = cleanDisplayText(item.body || "");
        if (!content) {
          history.splice(index, 1);
        } else {
          item.body = content;
          item.pending = false;
          item.collapsed = typeof item.collapsed === "boolean" ? item.collapsed : false;
          delete item._toolTraceOrder;
          delete item._toolTraceLines;
        }
        changed = true;
        break;
      }

      if (changed) {
        histories.set(key, history);
        persistPendingStreamSnapshot?.(key);
      }
      resetToolStream();
    }

    return {
      resetToolStream,
      findPendingToolTraceMessage,
      ensurePendingToolTraceMessage,
      appendInlineToolTrace,
      dropPendingToolTraceMessages,
      finalizeInlineToolTrace,
    };
  }

  function createVisibleStreamStatusController({
    getActiveChatId,
    setStreamStatus,
    setActivityChip,
    streamChip,
    latencyChip,
  }) {
    function normalizeChatId(value) {
      const parsed = Number(value);
      return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
    }

    function isActiveChat(chatId) {
      const key = normalizeChatId(chatId);
      return key != null && key === normalizeChatId(getActiveChatId());
    }

    function setStreamStatusForVisibleChat(chatId, text) {
      if (!isActiveChat(chatId)) return false;
      setStreamStatus(text);
      return true;
    }

    function setStreamChipForVisibleChat(chatId, text) {
      if (!isActiveChat(chatId)) return false;
      setActivityChip(streamChip, text);
      return true;
    }

    function setLatencyChipForVisibleChat(chatId, text) {
      if (!isActiveChat(chatId)) return false;
      setActivityChip(latencyChip, text);
      return true;
    }

    return {
      normalizeChatId,
      isActiveChat,
      setStreamStatusForVisibleChat,
      setStreamChipForVisibleChat,
      setLatencyChipForVisibleChat,
    };
  }

  function createReplayCursorController({ persistStreamCursor }) {
    const lastStreamEventIdByChat = new Map();

    function parseStreamEventId(payload) {
      if (!payload || typeof payload !== "object") return null;
      const eventId = Number(payload._event_id);
      if (!Number.isFinite(eventId) || eventId <= 0) return null;
      return Math.floor(eventId);
    }

    function shouldSkipReplayedEvent(chatId, payload) {
      const eventId = parseStreamEventId(payload);
      if (eventId == null) return false;
      const key = Number(chatId);
      const lastEventId = Number(lastStreamEventIdByChat.get(key) || 0);
      return eventId <= lastEventId;
    }

    function commitProcessedStreamEvent(chatId, payload) {
      const eventId = parseStreamEventId(payload);
      if (eventId == null) return null;
      const key = Number(chatId);
      lastStreamEventIdByChat.set(key, eventId);
      if (typeof persistStreamCursor === "function") {
        persistStreamCursor(key, eventId);
      }
      return eventId;
    }

    return {
      lastStreamEventIdByChat,
      parseStreamEventId,
      shouldSkipReplayedEvent,
      commitProcessedStreamEvent,
    };
  }

  function createStreamAbortRegistry() {
    const streamAbortControllers = new Map();
    const focusRestoreEligibleByChat = new Map();

    function setFocusRestoreEligibility(chatId, eligible) {
      const key = Number(chatId);
      if (!key) return;
      focusRestoreEligibleByChat.set(key, Boolean(eligible));
    }

    function setStreamAbortController(chatId, controller) {
      const key = Number(chatId);
      const existing = streamAbortControllers.get(key);
      if (existing && existing !== controller) {
        try {
          existing.abort();
        } catch {
          // best effort
        }
      }
      streamAbortControllers.set(key, controller);
    }

    function clearStreamAbortController(chatId, controller) {
      const key = Number(chatId);
      const existing = streamAbortControllers.get(key);
      if (!existing) return;
      if (controller && existing !== controller) return;
      streamAbortControllers.delete(key);
      focusRestoreEligibleByChat.delete(key);
    }

    function hasLiveStreamController(chatId) {
      const key = Number(chatId);
      const controller = streamAbortControllers.get(key);
      if (!controller) return false;
      return !Boolean(controller.signal?.aborted);
    }

    function abortStreamController(chatId) {
      const key = Number(chatId);
      const existing = streamAbortControllers.get(key);
      if (!existing) return false;
      try {
        existing.abort();
      } catch {
        // best effort
      }
      focusRestoreEligibleByChat.delete(key);
      return true;
    }

    function getAbortControllers() {
      return streamAbortControllers;
    }

    return {
      streamAbortControllers,
      focusRestoreEligibleByChat,
      setFocusRestoreEligibility,
      setStreamAbortController,
      clearStreamAbortController,
      hasLiveStreamController,
      abortStreamController,
      getAbortControllers,
    };
  }

  function createStreamSessionController({
    getActiveChatId,
    setStreamStatus,
    setActivityChip,
    streamChip,
    latencyChip,
    persistStreamCursor,
    triggerIncomingMessageHaptic,
    incrementUnread,
    renderTabs,
  }) {
    const statusController = createVisibleStreamStatusController({
      getActiveChatId,
      setStreamStatus,
      setActivityChip,
      streamChip,
      latencyChip,
    });
    const replayCursorController = createReplayCursorController({ persistStreamCursor });
    const abortRegistry = createStreamAbortRegistry();
    const notificationController = createFirstAssistantNotificationController({
      getActiveChatId,
      isDocumentHidden: () => (typeof document !== 'undefined' ? document.visibilityState !== 'visible' : false),
      triggerIncomingMessageHaptic,
      incrementUnread,
      renderTabs,
    });

    return {
      ...statusController,
      ...replayCursorController,
      ...abortRegistry,
      ...notificationController,
    };
  }

  function createTranscriptSignatureHelpers() {
    return {
      latestAssistantRenderSignature: transcriptAuthority.latestAssistantRenderSignature,
      preserveLatestCompletedAssistantMessage: transcriptAuthority.preserveLatestCompletedAssistantMessage,
      transcriptRenderSignature: transcriptAuthority.transcriptRenderSignature,
      describeActiveTranscriptRender: transcriptAuthority.describeActiveTranscriptRender,
      describeSpeculativeHistoryCommit: transcriptAuthority.describeSpeculativeHistoryCommit,
    };
  }

  function createTranscriptHydrationController(deps, signatureHelpers) {
    const {
      loadChatHistory,
      getActiveChatId,
      clearStreamCursor,
      clearPendingStreamSnapshot,
      clearReconnectResumeBlock,
      resetReconnectResumeBudget,
      upsertChat,
      histories,
      chats,
      pendingChats,
      mergeHydratedHistory,
      renderMessages,
      renderTraceLog,
      getRenderedTranscriptSignature = null,
    } = deps;
    const {
      latestAssistantRenderSignature,
      preserveLatestCompletedAssistantMessage,
      transcriptRenderSignature,
      describeActiveTranscriptRender,
      describeSpeculativeHistoryCommit,
    } = signatureHelpers;

    async function hydrateChatAfterGracefulResumeCompletion(chatId, { forceCompleted = false } = {}) {
      const key = Number(chatId);
      if (!key || typeof loadChatHistory !== "function") return;
      clearStreamCursor?.(key);
      clearPendingStreamSnapshot?.(key);
      if (forceCompleted) {
        clearReconnectResumeBlock?.(key);
        resetReconnectResumeBudget?.(key);
      }
      try {
        const isActiveChat = Number(getActiveChatId()) === key;
        const hydrated = await loadChatHistory(key, { activate: isActiveChat });
        const hydratedChat = hydrated && typeof hydrated === "object" && hydrated.chat && typeof hydrated.chat === "object"
          ? { ...hydrated.chat }
          : hydrated?.chat;
        if (forceCompleted && hydratedChat && typeof hydratedChat === "object") {
          hydratedChat.pending = false;
        }
        const previousHistory = histories?.get?.(key) || [];
        const previousAssistantSignature = latestAssistantRenderSignature(previousHistory);
        const previousTranscriptSignature = transcriptRenderSignature(previousHistory);
        let nextHistory = typeof mergeHydratedHistory === "function"
          ? mergeHydratedHistory({
            previousHistory,
            nextHistory: hydrated.history || [],
            serverPending: forceCompleted ? false : Boolean(hydratedChat?.pending),
            preserveCompletedToolTrace: Boolean(forceCompleted),
          })
          : (hydrated.history || []);
        if (forceCompleted) {
          nextHistory = preserveLatestCompletedAssistantMessage(previousHistory, nextHistory);
        }
        const nextAssistantSignature = latestAssistantRenderSignature(nextHistory);
        const nextTranscriptSignature = transcriptRenderSignature(nextHistory);
        const localChat = chats?.get?.(key) || null;
        const localPending = Boolean(localChat?.pending) || Boolean(pendingChats?.has?.(key));
        const speculativeCommitDecision = describeSpeculativeHistoryCommit({
          currentChat: localChat,
          incomingChat: hydratedChat,
          currentHistory: previousHistory,
          incomingHistory: nextHistory,
          source: forceCompleted ? 'inactive-terminal-reconcile' : 'activate-open',
          isActiveChat,
          localPending,
        });
        const shouldSkipInactiveTerminalCommit = !speculativeCommitDecision.commit;
        renderTraceLog("stream-done-hydrate-commit-check", {
          chatId: key,
          forceCompleted: Boolean(forceCompleted),
          active: Boolean(isActiveChat),
          localPending,
          previousTranscriptSignature,
          nextTranscriptSignature,
          skipped: shouldSkipInactiveTerminalCommit,
          unchangedWhilePending: Boolean(speculativeCommitDecision.reasons?.unchangedWhilePending),
        });
        if (shouldSkipInactiveTerminalCommit) {
          return;
        }
        if (typeof upsertChat === "function") {
          upsertChat(hydratedChat);
        }
        histories?.set?.(key, nextHistory);
        const renderDecision = describeActiveTranscriptRender({
          previousHistory,
          incomingHistory: nextHistory,
          renderedTranscriptSignature: isActiveChat && typeof getRenderedTranscriptSignature === 'function'
            ? String(getRenderedTranscriptSignature(key) || '')
            : '',
        });
        const shouldRenderActiveChat = Number(getActiveChatId()) === key
          && typeof renderMessages === "function"
          && renderDecision.shouldRenderActiveHistory;
        renderTraceLog("stream-done-hydrate", {
          chatId: key,
          forceCompleted: Boolean(forceCompleted),
          rendered: Boolean(shouldRenderActiveChat),
          previousAssistantSignature,
          nextAssistantSignature,
          previousTranscriptSignature,
          nextTranscriptSignature,
          renderedTranscriptSignature: renderDecision.renderedTranscriptSignature,
          shouldForceStaleRenderedTranscriptRender: Boolean(renderDecision.shouldForceStaleRenderedTranscriptRender),
        });
        if (shouldRenderActiveChat) {
          renderMessages(key, { preserveViewport: true });
        }
      } catch {
        // Best-effort hydration when reconnect says no active job.
      }
    }

    return {
      latestAssistantRenderSignature,
      transcriptRenderSignature,
      hydrateChatAfterGracefulResumeCompletion,
    };
  }

  function createVisibleTranscriptFallbackController(deps) {
    const {
      getActiveChatId,
      syncActiveMessageView,
      scheduleActiveMessageView,
    } = deps;

    function shouldForceImmediateTranscriptFallback(chatId) {
      const key = Number(chatId);
      if (!key) return false;
      return Number(getActiveChatId()) === key;
    }

    function reconcileVisibleTranscriptFallback(chatId) {
      if (shouldForceImmediateTranscriptFallback(chatId)) {
        syncActiveMessageView(chatId, { preserveViewport: true });
        return;
      }
      scheduleActiveMessageView(chatId);
    }

    return {
      shouldForceImmediateTranscriptFallback,
      reconcileVisibleTranscriptFallback,
    };
  }

  function createStreamTerminalEventController(deps, sessionController, hydrationController, fallbackController) {
    const {
      formatLatency,
      getActiveChatId,
      chatLabel,
      compactChatLabel,
      finalizeInlineToolTrace,
      updatePendingAssistant,
      markStreamUpdate,
      patchVisiblePendingAssistant,
      patchVisibleToolTrace,
      renderTraceLog,
      syncActiveMessageView,
      setChatLatency,
      incrementUnread,
      triggerIncomingMessageHaptic,
      renderTabs,
      finalizeStreamPendingState,
    } = deps;
    const {
      immediateFinalizedChats,
      consumeFirstAssistantNotification,
      setStreamStatusForVisibleChat,
      setStreamChipForVisibleChat,
    } = sessionController;
    const {
      hydrateChatAfterGracefulResumeCompletion,
    } = hydrationController;
    const {
      reconcileVisibleTranscriptFallback,
    } = fallbackController;

    function applyDonePayload(chatId, payload, builtReplyRef, { updateUnread = true } = {}) {
      builtReplyRef.value = payload.reply || builtReplyRef.value;
      finalizeInlineToolTrace(chatId);
      deps.clearStreamCursor?.(chatId);
      updatePendingAssistant(chatId, builtReplyRef.value, false);
      deps.clearPendingStreamSnapshot?.(chatId);
      const earlyAssistantNotification = consumeFirstAssistantNotification(chatId);
      const doneTurnCount = Number(payload?.turn_count || 0);
      const doneActiveChatId = Number(getActiveChatId());
      const doneHidden = typeof document !== 'undefined' ? document.visibilityState !== 'visible' : false;
      const doneAttention = describeDoneAttentionEffect({
        chatId,
        activeChatId: doneActiveChatId,
        hidden: doneHidden,
        updateUnread,
        earlyAssistantNotification,
        doneTurnCount,
      });
      executeAttentionEffect({
        chatId,
        effect: doneAttention,
        triggerIncomingMessageHaptic,
        incrementUnread,
        renderTabs,
      });
      markStreamUpdate(chatId);
      const patchedAssistant = patchVisiblePendingAssistant(chatId, builtReplyRef.value, false);
      const patchedToolTrace = patchVisibleToolTrace(chatId);
      const fallbackRender = !patchedAssistant || !patchedToolTrace;
      renderTraceLog('stream-done-patch', {
        chatId: Number(chatId),
        patchedAssistant,
        patchedToolTrace,
        fallbackRender,
      });
      if (fallbackRender || doneActiveChatId === Number(chatId)) {
        reconcileVisibleTranscriptFallback(chatId);
      }
      void hydrateChatAfterGracefulResumeCompletion(chatId, { forceCompleted: true });
      const deliveredLatency = formatLatency(payload.latency_ms);
      if (typeof deps.markStreamComplete === "function") {
        deps.markStreamComplete(chatId, deliveredLatency);
      } else {
        setChatLatency(chatId, deliveredLatency);
        setStreamStatusForVisibleChat(chatId, `Reply received in ${chatLabel(chatId)}`);
        setStreamChipForVisibleChat(chatId, `stream: complete · ${compactChatLabel(chatId)}`);
      }
      renderTraceLog("stream-done-state", {
        chatId: Number(chatId),
        activeChatId: doneActiveChatId,
        hidden: doneHidden,
        updateUnread: Boolean(updateUnread),
        hadEarlyAssistantHaptic: doneAttention.hadEarlyAssistantHaptic,
        hadEarlyAssistantUnread: doneAttention.hadEarlyAssistantUnread,
        shouldTriggerHapticOnDone: doneAttention.shouldTriggerHaptic,
        shouldIncrementUnreadOnDone: doneAttention.shouldIncrementUnread,
        doneTurnCount,
        doneMessageKey: doneAttention.messageKey,
        latencyMs: Number(payload?.latency_ms || 0),
        replyLength: builtReplyRef.value.length,
      });
      immediateFinalizedChats.add(Number(chatId));
      finalizeStreamPendingState(chatId, false);
      
    }

    function applyEarlyStreamCloseFallback(chatId, builtReplyRef, fallbackTraceEvent) {
      const fallbackReply = builtReplyRef.value || 'The response ended before completion.';
      finalizeInlineToolTrace(chatId);
      const earlyAssistantNotification = consumeFirstAssistantNotification(chatId);
      const earlyCloseHidden = typeof document !== 'undefined' ? document.visibilityState !== 'visible' : false;
      updatePendingAssistant(chatId, fallbackReply, false);
      const earlyCloseAttention = describeEarlyCloseAttentionEffect({
        chatId,
        activeChatId: getActiveChatId(),
        hidden: earlyCloseHidden,
        earlyAssistantNotification,
      });
      executeAttentionEffect({
        chatId,
        effect: earlyCloseAttention,
        triggerIncomingMessageHaptic,
        incrementUnread,
        renderTabs,
      });
      markStreamUpdate(chatId);
      const patchedAssistant = patchVisiblePendingAssistant(chatId, fallbackReply, false);
      const patchedToolTrace = patchVisibleToolTrace(chatId);
      renderTraceLog(fallbackTraceEvent, {
        chatId: Number(chatId),
        patchedAssistant,
        patchedToolTrace,
        fallbackRender: !patchedAssistant || !patchedToolTrace,
      });
      if (!patchedAssistant || !patchedToolTrace) {
        syncActiveMessageView(chatId, { preserveViewport: true });
      }
      if (typeof deps.markStreamClosedEarly === 'function') {
        deps.markStreamClosedEarly(chatId);
      } else {
        setChatLatency(chatId, '--');
        setStreamStatusForVisibleChat(chatId, 'Stream closed early');
        setStreamChipForVisibleChat(chatId, 'stream: closed early');
      }
      
    }

    return {
      applyDonePayload,
      applyEarlyStreamCloseFallback,
    };
  }

  function createStreamMetaEventController(deps, sessionController) {
    const {
      formatLatency,
      STREAM_PHASES,
      getStreamPhase,
      setStreamPhase,
      chatLabel,
      compactChatLabel,
      renderTraceLog,
      setChatLatency,
    } = deps;
    const {
      setStreamStatusForVisibleChat,
      setStreamChipForVisibleChat,
      setLatencyChipForVisibleChat,
    } = sessionController;

    function handleMetaEvent(chatId, payload) {
      if (!payload) {
        return false;
      }
      const detail = String(payload?.detail || '').toLowerCase();
      if (detail.includes('running') || payload?.job_status === 'running') {
        if (getStreamPhase(chatId) === STREAM_PHASES.IDLE) {
          setStreamPhase(chatId, STREAM_PHASES.PENDING_TOOL);
        }
      }
      if (payload.skin) {
        renderTraceLog('stream-meta-skin-ignored', {
          chatId: Number(chatId),
          incomingSkin: payload.skin,
        });
      }
      const summary = String(payload.detail || '').trim();
      if (!summary) {
        return false;
      }
      setStreamStatusForVisibleChat(chatId, `Queue update (${chatLabel(chatId)}): ${summary}`);
      if (payload.source === 'queue') {
        setStreamChipForVisibleChat(chatId, `stream: ${summary} · ${compactChatLabel(chatId)}`);
        if (payload.job_status === 'running') {
          const elapsedMs = Number(payload.elapsed_ms);
          if (typeof deps.markStreamActive === 'function') {
            deps.markStreamActive(chatId, {
              elapsedMs: Number.isFinite(elapsedMs) && elapsedMs >= 0 ? elapsedMs : null,
            });
          } else if (Number.isFinite(elapsedMs) && elapsedMs >= 0) {
            const runningLatency = `${formatLatency(elapsedMs)} · live`;
            setChatLatency(chatId, runningLatency);
            setLatencyChipForVisibleChat(chatId, `latency: ${runningLatency}`);
          }
        } else if (payload.job_status === 'queued') {
          const queuedAhead = Number(payload.queued_ahead);
          if (typeof deps.markStreamQueued === 'function') {
            deps.markStreamQueued(chatId, { queuedAhead });
          } else {
            const queueLabel = Number.isFinite(queuedAhead) && queuedAhead > 0
              ? `queued · ahead: ${queuedAhead}`
              : 'queued...';
            setChatLatency(chatId, queueLabel);
            setLatencyChipForVisibleChat(chatId, `latency: ${queueLabel}`);
          }
        }
      }
      return false;
    }

    return {
      handleMetaEvent,
    };
  }

  function createToolTraceEventController(deps, sessionController, fallbackController) {
    const {
      STREAM_PHASES,
      setStreamPhase,
      chatLabel,
      compactChatLabel,
      patchVisibleToolTrace,
      renderTraceLog,
    } = deps;
    const {
      setStreamStatusForVisibleChat,
      setStreamChipForVisibleChat,
    } = sessionController;
    const {
      reconcileVisibleTranscriptFallback,
    } = fallbackController;

    function handleToolEvent(chatId, payload) {
      setStreamPhase(chatId, STREAM_PHASES.STREAMING_TOOL);
      const display = payload.display || payload.preview || payload.tool_name || 'Tool running';
      deps.appendInlineToolTrace(chatId, display, payload);
      const patchedToolTrace = patchVisibleToolTrace(chatId);
      renderTraceLog('stream-tool-patch', {
        chatId: Number(chatId),
        phase: deps.getStreamPhase(chatId),
        patchedToolTrace,
        fallbackRender: !patchedToolTrace,
      });
      if (!patchedToolTrace) {
        reconcileVisibleTranscriptFallback(chatId);
      }
      if (typeof deps.markToolActivity === "function") {
        deps.markToolActivity(chatId);
      } else {
        setStreamStatusForVisibleChat(chatId, `Using tools in ${chatLabel(chatId)}`);
        setStreamChipForVisibleChat(chatId, `stream: tools active · ${compactChatLabel(chatId)}`);
      }
      return false;
    }

    return {
      handleToolEvent,
    };
  }

  function createAssistantChunkEventController(deps, sessionController, fallbackController) {
    const {
      STREAM_PHASES,
      setStreamPhase,
      updatePendingAssistant,
      markStreamUpdate,
      patchVisiblePendingAssistant,
      renderTraceLog,
    } = deps;
    const {
      notifyFirstAssistantChunk,
    } = sessionController;
    const {
      reconcileVisibleTranscriptFallback,
    } = fallbackController;

    function handleChunkEvent(chatId, payload, builtReplyRef) {
      setStreamPhase(chatId, STREAM_PHASES.STREAMING_ASSISTANT);
      const chunkText = String(payload.text || '');
      const hadAssistantText = builtReplyRef.value.length > 0;
      builtReplyRef.value += chunkText;
      if (!hadAssistantText && chunkText) {
        notifyFirstAssistantChunk(chatId);
      }
      updatePendingAssistant(chatId, builtReplyRef.value, true);
      markStreamUpdate(chatId);
      const patchedAssistant = patchVisiblePendingAssistant(chatId, builtReplyRef.value, true);
      renderTraceLog('stream-chunk-patch', {
        chatId: Number(chatId),
        phase: deps.getStreamPhase(chatId),
        patchedAssistant,
        fallbackRender: !patchedAssistant,
        chunkLength: String(payload.text || '').length,
        replyLength: builtReplyRef.value.length,
      });
      if (!patchedAssistant) {
        reconcileVisibleTranscriptFallback(chatId);
      }
      return false;
    }

    return {
      handleChunkEvent,
    };
  }

  function createStreamErrorEventController(deps, sessionController) {
    const {
      STREAM_PHASES,
      setStreamPhase,
      finalizeInlineToolTrace,
      updatePendingAssistant,
      markStreamUpdate,
      syncActiveMessageView,
      setChatLatency,
    } = deps;
    const {
      consumeFirstAssistantNotification,
      setStreamStatusForVisibleChat,
      setStreamChipForVisibleChat,
    } = sessionController;

    function handleErrorEvent(chatId, payload) {
      setStreamPhase(chatId, STREAM_PHASES.ERROR);
      finalizeInlineToolTrace(chatId);
      deps.clearStreamCursor?.(chatId);
      consumeFirstAssistantNotification(chatId);
      updatePendingAssistant(chatId, payload.error || 'Hermes stream failed.', false);
      markStreamUpdate(chatId);
      syncActiveMessageView(chatId, { preserveViewport: true });
      if (typeof deps.markStreamError === 'function') {
        deps.markStreamError(chatId);
      } else {
        setChatLatency(chatId, '--');
        setStreamStatusForVisibleChat(chatId, 'Stream error');
        setStreamChipForVisibleChat(chatId, 'stream: error');
      }
      return true;
    }

    return {
      handleErrorEvent,
    };
  }

  function createStreamNonTerminalEventController(deps, sessionController, fallbackController, terminalController) {
    const {
      STREAM_PHASES,
      setStreamPhase,
      formatLatency,
      getStreamPhase,
      chatLabel,
      compactChatLabel,
      patchVisibleToolTrace,
      renderTraceLog,
      appendInlineToolTrace,
      updatePendingAssistant,
      markStreamUpdate,
      patchVisiblePendingAssistant,
      finalizeInlineToolTrace,
      syncActiveMessageView,
      setChatLatency,
      clearStreamCursor,
      markToolActivity,
      markStreamActive,
      markStreamQueued,
      markStreamError,
    } = deps;
    const {
      applyDonePayload,
    } = terminalController;
    const metaController = createStreamMetaEventController({
      formatLatency,
      STREAM_PHASES,
      getStreamPhase,
      setStreamPhase,
      chatLabel,
      compactChatLabel,
      renderTraceLog,
      setChatLatency,
      markStreamActive,
      markStreamQueued,
    }, sessionController);
    const toolController = createToolTraceEventController({
      STREAM_PHASES,
      setStreamPhase,
      chatLabel,
      compactChatLabel,
      patchVisibleToolTrace,
      renderTraceLog,
      appendInlineToolTrace,
      getStreamPhase,
      markToolActivity,
    }, sessionController, fallbackController);
    const chunkController = createAssistantChunkEventController({
      STREAM_PHASES,
      setStreamPhase,
      updatePendingAssistant,
      markStreamUpdate,
      patchVisiblePendingAssistant,
      renderTraceLog,
      getStreamPhase,
    }, sessionController, fallbackController);
    const errorController = createStreamErrorEventController({
      STREAM_PHASES,
      setStreamPhase,
      finalizeInlineToolTrace,
      updatePendingAssistant,
      markStreamUpdate,
      syncActiveMessageView,
      setChatLatency,
      clearStreamCursor,
      markStreamError,
    }, sessionController);

    function handleStreamEvent(chatId, eventName, payload, builtReplyRef) {
      if (!payload) {
        return false;
      }
      if (eventName === 'meta') {
        return metaController.handleMetaEvent(chatId, payload);
      }
      if (eventName === 'tool') {
        return toolController.handleToolEvent(chatId, payload);
      }
      if (eventName === 'chunk') {
        return chunkController.handleChunkEvent(chatId, payload, builtReplyRef);
      }
      if (eventName === 'error') {
        return errorController.handleErrorEvent(chatId, payload);
      }
      if (eventName === 'done') {
        setStreamPhase(chatId, STREAM_PHASES.FINALIZED);
        applyDonePayload(chatId, payload, builtReplyRef);
        return true;
      }
      return false;
    }

    return {
      handleStreamEvent,
    };
  }

  function createTranscriptEventController(deps, sessionController, hydrationController) {
    const fallbackController = createVisibleTranscriptFallbackController({
      getActiveChatId: deps.getActiveChatId,
      syncActiveMessageView: deps.syncActiveMessageView,
      scheduleActiveMessageView: deps.scheduleActiveMessageView,
    });
    const terminalController = createStreamTerminalEventController({
      formatLatency: deps.formatLatency,
      getActiveChatId: deps.getActiveChatId,
      chatLabel: deps.chatLabel,
      compactChatLabel: deps.compactChatLabel,
      finalizeInlineToolTrace: deps.finalizeInlineToolTrace,
      updatePendingAssistant: deps.updatePendingAssistant,
      markStreamUpdate: deps.markStreamUpdate,
      patchVisiblePendingAssistant: deps.patchVisiblePendingAssistant,
      patchVisibleToolTrace: deps.patchVisibleToolTrace,
      renderTraceLog: deps.renderTraceLog,
      syncActiveMessageView: deps.syncActiveMessageView,
      setChatLatency: deps.setChatLatency,
      incrementUnread: deps.incrementUnread,
      triggerIncomingMessageHaptic: deps.triggerIncomingMessageHaptic,
      renderTabs: deps.renderTabs,
      finalizeStreamPendingState: deps.finalizeStreamPendingState,
      clearStreamCursor: deps.clearStreamCursor,
      clearPendingStreamSnapshot: deps.clearPendingStreamSnapshot,
      markStreamComplete: deps.markStreamComplete,
      markStreamClosedEarly: deps.markStreamClosedEarly,
    }, sessionController, hydrationController, fallbackController);
    const nonTerminalController = createStreamNonTerminalEventController(deps, sessionController, fallbackController, terminalController);

    return {
      shouldForceImmediateTranscriptFallback: fallbackController.shouldForceImmediateTranscriptFallback,
      reconcileVisibleTranscriptFallback: fallbackController.reconcileVisibleTranscriptFallback,
      applyDonePayload: terminalController.applyDonePayload,
      handleStreamEvent: nonTerminalController.handleStreamEvent,
      applyEarlyStreamCloseFallback: terminalController.applyEarlyStreamCloseFallback,
    };
  }

  function createStreamEventDispatchController({
    chatId,
    key,
    builtReplyRef,
    handleStreamEvent,
    shouldSkipReplayedEvent,
    commitProcessedStreamEvent,
    renderTraceLog,
    streamDebugLog,
  }) {
    function dispatchParsedEvent(eventName, payload, state) {
      streamDebugLog("sse-event", {
        chatId: Number(chatId),
        eventName,
        payloadKeys: payload && typeof payload === "object" ? Object.keys(payload) : [],
        clientReceiveMonotonicMs: typeof performance !== "undefined" && typeof performance.now === "function"
          ? Math.round(performance.now())
          : null,
        runtimePublishMonotonicMs: payload && typeof payload === "object" && payload._timing && Number.isFinite(Number(payload._timing.runtime_publish_monotonic_ms))
          ? Number(payload._timing.runtime_publish_monotonic_ms)
          : null,
        sseEmitMonotonicMs: payload && typeof payload === "object" && payload._timing && Number.isFinite(Number(payload._timing.sse_emit_monotonic_ms))
          ? Number(payload._timing.sse_emit_monotonic_ms)
          : null,
      });
      if (shouldSkipReplayedEvent(key, payload)) {
        return false;
      }
      if (eventName === "meta" && payload?.stream_segment_end) {
        state.expectedSegmentEnd = true;
      }
      const handledAsTerminal = handleStreamEvent(chatId, eventName, payload, builtReplyRef);
      if (!handledAsTerminal) {
        commitProcessedStreamEvent(key, payload);
      }
      if (handledAsTerminal) {
        state.terminalReceived = true;
        renderTraceLog("stream-terminal-event", {
          chatId: Number(chatId),
          eventName,
          bufferedTailLength: state.buffer.length,
          replyLength: builtReplyRef.value.length,
        });
      }
      return handledAsTerminal;
    }

    return {
      dispatchParsedEvent,
    };
  }

  function createSseStreamReadController({ response, renderTraceLog, streamDebugLog }) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();

    async function readChunk() {
      const result = await reader.read();
      if (result.done) {
        return { done: true, text: "" };
      }
      const decodedChunk = decoder.decode(result.value, { stream: true });
      streamDebugLog("sse-read", {
        chunkLength: decodedChunk.length,
      });
      return { done: false, text: decodedChunk };
    }

    function splitBufferedEvents(buffer) {
      const events = buffer.split(/\r?\n\r?\n/);
      return {
        events: events.slice(0, -1),
        tail: events.at(-1) || "",
      };
    }


    async function cancelReader() {
      try {
        await reader.cancel();
      } catch {
        // best effort
      }
    }

    function logReaderClosed({ chatId, terminalReceived, buffer }) {
      renderTraceLog("stream-reader-closed", {
        chatId: Number(chatId),
        terminalReceived,
        bufferedTailLength: buffer.length,
      });
    }

    return {
      readChunk,
      splitBufferedEvents,
      cancelReader,
      logReaderClosed,
    };
  }

  function createTranscriptBufferController({
    parseSseEvent,
    dispatchController,
    renderTraceLog,
    streamDebugLog,
    shouldSkipReplayedEvent,
    chatId,
    key,
    builtReplyRef,
  }) {
    function createConsumeState() {
      return {
        buffer: '',
        terminalReceived: false,
        expectedSegmentEnd: false,
      };
    }

    function appendChunk(state, text) {
      state.buffer += text;
      const events = state.buffer.split(/\r?\n\r?\n/);
      state.buffer = events.at(-1) || '';
      return events.slice(0, -1);
    }

    function drainBufferedEvents(state, rawEvents) {
      for (const rawEvent of rawEvents) {
        const parsed = parseSseEvent(rawEvent);
        if (!parsed) continue;
        const eventName = parsed.eventName || parsed.event || 'message';
        const payload = parsed.payload;
        const handledAsTerminal = dispatchController.dispatchParsedEvent(eventName, payload, state);
        if (handledAsTerminal) {
          break;
        }
      }
    }

    function drainTailBuffer(state) {
      if (state.terminalReceived || !state.buffer.trim()) {
        return;
      }
      const trimmedBuffer = state.buffer.trim();
      const parsed = parseSseEvent(trimmedBuffer);
      const eventName = parsed?.eventName || parsed?.event || 'message';
      const payload = parsed?.payload;
      streamDebugLog('sse-buffer-tail', {
        chatId: Number(chatId),
        eventName,
        hasPayload: Boolean(payload),
        tailLength: trimmedBuffer.length,
      });
      if (payload && !shouldSkipReplayedEvent(key, payload)) {
        const handledAsTerminal = dispatchController.dispatchParsedEvent(eventName, payload, state);
        if (handledAsTerminal) {
          renderTraceLog('stream-terminal-buffer-tail', {
            chatId: Number(chatId),
            eventName,
            tailLength: trimmedBuffer.length,
            replyLength: builtReplyRef.value.length,
          });
        }
      }
    }

    return {
      createConsumeState,
      appendChunk,
      drainBufferedEvents,
      drainTailBuffer,
    };
  }

  function createTranscriptReadLoopController({
    readerController,
    bufferController,
    renderTraceLog,
    chatId,
    builtReplyRef,
  }) {
    async function readUntilTerminal(state) {
      while (true) {
        const { done, text } = await readerController.readChunk();
        if (done) {
          readerController.logReaderClosed({ chatId, terminalReceived: state.terminalReceived, buffer: state.buffer });
          break;
        }
        const rawEvents = bufferController.appendChunk(state, text);
        bufferController.drainBufferedEvents(state, rawEvents);
        if (state.terminalReceived) {
          break;
        }
      }
    }

    function buildConsumeResult(state, suppressEarlyCloseFallback, fallbackTraceEvent, applyEarlyStreamCloseFallback) {
      bufferController.drainTailBuffer(state);
      const earlyClosed = !state.terminalReceived;
      renderTraceLog('stream-consume-finished', {
        chatId: Number(chatId),
        terminalReceived: state.terminalReceived,
        earlyClosed,
        expectedSegmentEnd: state.expectedSegmentEnd,
        suppressEarlyCloseFallback: Boolean(suppressEarlyCloseFallback),
        replyLength: builtReplyRef.value.length,
      });
      if (earlyClosed && !suppressEarlyCloseFallback) {
        applyEarlyStreamCloseFallback(chatId, builtReplyRef, fallbackTraceEvent);
      }
      return {
        terminalReceived: state.terminalReceived,
        earlyClosed,
        expectedSegmentEnd: state.expectedSegmentEnd,
      };
    }

    return {
      readUntilTerminal,
      buildConsumeResult,
    };
  }

  function createTranscriptConsumeController(deps, sessionController, eventController) {
    const {
      parseSseEvent,
      renderTraceLog,
      streamDebugLog,
    } = deps;
    const {
      lastStreamEventIdByChat,
      shouldSkipReplayedEvent,
      commitProcessedStreamEvent,
    } = sessionController;
    const {
      handleStreamEvent,
      applyEarlyStreamCloseFallback,
    } = eventController;

    async function consumeStreamResponse(chatId, response, builtReplyRef, {
      fallbackTraceEvent,
      suppressEarlyCloseFallback = false,
      resetReplayCursor = false,
    } = {}) {
      const key = Number(chatId);
      if (resetReplayCursor) {
        lastStreamEventIdByChat.delete(key);
      }
      const readerController = createSseStreamReadController({ response, renderTraceLog, streamDebugLog: (eventName, payload) => streamDebugLog(eventName, { chatId: Number(chatId), ...payload }) });
      const dispatchController = createStreamEventDispatchController({
        chatId,
        key,
        builtReplyRef,
        handleStreamEvent,
        shouldSkipReplayedEvent,
        commitProcessedStreamEvent,
        renderTraceLog,
        streamDebugLog,
      });
      const bufferController = createTranscriptBufferController({
        parseSseEvent,
        dispatchController,
        renderTraceLog,
        streamDebugLog,
        shouldSkipReplayedEvent,
        chatId,
        key,
        builtReplyRef,
      });
      const readLoopController = createTranscriptReadLoopController({
        readerController,
        bufferController,
        renderTraceLog,
        chatId,
        builtReplyRef,
      });
      const state = bufferController.createConsumeState();

      await readLoopController.readUntilTerminal(state);

      if (state.terminalReceived) {
        await readerController.cancelReader();
      }

      return readLoopController.buildConsumeResult(
        state,
        suppressEarlyCloseFallback,
        fallbackTraceEvent,
        applyEarlyStreamCloseFallback,
      );
    }

    async function consumeStreamWithReconnect(chatId, response, builtReplyRef, {
      fallbackTraceEvent,
      onEarlyClose,
      resetReplayCursor = false,
    } = {}) {
      const consumeResult = await consumeStreamResponse(chatId, response, builtReplyRef, {
        fallbackTraceEvent,
        suppressEarlyCloseFallback: true,
        resetReplayCursor,
      });
      if (!consumeResult?.earlyClosed) {
        renderTraceLog('stream-reconnect-not-needed', {
          chatId: Number(chatId),
          terminalReceived: Boolean(consumeResult?.terminalReceived),
        });
        return false;
      }
      renderTraceLog('stream-reconnect-needed', {
        chatId: Number(chatId),
        terminalReceived: Boolean(consumeResult?.terminalReceived),
        expectedSegmentEnd: Boolean(consumeResult?.expectedSegmentEnd),
        replyLength: builtReplyRef.value.length,
      });
      if (typeof onEarlyClose === 'function') {
        await onEarlyClose({
          expectedSegmentEnd: Boolean(consumeResult?.expectedSegmentEnd),
        });
      }
      return true;
    }

    return {
      consumeStreamResponse,
      consumeStreamWithReconnect,
    };
  }

  function createStreamTranscriptController(deps, sessionController) {
    const signatureHelpers = createTranscriptSignatureHelpers();
    const hydrationController = createTranscriptHydrationController({
      loadChatHistory: deps.loadChatHistory,
      getActiveChatId: deps.getActiveChatId,
      clearStreamCursor: deps.clearStreamCursor,
      clearPendingStreamSnapshot: deps.clearPendingStreamSnapshot,
      clearReconnectResumeBlock: deps.clearReconnectResumeBlock,
      resetReconnectResumeBudget: deps.resetReconnectResumeBudget,
      upsertChat: deps.upsertChat,
      histories: deps.histories,
      chats: deps.chats,
      pendingChats: deps.pendingChats,
      mergeHydratedHistory: deps.mergeHydratedHistory,
      renderMessages: deps.renderMessages,
      renderTraceLog: deps.renderTraceLog,
      getRenderedTranscriptSignature: deps.getRenderedTranscriptSignature,
    }, signatureHelpers);
    const eventController = createTranscriptEventController({
      STREAM_PHASES: deps.STREAM_PHASES,
      setStreamPhase: deps.setStreamPhase,
      getStreamPhase: deps.getStreamPhase,
      getActiveChatId: deps.getActiveChatId,
      syncActiveMessageView: deps.syncActiveMessageView,
      scheduleActiveMessageView: deps.scheduleActiveMessageView,
      formatLatency: deps.formatLatency,
      chatLabel: deps.chatLabel,
      compactChatLabel: deps.compactChatLabel,
      appendInlineToolTrace: deps.appendInlineToolTrace,
      finalizeInlineToolTrace: deps.finalizeInlineToolTrace,
      updatePendingAssistant: deps.updatePendingAssistant,
      markStreamUpdate: deps.markStreamUpdate,
      patchVisiblePendingAssistant: deps.patchVisiblePendingAssistant,
      patchVisibleToolTrace: deps.patchVisibleToolTrace,
      renderTraceLog: deps.renderTraceLog,
      setChatLatency: deps.setChatLatency,
      incrementUnread: deps.incrementUnread,
      triggerIncomingMessageHaptic: deps.triggerIncomingMessageHaptic,
      renderTabs: deps.renderTabs,
      finalizeStreamPendingState: deps.finalizeStreamPendingState,
      clearStreamCursor: deps.clearStreamCursor,
      clearPendingStreamSnapshot: deps.clearPendingStreamSnapshot,
      markStreamComplete: deps.markStreamComplete,
      markStreamClosedEarly: deps.markStreamClosedEarly,
      markToolActivity: deps.markToolActivity,
      markStreamActive: deps.markStreamActive,
      markStreamQueued: deps.markStreamQueued,
      markStreamError: deps.markStreamError,
    }, sessionController, hydrationController);
    const consumeController = createTranscriptConsumeController({
      parseSseEvent: deps.parseSseEvent,
      renderTraceLog: deps.renderTraceLog,
      streamDebugLog: deps.streamDebugLog,
    }, sessionController, eventController);

    return {
      ...signatureHelpers,
      ...hydrationController,
      ...eventController,
      ...consumeController,
    };
  }

  function createStreamSendRequestController(deps, transcriptController, getResumePendingChatStream) {
    const {
      STREAM_PHASES,
      setStreamPhase,
      chats,
      pendingChats,
      updatePendingAssistant,
      markStreamUpdate,
      syncActiveMessageView,
      parseStreamErrorPayload,
      summarizeUiFailure,
      setIsAuthenticated,
      authStatusEl,
      authPayload,
      fetchImpl = (...args) => fetch(...args),
      triggerIncomingMessageHaptic,
    } = deps;
    const {
      hydrateChatAfterGracefulResumeCompletion,
      consumeStreamWithReconnect,
    } = transcriptController;

    async function executeSendStreamRequest({
      chatId,
      cleaned,
      interruptRequested,
      streamController,
      builtReplyRef,
    }) {
      let wasAborted = false;
      let shouldResumeAfterFinally = false;
      try {
        const resumePendingChatStream = getResumePendingChatStream();
        const response = await fetchImpl("/api/chat/stream", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(authPayload({
            chat_id: chatId,
            message: cleaned,
            interrupt: interruptRequested,
          })),
          signal: streamController.signal,
        });

        if (!response.ok || !response.body) {
          const fallback = await response.text();
          const parsedError = parseStreamErrorPayload(fallback);
          const alreadyWorking = response.status === 409;
          const sanitizedFallbackMessage = summarizeUiFailure(parsedError.error || fallback, {
            status: response.status,
            fallback: "Hermes call failed.",
          });
          if (alreadyWorking) {
            await resumePendingChatStream(chatId, { force: true });
            return { wasAborted, shouldResumeAfterFinally };
          }

          setStreamPhase(chatId, STREAM_PHASES.ERROR);
          if (/Telegram init data is too old/i.test(parsedError.error || fallback || "")) {
            setIsAuthenticated?.(false);
            if (authStatusEl) {
              authStatusEl.textContent = "Session expired";
            }
            updatePendingAssistant(chatId, "Telegram session expired. Close and reopen the mini app to refresh auth.", false);
          } else {
            updatePendingAssistant(chatId, sanitizedFallbackMessage, false);
          }
          syncActiveMessageView(chatId, { preserveViewport: true });
          deps.markStreamError?.(chatId);
          return { wasAborted, shouldResumeAfterFinally };
        }

        const resumed = await consumeStreamWithReconnect(chatId, response, builtReplyRef, {
          fallbackTraceEvent: "stream-fallback-patch",
          resetReplayCursor: true,
          onEarlyClose: async ({ expectedSegmentEnd = false } = {}) => {
            if (expectedSegmentEnd) {
              deps.resetReconnectResumeBudget?.(chatId);
            }
            wasAborted = true;
            shouldResumeAfterFinally = true;
          },
        });
        if (resumed) {
          return { wasAborted, shouldResumeAfterFinally };
        }
      } catch (error) {
        if (error?.name === "AbortError") {
          wasAborted = true;
          return { wasAborted, shouldResumeAfterFinally };
        }

        if (shouldResumeAfterFinally) {
          return { wasAborted, shouldResumeAfterFinally };
        }

        const transientNetworkFailure = deps.isTransientResumeRecoveryError?.(error);
        if (transientNetworkFailure) {
          await hydrateChatAfterGracefulResumeCompletion(chatId, { forceCompleted: true });
          const stillPending = Boolean(chats.get(chatId)?.pending) || pendingChats.has(chatId);
          if (!stillPending) {
            setStreamPhase(chatId, STREAM_PHASES.FINALIZED);
            executeAttentionEffect({
              chatId,
              effect: describeResumeCompletionAttentionEffect({ chatId }),
              triggerIncomingMessageHaptic,
            });
            return { wasAborted, shouldResumeAfterFinally };
          }
          wasAborted = true;
          shouldResumeAfterFinally = true;
          return { wasAborted, shouldResumeAfterFinally };
        }

        setStreamPhase(chatId, STREAM_PHASES.ERROR);
        deps.finalizeInlineToolTrace(chatId);
        updatePendingAssistant(chatId, `Network failure: ${error.message}`, false);
        markStreamUpdate(chatId);
        syncActiveMessageView(chatId, { preserveViewport: true });
        deps.markNetworkFailure?.(chatId);
      }

      return { wasAborted, shouldResumeAfterFinally };
    }

    return {
      executeSendStreamRequest,
    };
  }

  function createStreamSendController(
    deps,
    sessionController,
    transcriptController,
    focusController,
    finalizeController,
    getResumePendingChatStream,
  ) {
    const {
      STREAM_PHASES,
      setStreamPhase,
      chats,
      pendingChats,
      chatLabel,
      updatePendingAssistant,
      markStreamUpdate,
      syncActiveMessageView,
      getActiveChatId,
      promptEl,
      renderTabs,
      updateComposerState,
      syncClosingConfirmation,
      appendSystemMessage,
      authPayload,
      parseStreamErrorPayload,
      summarizeUiFailure,
      getIsAuthenticated,
      setIsAuthenticated,
      authStatusEl,
      dropPendingToolTraceMessages,
      addLocalMessage,
      setDraft,
      resetToolStream,
      clearReconnectResumeBlock,
      resetReconnectResumeBudget,
      suppressBlockedChatPending,
      isReconnectResumeBlocked,
      markChatStreamPending,
      clearStreamCursor,
      clearPendingStreamSnapshot,
      fetchImpl = (...args) => fetch(...args),
      setTimeoutFn = (...args) => setTimeout(...args),
      finalizeInlineToolTrace,
      triggerIncomingMessageHaptic,
    } = deps;
    const {
      setFocusRestoreEligibility,
      setStreamAbortController,
    } = sessionController;
    const {
      focusMessagesPaneIfActiveChat,
      shouldRestoreComposerFocus,
    } = focusController;
    const {
      finalizeStreamLifecycle,
    } = finalizeController;
    const requestController = createStreamSendRequestController(deps, transcriptController, getResumePendingChatStream);

    async function sendPrompt(message) {
      if (!getIsAuthenticated?.() || !getActiveChatId?.()) {
        appendSystemMessage("Still signing you in. Try again in a moment.");
        return;
      }

      const cleaned = String(message || "").trim();
      if (!cleaned) return;

      const chatId = Number(getActiveChatId());
      if (isReconnectResumeBlocked?.(chatId)) {
        clearReconnectResumeBlock?.(chatId);
        suppressBlockedChatPending?.(chatId);
      }
      resetReconnectResumeBudget?.(chatId);
      const serverPending = Boolean(chats.get(chatId)?.pending);
      const interruptRequested = pendingChats.has(chatId) || serverPending;

      markChatStreamPending?.({
        chatId,
        pendingChats,
        chats,
        setStreamPhase,
      });
      syncClosingConfirmation();
      renderTabs();
      updateComposerState();

      dropPendingToolTraceMessages?.(chatId);
      addLocalMessage?.(chatId, { role: "operator", body: cleaned, created_at: new Date().toISOString() });
      if (chatId === Number(getActiveChatId())) {
        if (promptEl) {
          promptEl.value = "";
        }
        setDraft?.(chatId, "");
      }
      syncActiveMessageView(chatId, { preserveViewport: true });
      focusMessagesPaneIfActiveChat(chatId);

      clearStreamCursor?.(chatId);
      clearPendingStreamSnapshot?.(chatId);
      resetToolStream?.();
      deps.markStreamActive?.(chatId);

      const builtReplyRef = { value: "" };
      const streamController = new AbortController();
      setFocusRestoreEligibility(chatId, shouldRestoreComposerFocus(chatId));
      setStreamAbortController(chatId, streamController);

      let sendState = {
        wasAborted: false,
        shouldResumeAfterFinally: false,
      };
      try {
        sendState = await requestController.executeSendStreamRequest({
          chatId,
          cleaned,
          interruptRequested,
          streamController,
          builtReplyRef,
        });
      } finally {
        await finalizeStreamLifecycle(chatId, streamController, { wasAborted: sendState.wasAborted });
        if (sendState.shouldResumeAfterFinally) {
          setTimeoutFn(() => {
            void getResumePendingChatStream()(chatId, { force: true });
          }, 0);
        }
      }
    }

    return {
      sendPrompt,
    };
  }

  function createStreamResumeAttemptController(deps, transcriptController) {
    const {
      STREAM_PHASES,
      setStreamPhase,
      chats,
      pendingChats,
      chatLabel,
      getActiveChatId,
      parseStreamErrorPayload,
      summarizeUiFailure,
      finalizeInlineToolTrace,
      triggerIncomingMessageHaptic,
      clearPendingStreamSnapshot,
      RESUME_COMPLETE_SETTLE_MS = 2500,
      isTransientResumeRecoveryError,
      nextResumeRecoveryDelayMs,
      delayMs,
      fetchImpl = (...args) => fetch(...args),
      authPayload,
    } = deps;
    const {
      hydrateChatAfterGracefulResumeCompletion,
      consumeStreamWithReconnect,
    } = transcriptController;

    async function executeResumeAttempt({
      key,
      attempt,
      builtReplyRef,
      streamController,
      maxAttempts,
      setShouldResumeAfterFinally,
    }) {
      let wasAborted = false;
      try {
        const response = await fetchImpl("/api/chat/stream/resume", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(authPayload({ chat_id: key, after_event_id: deps.getStoredStreamCursor?.(key) })),
          signal: streamController.signal,
        });

        if (!response.ok || !response.body) {
          const fallback = await response.text();
          const parsedResumeError = parseStreamErrorPayload(fallback);
          const sanitizedResumeFailure = summarizeUiFailure(parsedResumeError.error || fallback, {
            status: response.status,
            fallback: `Resume failed: ${response.status}`,
          });
          const noActiveJob = response.status === 409
            && /no active hermes job/i.test(parsedResumeError.error || fallback || "");
          if (noActiveJob) {
            deps.resumeCooldownUntilByChat?.set?.(key, Date.now() + RESUME_COMPLETE_SETTLE_MS);
            setStreamPhase(key, STREAM_PHASES.FINALIZED);
            clearPendingStreamSnapshot?.(key);
            await hydrateChatAfterGracefulResumeCompletion(key, { forceCompleted: true });
            executeAttentionEffect({
              chatId: key,
              effect: describeResumeCompletionAttentionEffect({ chatId: key }),
              triggerIncomingMessageHaptic,
            });
            deps.markResumeAlreadyComplete?.(key);
            return { wasAborted, completed: true, shouldContinue: false };
          }
          throw new Error(sanitizedResumeFailure);
        }

        const resumed = await consumeStreamWithReconnect(key, response, builtReplyRef, {
          fallbackTraceEvent: "stream-resume-fallback-patch",
          onEarlyClose: async ({ expectedSegmentEnd = false } = {}) => {
            if (expectedSegmentEnd) {
              deps.resetReconnectResumeBudget?.(key);
            }
            wasAborted = true;
            setShouldResumeAfterFinally(true);
          },
        });
        if (resumed) {
          return { wasAborted, completed: true, shouldContinue: false };
        }
        return { wasAborted, completed: true, shouldContinue: false };
      } catch (error) {
        if (error?.name === "AbortError") {
          wasAborted = true;
          return { wasAborted, completed: true, shouldContinue: false };
        }
        const transientReconnectFailure = isTransientResumeRecoveryError(error);
        const RESUME_RECOVERY_MAX_ATTEMPTS = maxAttempts;
        const hasAttemptsRemaining = transientReconnectFailure && attempt < maxAttempts;
        if (hasAttemptsRemaining) {
          wasAborted = true;
          console.warn(`[W_STREAM_RECONNECT_RETRY] chat=${key} attempt=${attempt}/${RESUME_RECOVERY_MAX_ATTEMPTS}`, error);
          if (Number(getActiveChatId()) === key) {
            deps.markStreamReconnecting?.(key, {
              attempt: attempt + 1,
              maxAttempts,
            });
          }
          await delayMs(nextResumeRecoveryDelayMs(attempt));
          return { wasAborted, completed: false, shouldContinue: true };
        }

        if (transientReconnectFailure) {
          await hydrateChatAfterGracefulResumeCompletion(key, { forceCompleted: true });
          const stillPending = Boolean(chats.get(key)?.pending) || pendingChats.has(key);
          if (!stillPending) {
            deps.resumeCooldownUntilByChat?.set?.(key, Date.now() + RESUME_COMPLETE_SETTLE_MS);
            setStreamPhase(key, STREAM_PHASES.FINALIZED);
            executeAttentionEffect({
              chatId: key,
              effect: describeResumeCompletionAttentionEffect({ chatId: key }),
              triggerIncomingMessageHaptic,
            });
            deps.markResumeAlreadyComplete?.(key);
            return { wasAborted, completed: true, shouldContinue: false };
          }
        }

        deps.blockReconnectResume?.(key);
        setStreamPhase(key, STREAM_PHASES.ERROR);
        finalizeInlineToolTrace(key);
        console.warn(`[E_STREAM_RECONNECT_FAILED] chat=${key}`, error);
        deps.appendSystemMessage(`Could not reconnect '${chatLabel(key)}': ${error.message}`, key);
        deps.appendSystemMessage(`Reconnect recovery is paused for '${chatLabel(key)}'. Send a new message to try again.`, key);
        deps.renderTabs();
        deps.updateComposerState();
        deps.syncActivePendingStatus?.();
        if (Number(getActiveChatId()) === key) {
          deps.markReconnectFailed?.(key);
        }
        return { wasAborted, completed: true, shouldContinue: false };
      }
    }

    return {
      executeResumeAttempt,
    };
  }

  function createStreamResumeController(deps, sessionController, transcriptController, finalizeController) {
    const {
      STREAM_PHASES,
      setStreamPhase,
      chats,
      pendingChats,
      chatLabel,
      getActiveChatId,
      getIsAuthenticated,
      renderTabs,
      updateComposerState,
      syncClosingConfirmation,
      appendSystemMessage,
      authPayload,
      parseStreamErrorPayload,
      summarizeUiFailure,
      finalizeInlineToolTrace,
      triggerIncomingMessageHaptic,
      clearPendingStreamSnapshot,
      RESUME_RECOVERY_MAX_ATTEMPTS = 3,
      RESUME_REATTACH_MIN_INTERVAL_MS = 1200,
      RESUME_COMPLETE_SETTLE_MS = 2500,
      MAX_AUTO_RESUME_CYCLES_PER_CHAT = 6,
      isTransientResumeRecoveryError,
      nextResumeRecoveryDelayMs,
      delayMs,
      fetchImpl = (...args) => fetch(...args),
      setTimeoutFn = (...args) => setTimeout(...args),
    } = deps;
    const {
      hasLiveStreamController,
      abortStreamController,
      setFocusRestoreEligibility,
      setStreamAbortController,
    } = sessionController;
    const {
      finalizeStreamLifecycle,
    } = finalizeController;
    const attemptController = createStreamResumeAttemptController(deps, transcriptController);

    async function resumePendingChatStream(chatId, { force = false } = {}) {
      const key = Number(chatId);
      if (!key || !getIsAuthenticated?.()) return;
      let shouldResumeAfterFinally = false;
      try {
        if (deps.isReconnectResumeBlocked?.(key)) {
          deps.suppressBlockedChatPending?.(key);
          renderTabs();
          updateComposerState();
          deps.syncActivePendingStatus?.();
          return;
        }
        const now = Date.now();
        const cooldownUntil = Number(deps.resumeCooldownUntilByChat?.get?.(key) || 0);
        if (cooldownUntil > now) {
          return;
        }
        if (deps.resumeInFlightByChat?.has?.(key)) {
          return;
        }
        const hasLiveController = hasLiveStreamController(key);
        if (hasLiveController && !force) return;
        const lastAttemptAt = Number(deps.resumeAttemptedAtByChat?.get?.(key) || 0);
        if (lastAttemptAt > 0 && (now - lastAttemptAt) < RESUME_REATTACH_MIN_INTERVAL_MS) {
          return;
        }
        const chatPending = Boolean(chats.get(key)?.pending);
        if (!chatPending && !force) return;

        const reconnectBudget = deps.consumeReconnectResumeBudget?.(key) || {
          allowed: true,
          attempts: 1,
          maxAttempts: MAX_AUTO_RESUME_CYCLES_PER_CHAT,
        };
        if (!reconnectBudget.allowed) {
          deps.blockReconnectResume?.(key);
          setStreamPhase(key, STREAM_PHASES.ERROR);
          finalizeInlineToolTrace(key);
          appendSystemMessage(`Auto-reconnect paused in '${chatLabel(key)}' after ${reconnectBudget.maxAttempts} failed resume cycles.`, key);
          appendSystemMessage(`Reconnect recovery is paused for '${chatLabel(key)}'. Send a new message to try again.`, key);
          renderTabs();
          updateComposerState();
          deps.syncActivePendingStatus?.();
          if (Number(getActiveChatId()) === key) {
            deps.markReconnectFailed?.(key);
          }
          return;
        }

        deps.resumeInFlightByChat?.add?.(key);
        deps.resumeAttemptedAtByChat?.set?.(key, now);

        if (force && hasLiveController) {
          abortStreamController(key);
        }

        deps.markChatStreamPending?.({
          chatId: key,
          pendingChats,
          chats,
          setStreamPhase,
        });
        syncClosingConfirmation();
        renderTabs();
        updateComposerState();

        if (Number(getActiveChatId()) === key) {
          deps.markStreamReconnecting?.(key, {
            attempt: 1,
            maxAttempts: RESUME_RECOVERY_MAX_ATTEMPTS,
          });
        }

        const builtReplyRef = { value: "" };

        for (let attempt = 1; attempt <= RESUME_RECOVERY_MAX_ATTEMPTS; attempt += 1) {
          const streamController = new AbortController();
          setFocusRestoreEligibility(key, false);
          setStreamAbortController(key, streamController);

          let attemptState = {
            wasAborted: false,
            completed: false,
            shouldContinue: false,
          };
          try {
            attemptState = await attemptController.executeResumeAttempt({
              key,
              attempt,
              builtReplyRef,
              streamController,
              maxAttempts: RESUME_RECOVERY_MAX_ATTEMPTS,
              setShouldResumeAfterFinally: (value) => {
                shouldResumeAfterFinally = Boolean(value);
              },
            });
          } finally {
            await finalizeStreamLifecycle(key, streamController, { wasAborted: attemptState.wasAborted });
          }

          if (attemptState.shouldContinue) {
            continue;
          }
          if (attemptState.completed) {
            return;
          }
        }
      } finally {
        deps.resumeInFlightByChat?.delete?.(key);
        if (shouldResumeAfterFinally) {
          deps.resumeAttemptedAtByChat?.delete?.(key);
          setTimeoutFn(() => {
            void resumePendingChatStream(key, { force: true });
          }, 0);
        }
      }
    }

    return {
      resumePendingChatStream,
    };
  }

  function createStreamFocusController(deps, sessionController) {
    const {
      getActiveChatId,
      messagesEl,
      promptEl,
      isMobileQuoteMode,
      isDesktopViewport,
      isNearBottom,
    } = deps;
    const {
      focusRestoreEligibleByChat,
    } = sessionController;

    function focusMessagesPaneIfActiveChat(chatId) {
      if (!messagesEl) return;
      if (Number(getActiveChatId()) !== Number(chatId) || document.visibilityState !== "visible") {
        return;
      }
      if (isMobileQuoteMode() || !isDesktopViewport()) return;
      try {
        messagesEl.focus({ preventScroll: true });
      } catch {
        messagesEl.focus();
      }
    }

    function focusPrimaryChatControlIfActiveChat(chatId) {
      if (Number(getActiveChatId()) !== Number(chatId) || document.visibilityState !== "visible") {
        return;
      }

      const isReadingOlderMessages = Boolean(
        messagesEl
        && (Number(messagesEl.scrollHeight || 0) - Number(messagesEl.clientHeight || 0) - Number(messagesEl.scrollTop || 0)) > 40,
      );
      if (isReadingOlderMessages) {
        return;
      }

      if (!isMobileQuoteMode() && isDesktopViewport()) {
        focusMessagesPaneIfActiveChat(chatId);
        return;
      }

      const shouldRestoreFocus = Boolean(focusRestoreEligibleByChat.get(Number(chatId)));
      if (!shouldRestoreFocus || !promptEl) {
        return;
      }
      try {
        promptEl.focus({ preventScroll: true });
      } catch {
        promptEl.focus();
      }
    }

    function shouldRestoreComposerFocus(chatId) {
      return Boolean(
        Number(getActiveChatId()) === Number(chatId)
        && typeof document !== "undefined"
        && document.activeElement === promptEl
        && isNearBottom?.(messagesEl, 40)
      );
    }

    return {
      focusMessagesPaneIfActiveChat,
      focusPrimaryChatControlIfActiveChat,
      shouldRestoreComposerFocus,
    };
  }


  function createStreamFinalizeController(deps, sessionController, focusController) {
    const {
      STREAM_PHASES,
      getStreamPhase,
      getActiveChatId,
      maybeMarkRead,
      syncActiveViewportReadState,
      refreshChats,
      renderTabs,
      updateComposerState,
      syncClosingConfirmation,
      appendSystemMessage,
      finalizeStreamPendingState,
      renderTraceLog,
      isNearBottom,
      messagesEl,
    } = deps;
    const {
      streamAbortControllers,
      immediateFinalizedChats,
      clearStreamAbortController,
      consumeFirstAssistantNotification,
      focusRestoreEligibleByChat,
    } = sessionController;
    const {
      focusPrimaryChatControlIfActiveChat,
    } = focusController;

    async function finalizeStreamLifecycle(chatId, streamController, { wasAborted }) {
      const key = Number(chatId);
      const ownsActiveStream = streamAbortControllers.get(key) === streamController;
      if (!ownsActiveStream) {
        renderTraceLog("stream-finalize-skipped-non-owner", {
          chatId: key,
          wasAborted: Boolean(wasAborted),
        });
        return;
      }

      const shouldRestoreFocus = Boolean(focusRestoreEligibleByChat.get(key));
      renderTraceLog("stream-finalize-begin", {
        chatId: key,
        wasAborted: Boolean(wasAborted),
        activeChatId: Number(getActiveChatId()),
        hidden: typeof document !== "undefined" ? document.visibilityState !== "visible" : false,
      });
      clearStreamAbortController(key, streamController);
      if (!wasAborted) {
        consumeFirstAssistantNotification(key);
        if (getStreamPhase(chatId) !== STREAM_PHASES.ERROR) {
          deps.resetReconnectResumeBudget?.(key);
        }
      }
      if (wasAborted) {
        return;
      }
      const finalizedAtDone = immediateFinalizedChats.has(key);
      if (finalizedAtDone) {
        immediateFinalizedChats.delete(key);
      } else {
        finalizeStreamPendingState(key, wasAborted);
      }

      syncClosingConfirmation();

      try {
        if (Number(getActiveChatId()) === key) {
          if (typeof syncActiveViewportReadState === 'function') {
            syncActiveViewportReadState(key, {
              atBottom: typeof isNearBottom === 'function'
                ? Boolean(isNearBottom(messagesEl, 40))
                : false,
            });
          } else {
            maybeMarkRead(key);
          }
        } else {
          await refreshChats();
        }
      } catch (error) {
        appendSystemMessage(`Failed to sync chat state: ${error.message}`, key);
      }

      renderTabs();
      updateComposerState();
      if (shouldRestoreFocus) {
        focusPrimaryChatControlIfActiveChat(key);
      }
    }

    return {
      finalizeStreamLifecycle,
    };
  }


  function createStreamLifecycleController(deps, sessionController, transcriptController) {
    const focusController = createStreamFocusController(deps, sessionController);
    const finalizeController = createStreamFinalizeController(deps, sessionController, focusController);
    let resumePendingChatStream = async () => {};
    const sendController = createStreamSendController(
      deps,
      sessionController,
      transcriptController,
      focusController,
      finalizeController,
      () => resumePendingChatStream,
    );
    const resumeController = createStreamResumeController(
      deps,
      sessionController,
      transcriptController,
      finalizeController,
    );
    resumePendingChatStream = resumeController.resumePendingChatStream;

    return {
      ...focusController,
      ...finalizeController,
      sendPrompt: sendController.sendPrompt,
      resumePendingChatStream,
    };
  }

  function createController(deps) {
    const sessionController = createStreamSessionController({
      getActiveChatId: deps.getActiveChatId,
      setStreamStatus: deps.setStreamStatus,
      setActivityChip: deps.setActivityChip,
      streamChip: deps.streamChip,
      latencyChip: deps.latencyChip,
      persistStreamCursor: deps.persistStreamCursor,
      triggerIncomingMessageHaptic: deps.triggerIncomingMessageHaptic,
      incrementUnread: deps.incrementUnread,
      renderTabs: deps.renderTabs,
    });
    const transcriptController = createStreamTranscriptController(deps, sessionController);
    const lifecycleController = createStreamLifecycleController(deps, sessionController, transcriptController);

    return {
      setStreamAbortController: sessionController.setStreamAbortController,
      clearStreamAbortController: sessionController.clearStreamAbortController,
      setFocusRestoreEligibility: sessionController.setFocusRestoreEligibility,
      hasLiveStreamController: sessionController.hasLiveStreamController,
      abortStreamController: sessionController.abortStreamController,
      getAbortControllers: sessionController.getAbortControllers,
      applyDonePayload: transcriptController.applyDonePayload,
      handleStreamEvent: transcriptController.handleStreamEvent,
      applyEarlyStreamCloseFallback: transcriptController.applyEarlyStreamCloseFallback,
      consumeStreamResponse: transcriptController.consumeStreamResponse,
      hydrateChatAfterGracefulResumeCompletion: transcriptController.hydrateChatAfterGracefulResumeCompletion,
      consumeStreamWithReconnect: transcriptController.consumeStreamWithReconnect,
      finalizeStreamLifecycle: lifecycleController.finalizeStreamLifecycle,
      sendPrompt: lifecycleController.sendPrompt,
      resumePendingChatStream: lifecycleController.resumePendingChatStream,
    };
  }

  const api = {
    createController,
    createToolTraceController,
    createResumeRecoveryPolicy,
    createVisibleTranscriptFallbackController,
    createStreamTerminalEventController,
    createStreamMetaEventController,
    createToolTraceEventController,
    createAssistantChunkEventController,
    createStreamErrorEventController,
    createStreamNonTerminalEventController,
    createStreamSendRequestController,
    createStreamResumeAttemptController,
    createVisibleStreamStatusController,
    createReplayCursorController,
    createStreamAbortRegistry,
    createFirstAssistantNotificationController,
    createStreamEventDispatchController,
    createSseStreamReadController,
    createTranscriptBufferController,
    createTranscriptReadLoopController,
    createStreamSessionController,
    createStreamTranscriptController,
    createStreamLifecycleController,
  };
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
  globalScope.HermesMiniappStreamController = api;
})(typeof window !== "undefined" ? window : globalThis);
