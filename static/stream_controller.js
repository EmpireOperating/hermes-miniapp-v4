(function initHermesMiniappStreamController(globalScope) {
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

  function createController(deps) {
    const {
      parseSseEvent,
      formatLatency,
      STREAM_PHASES,
      getStreamPhase,
      setStreamPhase,
      isPatchPhaseAllowed,
      chats,
      pendingChats,
      chatLabel,
      compactChatLabel,
      setStreamStatus,
      setActivityChip,
      streamChip,
      latencyChip,
      finalizeInlineToolTrace,
      updatePendingAssistant,
      markStreamUpdate,
      patchVisiblePendingAssistant,
      patchVisibleToolTrace,
      renderTraceLog,
      syncActiveMessageView,
      scheduleActiveMessageView,
      setChatLatency,
      incrementUnread,
      getActiveChatId,
      triggerIncomingMessageHaptic,
      messagesEl,
      promptEl,
      isMobileQuoteMode,
      isDesktopViewport,
      maybeMarkRead,
      refreshChats,
      renderTabs,
      updateComposerState,
      syncClosingConfirmation,
      appendSystemMessage,
      streamDebugLog,
      finalizeStreamPendingState,
      loadChatHistory,
      upsertChat,
      histories,
      mergeHydratedHistory,
      renderMessages,
      persistStreamCursor,
      clearStreamCursor,
      clearPendingStreamSnapshot,
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
      consumeReconnectResumeBudget,
      suppressBlockedChatPending,
      blockReconnectResume,
      isReconnectResumeBlocked,
      MAX_AUTO_RESUME_CYCLES_PER_CHAT = 6,
      resumeAttemptedAtByChat,
      resumeCooldownUntilByChat,
      resumeInFlightByChat,
      RESUME_RECOVERY_MAX_ATTEMPTS = 3,
      RESUME_REATTACH_MIN_INTERVAL_MS = 1200,
      RESUME_COMPLETE_SETTLE_MS = 2500,
      isTransientResumeRecoveryError,
      nextResumeRecoveryDelayMs,
      delayMs,
      markChatStreamPending,
      getStoredStreamCursor,
      isNearBottom,
      fetchImpl = (...args) => fetch(...args),
      setTimeoutFn = (...args) => setTimeout(...args),
    } = deps;

    const streamAbortControllers = new Map();
    const lastStreamEventIdByChat = new Map();
    const focusRestoreEligibleByChat = new Map();
    const firstAssistantNotificationStateByChat = new Map();
    const immediateFinalizedChats = new Set();
    let nextAssistantNotificationId = 0;

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

    function setFocusRestoreEligibility(chatId, eligible) {
      const key = Number(chatId);
      if (!key) return;
      focusRestoreEligibleByChat.set(key, Boolean(eligible));
    }

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
      if (eventId <= lastEventId) {
        return true;
      }
      lastStreamEventIdByChat.set(key, eventId);
      if (typeof persistStreamCursor === "function") {
        persistStreamCursor(key, eventId);
      }
      return false;
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
      const isVisibleActiveChat = Boolean(
        Number(getActiveChatId()) === key
        && (typeof document === "undefined" || document.visibilityState === "visible")
      );
      nextAssistantNotificationId += 1;
      const messageKey = `chat:${key}:assistant-stream:${nextAssistantNotificationId}`;
      const notificationState = {
        messageKey,
        unreadIncremented: false,
      };
      firstAssistantNotificationStateByChat.set(key, notificationState);
      triggerIncomingMessageHaptic(chatId, { messageKey, fallbackToLatestHistory: false });
      if (!isVisibleActiveChat) {
        incrementUnread(chatId);
        renderTabs();
        notificationState.unreadIncremented = true;
      }
      return true;
    }

    function shouldForceImmediateTranscriptFallback(chatId) {
      const key = Number(chatId);
      if (!key) return false;
      // In Telegram/WebView contexts, document.visibilityState can lag or report
      // hidden during an actually visible active session. If inline stream patching
      // misses, deferring the fallback reconcile behind that signal can suppress
      // live tool/assistant transcript updates for the whole run. For the active
      // chat, prefer immediate reconcile unconditionally.
      return Number(getActiveChatId()) === key;
    }

    function reconcileVisibleTranscriptFallback(chatId) {
      if (shouldForceImmediateTranscriptFallback(chatId)) {
        syncActiveMessageView(chatId, { preserveViewport: true });
        return;
      }
      scheduleActiveMessageView(chatId);
    }

    function applyDonePayload(chatId, payload, builtReplyRef, { updateUnread = true } = {}) {
      builtReplyRef.value = payload.reply || builtReplyRef.value;
      finalizeInlineToolTrace(chatId);
      clearStreamCursor?.(chatId);
      updatePendingAssistant(chatId, builtReplyRef.value, false);
      clearPendingStreamSnapshot?.(chatId);
      const earlyAssistantNotification = consumeFirstAssistantNotification(chatId);
      const hadEarlyAssistantHaptic = Boolean(String(earlyAssistantNotification?.messageKey || "").trim());
      const hadEarlyAssistantUnread = Boolean(earlyAssistantNotification?.unreadIncremented);
      const doneTurnCount = Number(payload?.turn_count || 0);
      const doneMessageKey = doneTurnCount > 0 ? `chat:${Number(chatId)}:turn:${doneTurnCount}` : "";
      const doneActiveChatId = Number(getActiveChatId());
      const doneHidden = typeof document !== "undefined" ? document.visibilityState !== "visible" : false;
      const shouldIncrementUnreadOnDone = Boolean(
        updateUnread
        && !hadEarlyAssistantUnread
        && doneActiveChatId !== Number(chatId)
      );
      const shouldTriggerHapticOnDone = Boolean(
        !hadEarlyAssistantHaptic
        && !hadEarlyAssistantUnread
        && (doneActiveChatId !== Number(chatId) || doneHidden)
      );
      if (shouldTriggerHapticOnDone) {
        triggerIncomingMessageHaptic(chatId, { messageKey: doneMessageKey });
      }
      markStreamUpdate(chatId);
      const patchedAssistant = patchVisiblePendingAssistant(chatId, builtReplyRef.value, false);
      const patchedToolTrace = patchVisibleToolTrace(chatId);
      const fallbackRender = !patchedAssistant || !patchedToolTrace;
      renderTraceLog("stream-done-patch", {
        chatId: Number(chatId),
        patchedAssistant,
        patchedToolTrace,
        fallbackRender,
      });
      // Finalizing a pending assistant message does not increase history length, so the
      // normal active-chat reconcile cannot use append-only render and falls back to a full
      // transcript pass. When the visible DOM patch already succeeded, doing that full pass
      // immediately at terminal completion just adds latency before the final assistant text
      // appears. Keep the in-place patch as the fast path and only force a full reconcile
      // when the visible patch path could not safely update the active transcript.
      if (fallbackRender) {
        syncActiveMessageView(chatId, { preserveViewport: true });
      }
      // Hydrate from persisted history so server-extracted metadata (e.g. file_refs/ref_id)
      // is attached to the finalized assistant turn in the active view.
      // Force the local chat state to completed while hydrating so a slightly stale
      // history response cannot re-mark the chat as pending after the terminal `done`.
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
        hadEarlyAssistantHaptic,
        hadEarlyAssistantUnread,
        shouldTriggerHapticOnDone,
        shouldIncrementUnreadOnDone,
        doneTurnCount,
        doneMessageKey,
        latencyMs: Number(payload?.latency_ms || 0),
        replyLength: builtReplyRef.value.length,
      });
      immediateFinalizedChats.add(Number(chatId));
      finalizeStreamPendingState(chatId, false);
      if (shouldIncrementUnreadOnDone) {
        incrementUnread(chatId);
        renderTabs();
      }
    }

    function handleStreamEvent(chatId, eventName, payload, builtReplyRef) {
      if (!payload) {
        return false;
      }

      if (eventName === "meta") {
        const detail = String(payload?.detail || "").toLowerCase();
        if (detail.includes("running") || payload?.job_status === "running") {
          if (getStreamPhase(chatId) === STREAM_PHASES.IDLE) {
            setStreamPhase(chatId, STREAM_PHASES.PENDING_TOOL);
          }
        }
      }

      if (eventName === "meta" && payload.skin) {
        renderTraceLog("stream-meta-skin-ignored", {
          chatId: Number(chatId),
          incomingSkin: payload.skin,
          // current skin is tracked in app.js; this event is intentionally ignored.
        });
      }
      if (eventName === "meta" && payload.detail) {
        const detail = String(payload.detail || "").trim();
        if (detail) {
          setStreamStatusForVisibleChat(chatId, `Queue update (${chatLabel(chatId)}): ${detail}`);
          if (payload.source === "queue") {
            setStreamChipForVisibleChat(chatId, `stream: ${detail} · ${compactChatLabel(chatId)}`);
            if (payload.job_status === "running") {
              const elapsedMs = Number(payload.elapsed_ms);
              if (typeof deps.markStreamActive === "function") {
                deps.markStreamActive(chatId, {
                  elapsedMs: Number.isFinite(elapsedMs) && elapsedMs >= 0 ? elapsedMs : null,
                });
              } else if (Number.isFinite(elapsedMs) && elapsedMs >= 0) {
                const runningLatency = `${formatLatency(elapsedMs)} · live`;
                setChatLatency(chatId, runningLatency);
                setLatencyChipForVisibleChat(chatId, `latency: ${runningLatency}`);
              } else {
                setChatLatency(chatId, "--");
                setLatencyChipForVisibleChat(chatId, "latency: --");
              }
            } else if (payload.job_status === "queued") {
              const queuedAhead = Number(payload.queued_ahead);
              if (typeof deps.markStreamQueued === "function") {
                deps.markStreamQueued(chatId, { queuedAhead });
              } else {
                const queueLabel = Number.isFinite(queuedAhead) && queuedAhead > 0
                  ? `queued · ahead: ${queuedAhead}`
                  : "queued...";
                setChatLatency(chatId, queueLabel);
                setLatencyChipForVisibleChat(chatId, `latency: ${queueLabel}`);
              }
            }
          }
        }
        return false;
      }

      if (eventName === "tool") {
        setStreamPhase(chatId, STREAM_PHASES.STREAMING_TOOL);
        const display = payload.display || payload.preview || payload.tool_name || "Tool running";
        deps.appendInlineToolTrace(chatId, display, payload);
        // Tool journal updates extend the current pending tool card; they should not surface
        // the chat-level unseen/new-below dot as if a fresh assistant message arrived.
        const patchedToolTrace = patchVisibleToolTrace(chatId);
        renderTraceLog("stream-tool-patch", {
          chatId: Number(chatId),
          phase: getStreamPhase(chatId),
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

      if (eventName === "chunk") {
        setStreamPhase(chatId, STREAM_PHASES.STREAMING_ASSISTANT);
        const chunkText = String(payload.text || "");
        const hadAssistantText = builtReplyRef.value.length > 0;
        builtReplyRef.value += chunkText;
        if (!hadAssistantText && chunkText) {
          notifyFirstAssistantChunk(chatId);
        }
        updatePendingAssistant(chatId, builtReplyRef.value, true);
        markStreamUpdate(chatId);
        const patchedAssistant = patchVisiblePendingAssistant(chatId, builtReplyRef.value, true);
        renderTraceLog("stream-chunk-patch", {
          chatId: Number(chatId),
          phase: getStreamPhase(chatId),
          patchedAssistant,
          fallbackRender: !patchedAssistant,
          chunkLength: String(payload.text || "").length,
          replyLength: builtReplyRef.value.length,
        });
        if (!patchedAssistant) {
          reconcileVisibleTranscriptFallback(chatId);
        }
        return false;
      }

      if (eventName === "error") {
        setStreamPhase(chatId, STREAM_PHASES.ERROR);
        finalizeInlineToolTrace(chatId);
        clearStreamCursor?.(chatId);
        consumeFirstAssistantNotification(chatId);
        updatePendingAssistant(chatId, payload.error || "Hermes stream failed.", false);
        markStreamUpdate(chatId);
        syncActiveMessageView(chatId, { preserveViewport: true });
        if (typeof deps.markStreamError === "function") {
          deps.markStreamError(chatId);
        } else {
          setChatLatency(chatId, "--");
          setStreamStatusForVisibleChat(chatId, "Stream error");
          setStreamChipForVisibleChat(chatId, "stream: error");
        }
        return true;
      }

      if (eventName === "done") {
        setStreamPhase(chatId, STREAM_PHASES.FINALIZED);
        applyDonePayload(chatId, payload, builtReplyRef);
        return true;
      }

      return false;
    }

    function applyEarlyStreamCloseFallback(chatId, builtReplyRef, fallbackTraceEvent) {
      setStreamPhase(chatId, STREAM_PHASES.FINALIZED);
      const fallbackReply = builtReplyRef.value || "The response ended before completion.";
      finalizeInlineToolTrace(chatId);
      const earlyAssistantNotification = consumeFirstAssistantNotification(chatId);
      const hadEarlyAssistantHaptic = Boolean(String(earlyAssistantNotification?.messageKey || "").trim());
      const hadEarlyAssistantUnread = Boolean(earlyAssistantNotification?.unreadIncremented);
      const earlyCloseHidden = typeof document !== "undefined" ? document.visibilityState !== "visible" : false;
      updatePendingAssistant(chatId, fallbackReply, false);
      const shouldTriggerHapticOnEarlyClose = Boolean(
        !hadEarlyAssistantUnread
        && (Number(getActiveChatId()) !== Number(chatId) || earlyCloseHidden)
      );
      if (shouldTriggerHapticOnEarlyClose) {
        triggerIncomingMessageHaptic(chatId, { fallbackToLatestHistory: true });
      }
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
      if (typeof deps.markStreamClosedEarly === "function") {
        deps.markStreamClosedEarly(chatId);
      } else {
        setChatLatency(chatId, "--");
        setStreamStatusForVisibleChat(chatId, "Stream closed early");
        setStreamChipForVisibleChat(chatId, "stream: closed early");
      }
      if (!hadEarlyAssistantUnread && Number(getActiveChatId()) !== Number(chatId)) {
        incrementUnread(chatId);
      }
    }

    async function consumeStreamResponse(chatId, response, builtReplyRef, {
      fallbackTraceEvent,
      suppressEarlyCloseFallback = false,
      resetReplayCursor = false,
    } = {}) {
      const key = Number(chatId);
      if (resetReplayCursor) {
        lastStreamEventIdByChat.delete(key);
      }
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let terminalReceived = false;
      let expectedSegmentEnd = false;

      while (true) {
        const { value, done } = await reader.read();
        if (done) {
          renderTraceLog("stream-reader-closed", {
            chatId: Number(chatId),
            terminalReceived,
            bufferedTailLength: buffer.length,
          });
          break;
        }
        const decodedChunk = decoder.decode(value, { stream: true });
        streamDebugLog("sse-read", {
          chatId: Number(chatId),
          chunkLength: decodedChunk.length,
        });
        buffer += decodedChunk;
        const events = buffer.split(/\r?\n\r?\n/);
        buffer = events.pop() || "";

        for (const rawEvent of events) {
          const parsed = parseSseEvent(rawEvent);
          if (!parsed) continue;
          const eventName = parsed.eventName || parsed.event || "message";
          const payload = parsed.payload;
          const timing = payload && typeof payload === "object" && payload._timing && typeof payload._timing === "object"
            ? payload._timing
            : null;
          streamDebugLog("sse-event", {
            chatId: Number(chatId),
            eventName,
            payloadKeys: payload && typeof payload === "object" ? Object.keys(payload) : [],
            clientReceiveMonotonicMs: typeof performance !== "undefined" && typeof performance.now === "function"
              ? Math.round(performance.now())
              : null,
            runtimePublishMonotonicMs: timing && Number.isFinite(Number(timing.runtime_publish_monotonic_ms))
              ? Number(timing.runtime_publish_monotonic_ms)
              : null,
            sseEmitMonotonicMs: timing && Number.isFinite(Number(timing.sse_emit_monotonic_ms))
              ? Number(timing.sse_emit_monotonic_ms)
              : null,
          });
          if (shouldSkipReplayedEvent(key, payload)) {
            continue;
          }
          if (eventName === "meta" && payload?.stream_segment_end) {
            expectedSegmentEnd = true;
          }
          const handledAsTerminal = handleStreamEvent(chatId, eventName, payload, builtReplyRef);
          if (handledAsTerminal) {
            terminalReceived = true;
            renderTraceLog("stream-terminal-event", {
              chatId: Number(chatId),
              eventName,
              bufferedTailLength: buffer.length,
              replyLength: builtReplyRef.value.length,
            });
            break;
          }
        }

        if (terminalReceived) {
          break;
        }
      }

      if (terminalReceived) {
        try {
          await reader.cancel();
        } catch {
          // best effort
        }
      }

      if (!terminalReceived && buffer.trim()) {
        const trimmedBuffer = buffer.trim();
        const parsed = parseSseEvent(trimmedBuffer);
        const eventName = parsed?.eventName || parsed?.event || "message";
        const payload = parsed?.payload;
        streamDebugLog("sse-buffer-tail", {
          chatId: Number(chatId),
          eventName,
          hasPayload: Boolean(payload),
          tailLength: trimmedBuffer.length,
        });
        if (payload && !shouldSkipReplayedEvent(key, payload)) {
          if (eventName === "meta" && payload?.stream_segment_end) {
            expectedSegmentEnd = true;
          }
          const handledAsTerminal = handleStreamEvent(chatId, eventName, payload, builtReplyRef);
          if (handledAsTerminal) {
            terminalReceived = true;
            renderTraceLog("stream-terminal-buffer-tail", {
              chatId: Number(chatId),
              eventName,
              tailLength: trimmedBuffer.length,
              replyLength: builtReplyRef.value.length,
            });
          }
        }
      }

      const earlyClosed = !terminalReceived;
      renderTraceLog("stream-consume-finished", {
        chatId: Number(chatId),
        terminalReceived,
        earlyClosed,
        expectedSegmentEnd,
        suppressEarlyCloseFallback: Boolean(suppressEarlyCloseFallback),
        replyLength: builtReplyRef.value.length,
      });
      if (earlyClosed && !suppressEarlyCloseFallback) {
        applyEarlyStreamCloseFallback(chatId, builtReplyRef, fallbackTraceEvent);
      }

      return {
        terminalReceived,
        earlyClosed,
        expectedSegmentEnd,
      };
    }

    function latestAssistantRenderSignature(history) {
      const items = Array.isArray(history) ? history : [];
      for (let index = items.length - 1; index >= 0; index -= 1) {
        const item = items[index];
        const role = String(item?.role || '').toLowerCase();
        if (role !== 'hermes' && role !== 'assistant') continue;
        const fileRefs = Array.isArray(item?.file_refs) ? item.file_refs : [];
        const fileRefSignature = fileRefs
          .map((ref) => `${String(ref?.ref_id || '')}:${String(ref?.path || '')}:${String(ref?.label || '')}`)
          .join('|');
        return [
          role,
          String(item?.body || ''),
          item?.pending ? 'pending' : 'final',
          fileRefSignature,
        ].join('::');
      }
      return '';
    }

    function transcriptRenderSignature(history) {
      const items = Array.isArray(history) ? history : [];
      return items
        .filter((item) => {
          const role = String(item?.role || '').toLowerCase();
          return role === 'user' || role === 'tool' || role === 'hermes' || role === 'assistant';
        })
        .map((item) => {
          const role = String(item?.role || '').toLowerCase();
          const fileRefs = Array.isArray(item?.file_refs) ? item.file_refs : [];
          const fileRefSignature = fileRefs
            .map((ref) => `${String(ref?.ref_id || '')}:${String(ref?.path || '')}:${String(ref?.label || '')}`)
            .join('|');
          return [
            role,
            String(item?.body || ''),
            item?.pending ? 'pending' : 'final',
            item?.collapsed ? 'collapsed' : 'expanded',
            fileRefSignature,
          ].join('::');
        })
        .join('||');
    }

    async function hydrateChatAfterGracefulResumeCompletion(chatId, { forceCompleted = false } = {}) {
      const key = Number(chatId);
      if (!key || typeof loadChatHistory !== "function") return;
      clearStreamCursor?.(key);
      clearPendingStreamSnapshot?.(key);
      try {
        const hydrated = await loadChatHistory(key, { activate: Number(getActiveChatId()) === key });
        const hydratedChat = hydrated && typeof hydrated === "object" && hydrated.chat && typeof hydrated.chat === "object"
          ? { ...hydrated.chat }
          : hydrated?.chat;
        if (forceCompleted && hydratedChat && typeof hydratedChat === "object") {
          hydratedChat.pending = false;
        }
        if (typeof upsertChat === "function") {
          upsertChat(hydratedChat);
        }
        const previousHistory = histories?.get?.(key) || [];
        const previousAssistantSignature = latestAssistantRenderSignature(previousHistory);
        const previousTranscriptSignature = transcriptRenderSignature(previousHistory);
        const nextHistory = typeof mergeHydratedHistory === "function"
          ? mergeHydratedHistory({
            previousHistory,
            nextHistory: hydrated.history || [],
            chatPending: forceCompleted ? false : Boolean(hydratedChat?.pending),
            preserveCompletedToolTrace: Boolean(forceCompleted),
          })
          : (hydrated.history || []);
        histories?.set?.(key, nextHistory);
        const nextAssistantSignature = latestAssistantRenderSignature(nextHistory);
        const nextTranscriptSignature = transcriptRenderSignature(nextHistory);
        const shouldRenderActiveChat = Number(getActiveChatId()) === key
          && typeof renderMessages === "function"
          && (
            previousAssistantSignature !== nextAssistantSignature
            || previousTranscriptSignature !== nextTranscriptSignature
          );
        renderTraceLog("stream-done-hydrate", {
          chatId: key,
          forceCompleted: Boolean(forceCompleted),
          rendered: Boolean(shouldRenderActiveChat),
          previousAssistantSignature,
          nextAssistantSignature,
          previousTranscriptSignature,
          nextTranscriptSignature,
        });
        if (shouldRenderActiveChat) {
          renderMessages(key, { preserveViewport: true });
        }
      } catch {
        // Best-effort hydration when reconnect says no active job.
      }
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
        renderTraceLog("stream-reconnect-not-needed", {
          chatId: Number(chatId),
          terminalReceived: Boolean(consumeResult?.terminalReceived),
        });
        return false;
      }
      renderTraceLog("stream-reconnect-needed", {
        chatId: Number(chatId),
        terminalReceived: Boolean(consumeResult?.terminalReceived),
        expectedSegmentEnd: Boolean(consumeResult?.expectedSegmentEnd),
        replyLength: builtReplyRef.value.length,
      });
      if (typeof onEarlyClose === "function") {
        await onEarlyClose({
          expectedSegmentEnd: Boolean(consumeResult?.expectedSegmentEnd),
        });
      }
      return true;
    }

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

      // Do not auto-focus the composer on stream completion/resume.
      // On mobile/webview this can pull the viewport downward and reopen the keyboard
      // while tool/activity updates are still settling, which feels like the stream is
      // hijacking the user's reading position. Desktop can still restore non-scrolling
      // focus to the transcript pane for keyboard continuity.
      if (!isMobileQuoteMode() && isDesktopViewport()) {
        focusMessagesPaneIfActiveChat(chatId);
      }
    }

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
          resetReconnectResumeBudget?.(key);
        }
      }
      if (wasAborted) {
        // Abort is commonly used for intentional stream handoff (send -> resume or
        // resume -> resume rollover). Do not clear pending/phase here, or we can
        // transiently mark an active chat idle while the replacement stream is live.
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
          maybeMarkRead(key);
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
      if (pendingChats.has(chatId) || serverPending) {
        appendSystemMessage(`Still replying in '${chatLabel(chatId)}'.`);
        return;
      }

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
      let wasAborted = false;
      const streamController = new AbortController();
      const shouldRestoreFocusOnComplete = Boolean(
        Number(getActiveChatId()) === chatId
        && typeof document !== "undefined"
        && document.activeElement === promptEl
        && isNearBottom?.(messagesEl, 40),
      );
      setFocusRestoreEligibility(chatId, shouldRestoreFocusOnComplete);
      setStreamAbortController(chatId, streamController);

      try {
        const response = await fetchImpl("/api/chat/stream", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(authPayload({ chat_id: chatId, message: cleaned })),
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
            return;
          }

          setStreamPhase(chatId, STREAM_PHASES.ERROR);
          if (/Telegram init data is too old/i.test(parsedError.error || fallback || "")) {
            setIsAuthenticated?.(false);
            if (authStatusEl) {
              authStatusEl.textContent = "Session expired";
            }
            updatePendingAssistant(chatId, "Telegram session expired. Close and reopen the mini app to refresh auth.", false);
            updateComposerState();
          } else {
            updatePendingAssistant(chatId, sanitizedFallbackMessage, false);
          }
          syncActiveMessageView(chatId, { preserveViewport: true });
          deps.markStreamError?.(chatId);
          return;
        }

        const resumed = await consumeStreamWithReconnect(chatId, response, builtReplyRef, {
          fallbackTraceEvent: "stream-fallback-patch",
          resetReplayCursor: true,
          onEarlyClose: async ({ expectedSegmentEnd = false } = {}) => {
            if (expectedSegmentEnd) {
              resetReconnectResumeBudget?.(chatId);
            }
            await resumePendingChatStream(chatId, { force: true });
          },
        });
        if (resumed) return;
      } catch (error) {
        if (error?.name === "AbortError") {
          wasAborted = true;
          return;
        }
        setStreamPhase(chatId, STREAM_PHASES.ERROR);
        finalizeInlineToolTrace(chatId);
        updatePendingAssistant(chatId, `Network failure: ${error.message}`, false);
        markStreamUpdate(chatId);
        syncActiveMessageView(chatId, { preserveViewport: true });
        deps.markNetworkFailure?.(chatId);
      } finally {
        await finalizeStreamLifecycle(chatId, streamController, { wasAborted });
      }
    }

    async function resumePendingChatStream(chatId, { force = false } = {}) {
      const key = Number(chatId);
      if (!key || !getIsAuthenticated?.()) return;
      let shouldResumeAfterFinally = false;
      try {
        if (isReconnectResumeBlocked?.(key)) {
          suppressBlockedChatPending?.(key);
          renderTabs();
          updateComposerState();
          deps.syncActivePendingStatus?.();
          return;
        }
        const now = Date.now();
        const cooldownUntil = Number(resumeCooldownUntilByChat?.get?.(key) || 0);
        if (cooldownUntil > now) {
          return;
        }
        if (resumeInFlightByChat?.has?.(key)) {
          return;
        }
        const hasLiveController = hasLiveStreamController(key);
        if (hasLiveController && !force) return;
        const lastAttemptAt = Number(resumeAttemptedAtByChat?.get?.(key) || 0);
        if (lastAttemptAt > 0 && (now - lastAttemptAt) < RESUME_REATTACH_MIN_INTERVAL_MS) {
          return;
        }
        const chatPending = Boolean(chats.get(key)?.pending);
        if (!chatPending && !force) return;

        const reconnectBudget = consumeReconnectResumeBudget?.(key) || {
          allowed: true,
          attempts: 1,
          maxAttempts: MAX_AUTO_RESUME_CYCLES_PER_CHAT,
        };
        if (!reconnectBudget.allowed) {
          blockReconnectResume?.(key);
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

        resumeInFlightByChat?.add?.(key);
        resumeAttemptedAtByChat?.set?.(key, now);

        if (force && hasLiveController) {
          abortStreamController(key);
        }

        markChatStreamPending?.({
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
          let wasAborted = false;
          const streamController = new AbortController();
          setFocusRestoreEligibility(key, false);
          setStreamAbortController(key, streamController);

          try {
            const response = await fetchImpl("/api/chat/stream/resume", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(authPayload({ chat_id: key, after_event_id: getStoredStreamCursor?.(key) })),
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
                resumeCooldownUntilByChat?.set?.(key, Date.now() + RESUME_COMPLETE_SETTLE_MS);
                setStreamPhase(key, STREAM_PHASES.FINALIZED);
                await hydrateChatAfterGracefulResumeCompletion(key);
                triggerIncomingMessageHaptic(key, { fallbackToLatestHistory: true });
                deps.markResumeAlreadyComplete?.(key);
                return;
              }
              throw new Error(sanitizedResumeFailure);
            }

            const resumed = await consumeStreamWithReconnect(key, response, builtReplyRef, {
              fallbackTraceEvent: "stream-resume-fallback-patch",
              onEarlyClose: async ({ expectedSegmentEnd = false } = {}) => {
                if (expectedSegmentEnd) {
                  resetReconnectResumeBudget?.(key);
                }
                wasAborted = true;
                shouldResumeAfterFinally = true;
              },
            });
            if (resumed) return;
            return;
          } catch (error) {
            if (error?.name === "AbortError") {
              wasAborted = true;
              return;
            }
            const transientReconnectFailure = isTransientResumeRecoveryError(error);
            const hasAttemptsRemaining = transientReconnectFailure && attempt < RESUME_RECOVERY_MAX_ATTEMPTS;
            if (hasAttemptsRemaining) {
              console.warn(`[W_STREAM_RECONNECT_RETRY] chat=${key} attempt=${attempt}/${RESUME_RECOVERY_MAX_ATTEMPTS}`, error);
              if (Number(getActiveChatId()) === key) {
                deps.markStreamReconnecting?.(key, {
                  attempt: attempt + 1,
                  maxAttempts: RESUME_RECOVERY_MAX_ATTEMPTS,
                });
              }
              await delayMs(nextResumeRecoveryDelayMs(attempt));
              continue;
            }

            if (transientReconnectFailure) {
              await hydrateChatAfterGracefulResumeCompletion(key);
              const stillPending = Boolean(chats.get(key)?.pending) || pendingChats.has(key);
              if (!stillPending) {
                resumeCooldownUntilByChat?.set?.(key, Date.now() + RESUME_COMPLETE_SETTLE_MS);
                setStreamPhase(key, STREAM_PHASES.FINALIZED);
                triggerIncomingMessageHaptic(key, { fallbackToLatestHistory: true });
                deps.markResumeAlreadyComplete?.(key);
                return;
              }
            }

            blockReconnectResume?.(key);
            setStreamPhase(key, STREAM_PHASES.ERROR);
            finalizeInlineToolTrace(key);
            console.warn(`[E_STREAM_RECONNECT_FAILED] chat=${key}`, error);
            appendSystemMessage(`Could not reconnect '${chatLabel(key)}': ${error.message}`, key);
            appendSystemMessage(`Reconnect recovery is paused for '${chatLabel(key)}'. Send a new message to try again.`, key);
            renderTabs();
            updateComposerState();
            deps.syncActivePendingStatus?.();
            if (Number(getActiveChatId()) === key) {
              deps.markReconnectFailed?.(key);
            }
            return;
          } finally {
            await finalizeStreamLifecycle(key, streamController, { wasAborted });
          }
        }
      } finally {
        resumeInFlightByChat?.delete?.(key);
        if (shouldResumeAfterFinally) {
          resumeAttemptedAtByChat?.delete?.(key);
          setTimeoutFn(() => {
            void resumePendingChatStream(key, { force: true });
          }, 0);
        }
      }
    }

    return {
      setStreamAbortController,
      clearStreamAbortController,
      setFocusRestoreEligibility,
      hasLiveStreamController,
      abortStreamController,
      getAbortControllers,
      applyDonePayload,
      handleStreamEvent,
      applyEarlyStreamCloseFallback,
      consumeStreamResponse,
      hydrateChatAfterGracefulResumeCompletion,
      consumeStreamWithReconnect,
      finalizeStreamLifecycle,
      sendPrompt,
      resumePendingChatStream,
    };
  }

  const api = { createController, createToolTraceController, createResumeRecoveryPolicy };
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
  globalScope.HermesMiniappStreamController = api;
})(typeof window !== "undefined" ? window : globalThis);
