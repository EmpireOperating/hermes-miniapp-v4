(function initHermesMiniappStreamController(globalScope) {
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
    } = deps;

    const streamAbortControllers = new Map();

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
        deps.appendInlineToolTrace(chatId, display);
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

    async function consumeStreamResponse(chatId, response, builtReplyRef, { fallbackTraceEvent, suppressEarlyCloseFallback = false } = {}) {
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let terminalReceived = false;

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const events = buffer.split("\n\n");
        buffer = events.pop() || "";

        for (const rawEvent of events) {
          const parsed = parseSseEvent(rawEvent);
          if (!parsed) continue;
          const eventName = parsed.eventName || parsed.event || "message";
          const payload = parsed.payload;
          streamDebugLog("sse-event", {
            chatId: Number(chatId),
            eventName,
            payloadKeys: payload && typeof payload === "object" ? Object.keys(payload) : [],
          });
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
        const parsed = parseSseEvent(buffer.trim());
        const eventName = parsed?.eventName || parsed?.event || "message";
        const payload = parsed?.payload;
        streamDebugLog("sse-buffer-tail", {
          chatId: Number(chatId),
          eventName,
          hasPayload: Boolean(payload),
        });
        if (payload && handleStreamEvent(chatId, eventName, payload, builtReplyRef)) {
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
      finalizeStreamLifecycle,
    };
  }

  const api = { createController };
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
  globalScope.HermesMiniappStreamController = api;
})(typeof window !== "undefined" ? window : globalThis);
