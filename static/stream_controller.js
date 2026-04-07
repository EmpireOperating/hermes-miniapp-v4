(function initHermesMiniappStreamController(globalScope) {
  function createToolTraceController({
    toolStreamEl,
    toolStreamLinesEl,
    histories,
    cleanDisplayText,
    documentObject = (typeof document !== "undefined" ? document : null),
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

    function isNearElementBottom(element, threshold = 40) {
      if (!element) return true;
      const scrollHeight = Number(element.scrollHeight);
      const clientHeight = Number(element.clientHeight);
      const scrollTop = Number(element.scrollTop);
      if (!Number.isFinite(scrollHeight) || !Number.isFinite(clientHeight) || !Number.isFinite(scrollTop)) {
        return true;
      }
      return (scrollHeight - clientHeight - scrollTop) <= threshold;
    }

    function renderToolStreamLines(lines) {
      if (!toolStreamEl || !toolStreamLinesEl) return;
      const safeLines = Array.isArray(lines) ? lines.filter((line) => String(line || "").trim()) : [];
      const shouldStickBottom = isNearElementBottom(toolStreamLinesEl, 40);
      toolStreamLinesEl.innerHTML = "";
      if (!safeLines.length) {
        toolStreamEl.hidden = true;
        return;
      }
      if (!documentObject || typeof toolStreamLinesEl.appendChild !== "function") {
        toolStreamLinesEl.innerHTML = safeLines.join("\n");
        toolStreamEl.hidden = false;
        if (shouldStickBottom) {
          toolStreamLinesEl.scrollTop = toolStreamLinesEl.scrollHeight;
        }
        return;
      }
      for (const line of safeLines) {
        const row = documentObject.createElement("div");
        row.className = "tool-stream__line";
        row.textContent = String(line || "").trim();
        toolStreamLinesEl.appendChild(row);
      }
      toolStreamEl.hidden = false;
      if (shouldStickBottom) {
        toolStreamLinesEl.scrollTop = toolStreamLinesEl.scrollHeight;
      }
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
      renderToolStreamLines(lines);
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
        renderToolStreamLines(String(trace.body || "").split("\n"));
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
      resetToolStream();
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
    } = deps;

    const streamAbortControllers = new Map();
    const lastStreamEventIdByChat = new Map();
    const focusRestoreEligibleByChat = new Map();
    const firstAssistantNotificationStateByChat = new Map();
    let nextAssistantNotificationId = 0;

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
        !hadEarlyAssistantUnread
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
        setStreamStatus(`Reply received in ${chatLabel(chatId)}`);
        setActivityChip(streamChip, `stream: complete · ${compactChatLabel(chatId)}`);
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
          setStreamStatus(`Queue update (${chatLabel(chatId)}): ${detail}`);
          if (payload.source === "queue") {
            setActivityChip(streamChip, `stream: ${detail} · ${compactChatLabel(chatId)}`);
            if (payload.job_status === "running") {
              const elapsedMs = Number(payload.elapsed_ms);
              if (Number.isFinite(elapsedMs) && elapsedMs >= 0) {
                const runningLatency = `${formatLatency(elapsedMs)} · live`;
                setChatLatency(chatId, runningLatency);
                setActivityChip(latencyChip, `latency: ${runningLatency}`);
              } else {
                setChatLatency(chatId, "calculating...");
                setActivityChip(latencyChip, "latency: calculating...");
              }
            } else if (payload.job_status === "queued") {
              const queuedAhead = Number(payload.queued_ahead);
              const queueLabel = Number.isFinite(queuedAhead) && queuedAhead > 0
                ? `queued · ahead: ${queuedAhead}`
                : "queued...";
              setChatLatency(chatId, queueLabel);
              setActivityChip(latencyChip, `latency: ${queueLabel}`);
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
        if (typeof deps.markToolActivity === "function") {
          deps.markToolActivity(chatId);
        } else {
          setStreamStatus(`Using tools in ${chatLabel(chatId)}`);
          setActivityChip(streamChip, `stream: tools active · ${compactChatLabel(chatId)}`);
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
          scheduleActiveMessageView(chatId);
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
        suppressEarlyCloseFallback: Boolean(suppressEarlyCloseFallback),
        replyLength: builtReplyRef.value.length,
      });
      if (earlyClosed && !suppressEarlyCloseFallback) {
        applyEarlyStreamCloseFallback(chatId, builtReplyRef, fallbackTraceEvent);
      }

      return {
        terminalReceived,
        earlyClosed,
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
          String(item?.id || ''),
          role,
          String(item?.body || ''),
          item?.pending ? 'pending' : 'final',
          fileRefSignature,
        ].join('::');
      }
      return '';
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
        const nextHistory = typeof mergeHydratedHistory === "function"
          ? mergeHydratedHistory({
            previousHistory,
            nextHistory: hydrated.history || [],
            chatPending: forceCompleted ? false : Boolean(hydratedChat?.pending),
          })
          : (hydrated.history || []);
        histories?.set?.(key, nextHistory);
        const nextAssistantSignature = latestAssistantRenderSignature(nextHistory);
        const shouldRenderActiveChat = Number(getActiveChatId()) === key
          && typeof renderMessages === "function"
          && previousAssistantSignature !== nextAssistantSignature;
        renderTraceLog("stream-done-hydrate", {
          chatId: key,
          forceCompleted: Boolean(forceCompleted),
          rendered: Boolean(shouldRenderActiveChat),
          previousAssistantSignature,
          nextAssistantSignature,
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
        replyLength: builtReplyRef.value.length,
      });
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

      try {
        promptEl.focus({ preventScroll: true });
      } catch {
        promptEl.focus();
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
      }
      if (wasAborted) {
        // Abort is commonly used for intentional stream handoff (send -> resume or
        // resume -> resume rollover). Do not clear pending/phase here, or we can
        // transiently mark an active chat idle while the replacement stream is live.
        return;
      }
      finalizeStreamPendingState(key, wasAborted);

      syncClosingConfirmation();

      try {
        if (Number(getActiveChatId()) === key) {
          maybeMarkRead(key);
        } else {
          await refreshChats();
        }
      } catch (error) {
        appendSystemMessage(`Failed to sync chat state: ${error.message}`);
      }

      renderTabs();
      updateComposerState();
      if (shouldRestoreFocus) {
        focusPrimaryChatControlIfActiveChat(key);
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
    };
  }

  const api = { createController, createToolTraceController };
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
  globalScope.HermesMiniappStreamController = api;
})(typeof window !== "undefined" ? window : globalThis);
