(function initHermesMiniappStreamController(globalScope) {
  function createToolTraceController({
    toolStreamEl,
    toolStreamLinesEl,
    histories,
    cleanDisplayText,
  }) {
    function resetToolStream() {
      if (!toolStreamEl || !toolStreamLinesEl) return;
      toolStreamLinesEl.innerHTML = "";
      toolStreamEl.hidden = true;
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

      const firstPendingHermesIndex = history.findIndex((item) => item?.role === "hermes" && item?.pending);
      if (firstPendingHermesIndex >= 0) {
        history.splice(firstPendingHermesIndex, 0, next);
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

    function appendInlineToolTrace(chatId, textOrPayload, explicitPayload = null) {
      const payload = parseToolEventPayload(textOrPayload, explicitPayload);
      const line = resolveToolLine(textOrPayload, payload);
      if (!line) return;
      const key = Number(chatId);
      const trace = ensurePendingToolTraceMessage(key);
      const dedupeKey = resolveToolDedupeKey(payload);

      if (!dedupeKey) {
        trace.body = trace.body ? `${trace.body}\n${line}` : line;
        return;
      }

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
          item.collapsed = true;
          delete item._toolTraceOrder;
          delete item._toolTraceLines;
        }
        changed = true;
        break;
      }

      if (changed) {
        histories.set(key, history);
      }
    }

    return {
      resetToolStream,
      findPendingToolTraceMessage,
      ensurePendingToolTraceMessage,
      appendInlineToolTrace,
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
      sourceChip,
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
    } = deps;

    const streamAbortControllers = new Map();
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
      if (eventId <= lastEventId) {
        return true;
      }
      lastStreamEventIdByChat.set(key, eventId);
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
      return true;
    }

    function getAbortControllers() {
      return streamAbortControllers;
    }

    function applyDonePayload(chatId, payload, builtReplyRef, { updateUnread = true } = {}) {
      builtReplyRef.value = payload.reply || builtReplyRef.value;
      finalizeInlineToolTrace(chatId);
      updatePendingAssistant(chatId, builtReplyRef.value, false);
      const doneTurnCount = Number(payload?.turn_count || 0);
      const doneMessageKey = doneTurnCount > 0 ? `chat:${Number(chatId)}:turn:${doneTurnCount}` : "";
      triggerIncomingMessageHaptic(chatId, { messageKey: doneMessageKey });
      markStreamUpdate(chatId);
      const patchedAssistant = patchVisiblePendingAssistant(chatId, builtReplyRef.value, false);
      const patchedToolTrace = patchVisibleToolTrace(chatId);
      renderTraceLog("stream-done-patch", {
        chatId: Number(chatId),
        patchedAssistant,
        patchedToolTrace,
        fallbackRender: !patchedAssistant || !patchedToolTrace,
      });
      if (!patchedAssistant || !patchedToolTrace) {
        syncActiveMessageView(chatId, { preserveViewport: true });
      }
      setChatLatency(chatId, formatLatency(payload.latency_ms));
      setStreamStatus(`Reply received in ${chatLabel(chatId)}`);
      setActivityChip(streamChip, `stream: complete · ${compactChatLabel(chatId)}`);
      if (updateUnread && Number(getActiveChatId()) !== Number(chatId)) {
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
      if (eventName === "meta" && payload.source) {
        setActivityChip(sourceChip, `source: ${payload.source}`);
      }
      if (eventName === "meta" && payload.detail) {
        const detail = String(payload.detail || "").trim();
        if (detail) {
          setStreamStatus(`Queue update (${chatLabel(chatId)}): ${detail}`);
          if (payload.source === "queue") {
            setActivityChip(streamChip, `stream: ${detail} · ${compactChatLabel(chatId)}`);
            if (payload.job_status === "running") {
              const elapsedMs = Number(payload.elapsed_ms);
              if (Number.isFinite(elapsedMs) && elapsedMs >= 0) {
                setChatLatency(chatId, `${formatLatency(elapsedMs)} · live`);
              } else {
                setChatLatency(chatId, "calculating...");
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
        markStreamUpdate(chatId);
        const patchedToolTrace = patchVisibleToolTrace(chatId);
        renderTraceLog("stream-tool-patch", {
          chatId: Number(chatId),
          phase: getStreamPhase(chatId),
          patchedToolTrace,
          fallbackRender: !patchedToolTrace,
        });
        if (!patchedToolTrace) {
          scheduleActiveMessageView(chatId);
        }
        setStreamStatus(`Using tools in ${chatLabel(chatId)}`);
        setActivityChip(streamChip, `stream: tools active · ${compactChatLabel(chatId)}`);
        return false;
      }

      if (eventName === "chunk") {
        setStreamPhase(chatId, STREAM_PHASES.STREAMING_ASSISTANT);
        builtReplyRef.value += payload.text || "";
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
          scheduleActiveMessageView(chatId);
        }
        return false;
      }

      if (eventName === "error") {
        setStreamPhase(chatId, STREAM_PHASES.ERROR);
        finalizeInlineToolTrace(chatId);
        updatePendingAssistant(chatId, payload.error || "Hermes stream failed.", false);
        markStreamUpdate(chatId);
        syncActiveMessageView(chatId, { preserveViewport: true });
        setChatLatency(chatId, "--");
        setStreamStatus("Stream error");
        setActivityChip(streamChip, "stream: error");
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
      updatePendingAssistant(chatId, fallbackReply, false);
      triggerIncomingMessageHaptic(chatId, { fallbackToLatestHistory: true });
      markStreamUpdate(chatId);
      setChatLatency(chatId, "--");
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
      setStreamStatus("Stream closed early");
      setActivityChip(streamChip, "stream: closed early");
      if (Number(getActiveChatId()) !== Number(chatId)) {
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

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        const decodedChunk = decoder.decode(value, { stream: true });
        streamDebugLog("sse-read", {
          chatId: Number(chatId),
          chunkLength: decodedChunk.length,
          chunkPreview: decodedChunk.slice(0, 180),
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
          if (handleStreamEvent(chatId, eventName, payload, builtReplyRef)) {
            terminalReceived = true;
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
          tailPreview: trimmedBuffer.slice(0, 220),
        });
        if (payload && !shouldSkipReplayedEvent(key, payload) && handleStreamEvent(chatId, eventName, payload, builtReplyRef)) {
          terminalReceived = true;
        }
      }

      const earlyClosed = !terminalReceived;
      if (earlyClosed && !suppressEarlyCloseFallback) {
        applyEarlyStreamCloseFallback(chatId, builtReplyRef, fallbackTraceEvent);
      }

      return {
        terminalReceived,
        earlyClosed,
      };
    }

    async function hydrateChatAfterGracefulResumeCompletion(chatId) {
      const key = Number(chatId);
      if (!key || typeof loadChatHistory !== "function") return;
      try {
        const hydrated = await loadChatHistory(key, { activate: Number(getActiveChatId()) === key });
        if (typeof upsertChat === "function") {
          upsertChat(hydrated.chat);
        }
        const previousHistory = histories?.get?.(key) || [];
        const nextHistory = typeof mergeHydratedHistory === "function"
          ? mergeHydratedHistory({
            previousHistory,
            nextHistory: hydrated.history || [],
            chatPending: Boolean(hydrated.chat?.pending),
          })
          : (hydrated.history || []);
        histories?.set?.(key, nextHistory);
        if (Number(getActiveChatId()) === key && typeof renderMessages === "function") {
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
        return false;
      }
      if (typeof onEarlyClose === "function") {
        await onEarlyClose();
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

      if (!isMobileQuoteMode() && isDesktopViewport()) {
        focusMessagesPaneIfActiveChat(chatId);
        return;
      }

      try {
        promptEl.focus({ preventScroll: true });
      } catch {
        promptEl.focus();
      }
    }

    async function finalizeStreamLifecycle(chatId, streamController, { wasAborted }) {
      clearStreamAbortController(chatId, streamController);
      finalizeStreamPendingState(chatId, wasAborted);
      if (wasAborted) {
        return;
      }

      syncClosingConfirmation();

      try {
        if (Number(getActiveChatId()) === Number(chatId)) {
          maybeMarkRead(Number(chatId));
        } else {
          await refreshChats();
        }
      } catch (error) {
        appendSystemMessage(`Failed to sync chat state: ${error.message}`);
      }

      renderTabs();
      updateComposerState();
      focusPrimaryChatControlIfActiveChat(chatId);
    }

    return {
      setStreamAbortController,
      clearStreamAbortController,
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
    };
  }

  const api = { createController, createToolTraceController };
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
  globalScope.HermesMiniappStreamController = api;
})(typeof window !== "undefined" ? window : globalThis);
