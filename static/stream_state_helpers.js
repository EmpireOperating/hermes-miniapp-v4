(function initHermesMiniappStreamState(globalScope) {
  const STREAM_PHASES = Object.freeze({
    IDLE: "idle",
    PENDING_TOOL: "pending_tool",
    STREAMING_TOOL: "streaming_tool",
    STREAMING_ASSISTANT: "streaming_assistant",
    FINALIZED: "finalized",
    ERROR: "error",
  });

  const PATCH_ALLOWED_PHASES = new Set([
    STREAM_PHASES.PENDING_TOOL,
    STREAM_PHASES.STREAMING_TOOL,
    STREAM_PHASES.STREAMING_ASSISTANT,
    STREAM_PHASES.FINALIZED,
    STREAM_PHASES.ERROR,
  ]);

  function toPositiveInt(value) {
    const parsed = Number(value);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
  }

  function normalizeStreamPhase(value) {
    const normalized = String(value || "").toLowerCase();
    if (Object.values(STREAM_PHASES).includes(normalized)) {
      return normalized;
    }
    return STREAM_PHASES.IDLE;
  }

  function getStreamPhase({ streamPhaseByChat, chatId }) {
    const key = toPositiveInt(chatId);
    if (!key || !streamPhaseByChat || typeof streamPhaseByChat.get !== "function") {
      return STREAM_PHASES.IDLE;
    }
    return normalizeStreamPhase(streamPhaseByChat.get(key));
  }

  function setStreamPhase({ streamPhaseByChat, chatId, phase }) {
    const key = toPositiveInt(chatId);
    if (!key || !streamPhaseByChat || typeof streamPhaseByChat.set !== "function") {
      return STREAM_PHASES.IDLE;
    }
    const next = normalizeStreamPhase(phase);
    streamPhaseByChat.set(key, next);
    return next;
  }

  function isPatchPhaseAllowed(phase) {
    return PATCH_ALLOWED_PHASES.has(normalizeStreamPhase(phase));
  }

  function markChatStreamPending({ chatId, pendingChats, chats, setStreamPhase: setStreamPhaseFn }) {
    const key = toPositiveInt(chatId);
    if (!key) return null;

    pendingChats?.add?.(key);
    if (chats?.has?.(key)) {
      const chat = chats.get(key);
      if (chat && typeof chat === "object") {
        chat.pending = true;
      }
    }
    if (typeof setStreamPhaseFn === "function") {
      setStreamPhaseFn(key, STREAM_PHASES.PENDING_TOOL);
    }
    return key;
  }

  function finalizeChatStreamState({ chatId, wasAborted, pendingChats, chats, setStreamPhase: setStreamPhaseFn }) {
    const key = toPositiveInt(chatId);
    if (!key) return null;

    if (!wasAborted) {
      pendingChats?.delete?.(key);
      if (chats?.has?.(key)) {
        const chat = chats.get(key);
        if (chat && typeof chat === "object") {
          chat.pending = false;
        }
      }
    }

    if (typeof setStreamPhaseFn === "function") {
      setStreamPhaseFn(key, STREAM_PHASES.IDLE);
    }
    return key;
  }

  function clearChatStreamState({ chatId, pendingChats, streamPhaseByChat, unseenStreamChats }) {
    const key = toPositiveInt(chatId);
    if (!key) return false;

    pendingChats?.delete?.(key);
    streamPhaseByChat?.delete?.(key);
    unseenStreamChats?.delete?.(key);
    return true;
  }

  function createPhaseController({
    streamPhaseByChat,
    renderTraceLog,
  }) {
    return {
      getStreamPhase(chatId) {
        return getStreamPhase({ streamPhaseByChat, chatId });
      },
      setStreamPhase(chatId, phase) {
        const key = toPositiveInt(chatId);
        if (!key) return STREAM_PHASES.IDLE;
        const next = setStreamPhase({ streamPhaseByChat, chatId: key, phase });
        renderTraceLog?.("stream-phase", { chatId: key, phase: next });
        return next;
      },
    };
  }

  function createLifecycleController({
    chats,
    pendingChats,
    unseenStreamChats,
    getActiveChatId,
    setStreamPhase,
    refreshTabNode,
    renderTraceLog,
  }) {
    function buildFinalizeTracePayload(chatId, wasAborted, chat) {
      const key = toPositiveInt(chatId) || 0;
      return {
        chatId: key,
        wasAborted: Boolean(wasAborted),
        activeChatId: toPositiveInt(getActiveChatId?.()) || 0,
        pendingLocal: Boolean(pendingChats?.has?.(key)),
        pendingServer: Boolean(chat?.pending),
        unread: Math.max(0, Number(chat?.unread_count || 0)),
        unseen: Boolean(unseenStreamChats?.has?.(key)),
      };
    }

    function finalizeStreamPendingState(chatId, wasAborted) {
      const key = toPositiveInt(chatId);
      if (!key) return null;
      const beforeChat = chats?.get?.(key) || null;
      renderTraceLog?.('stream-pending-finalize-before', buildFinalizeTracePayload(key, wasAborted, beforeChat));
      finalizeChatStreamState({
        chatId: key,
        wasAborted,
        pendingChats,
        chats,
        setStreamPhase,
      });
      const afterChat = chats?.get?.(key) || null;
      renderTraceLog?.('stream-pending-finalize-after', buildFinalizeTracePayload(key, wasAborted, afterChat));
      refreshTabNode?.(key);
      return key;
    }

    return {
      finalizeStreamPendingState,
    };
  }

  function createPersistenceController({
    localStorageRef,
    streamResumeCursorStorageKey,
    pendingStreamSnapshotStorageKey,
    pendingStreamSnapshotMaxAgeMs,
    histories,
    chats,
    nowFn,
    dateNowFn,
  }) {
    const storage = localStorageRef;
    const currentTimeMs = typeof dateNowFn === "function"
      ? dateNowFn
      : (typeof nowFn === "function" ? nowFn : () => Date.now());

    function readJsonMap(storageKey) {
      try {
        const raw = storage?.getItem?.(storageKey);
        const parsed = raw ? JSON.parse(raw) : {};
        return parsed && typeof parsed === "object" ? parsed : {};
      } catch {
        return {};
      }
    }

    function writeJsonMap(storageKey, nextMap) {
      try {
        storage?.setItem?.(storageKey, JSON.stringify(nextMap || {}));
      } catch {
        // best effort only
      }
    }

    function readStreamResumeCursorMap() {
      return readJsonMap(streamResumeCursorStorageKey);
    }

    function writeStreamResumeCursorMap(nextMap) {
      writeJsonMap(streamResumeCursorStorageKey, nextMap);
    }

    function getStoredStreamCursor(chatId) {
      const key = toPositiveInt(chatId);
      if (!key) return 0;
      const value = Number(readStreamResumeCursorMap()[String(key)] || 0);
      return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
    }

    function setStoredStreamCursor(chatId, eventId) {
      const key = toPositiveInt(chatId);
      const safeEventId = Number(eventId);
      if (!key || !Number.isFinite(safeEventId) || safeEventId <= 0) return 0;
      const nextMap = readStreamResumeCursorMap();
      const existing = Number(nextMap[String(key)] || 0);
      const nextValue = Math.max(existing, Math.floor(safeEventId));
      nextMap[String(key)] = nextValue;
      writeStreamResumeCursorMap(nextMap);
      return nextValue;
    }

    function clearStoredStreamCursor(chatId) {
      const key = toPositiveInt(chatId);
      if (!key) return false;
      const nextMap = readStreamResumeCursorMap();
      if (!(String(key) in nextMap)) return false;
      delete nextMap[String(key)];
      writeStreamResumeCursorMap(nextMap);
      return true;
    }

    function readPendingStreamSnapshotMap() {
      return readJsonMap(pendingStreamSnapshotStorageKey);
    }

    function writePendingStreamSnapshotMap(nextMap) {
      writeJsonMap(pendingStreamSnapshotStorageKey, nextMap);
    }

    function clearPendingStreamSnapshot(chatId) {
      const key = toPositiveInt(chatId);
      if (!key) return false;
      const nextMap = readPendingStreamSnapshotMap();
      if (!(String(key) in nextMap)) return false;
      delete nextMap[String(key)];
      writePendingStreamSnapshotMap(nextMap);
      return true;
    }

    function hasFreshPendingStreamSnapshot(chatId) {
      const key = toPositiveInt(chatId);
      if (!key) return false;
      const nextMap = readPendingStreamSnapshotMap();
      const snapshot = nextMap[String(key)];
      if (!snapshot || typeof snapshot !== "object") return false;
      const snapshotTs = Number(snapshot.ts || 0);
      if (!Number.isFinite(snapshotTs) || snapshotTs <= 0 || (currentTimeMs() - snapshotTs) > Number(pendingStreamSnapshotMaxAgeMs || 0)) {
        delete nextMap[String(key)];
        writePendingStreamSnapshotMap(nextMap);
        return false;
      }
      return true;
    }

    function normalizeSnapshotLines(value) {
      return Array.isArray(value)
        ? value.map((line) => String(line || "").trim()).filter(Boolean)
        : [];
    }

    function mergeSnapshotToolJournalLines(existingLines, currentBody) {
      const existing = normalizeSnapshotLines(existingLines);
      const bodyLines = String(currentBody || "")
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean);

      if (!existing.length) {
        return bodyLines;
      }
      if (!bodyLines.length) {
        return existing;
      }

      const arraysEqual = existing.length === bodyLines.length
        && existing.every((line, index) => line === bodyLines[index]);
      if (arraysEqual) {
        return existing;
      }

      const bodyExtendsExisting = existing.length <= bodyLines.length
        && existing.every((line, index) => line === bodyLines[index]);
      if (bodyExtendsExisting) {
        return bodyLines;
      }

      const existingExtendsBody = bodyLines.length < existing.length
        && bodyLines.every((line, index) => line === existing[index]);
      if (existingExtendsBody) {
        return existing;
      }

      let commonPrefixLength = 0;
      const maxPrefixLength = Math.min(existing.length, bodyLines.length);
      while (commonPrefixLength < maxPrefixLength && existing[commonPrefixLength] === bodyLines[commonPrefixLength]) {
        commonPrefixLength += 1;
      }
      if (commonPrefixLength > 0) {
        return existing.concat(bodyLines.slice(commonPrefixLength));
      }

      return existing.concat(bodyLines);
    }

    function persistPendingStreamSnapshot(chatId) {
      const key = toPositiveInt(chatId);
      if (!key) return null;
      const history = histories?.get?.(key) || [];
      let pendingAssistant = null;
      let pendingTool = null;
      for (let index = history.length - 1; index >= 0; index -= 1) {
        const item = history[index];
        const role = String(item?.role || "").toLowerCase();
        if (!pendingAssistant && item?.pending && ["hermes", "assistant"].includes(role)) {
          pendingAssistant = item;
        }
        if (!pendingTool && item?.pending && role === "tool") {
          pendingTool = item;
        }
        if (pendingAssistant && pendingTool) break;
      }
      const chatPending = Boolean(chats?.get?.(key)?.pending) || Boolean(pendingAssistant) || Boolean(pendingTool);
      if (!chatPending) {
        clearPendingStreamSnapshot(key);
        return null;
      }
      const nextMap = readPendingStreamSnapshotMap();
      const existingSnapshot = nextMap[String(key)] && typeof nextMap[String(key)] === "object"
        ? nextMap[String(key)]
        : {};
      const toolJournalLines = mergeSnapshotToolJournalLines(existingSnapshot.tool_journal_lines, pendingTool?.body || "");
      const timestampMs = currentTimeMs();
      const toolCollapsed = typeof pendingTool?.collapsed === "boolean"
        ? pendingTool.collapsed
        : (typeof existingSnapshot?.tool?.collapsed === "boolean" ? existingSnapshot.tool.collapsed : false);
      const snapshot = {
        ts: timestampMs,
        tool_journal_lines: toolJournalLines,
        tool: (pendingTool || toolJournalLines.length) ? {
          role: "tool",
          body: String((pendingTool?.body || toolJournalLines.join("\n")) || ""),
          created_at: String(pendingTool?.created_at || existingSnapshot?.tool?.created_at || new Date(timestampMs).toISOString()),
          pending: true,
          collapsed: toolCollapsed,
        } : null,
        assistant: pendingAssistant ? {
          role: String(pendingAssistant.role || "hermes").toLowerCase() === "assistant" ? "assistant" : "hermes",
          body: String(pendingAssistant.body || ""),
          created_at: String(pendingAssistant.created_at || new Date(timestampMs).toISOString()),
          pending: true,
        } : null,
      };
      nextMap[String(key)] = snapshot;
      writePendingStreamSnapshotMap(nextMap);
      return snapshot;
    }

    function restorePendingStreamSnapshot(chatId) {
      const key = toPositiveInt(chatId);
      if (!key) return false;
      if (!hasFreshPendingStreamSnapshot(key)) return false;
      const nextMap = readPendingStreamSnapshotMap();
      const snapshot = nextMap[String(key)];
      if (!snapshot || typeof snapshot !== "object") return false;

      const history = Array.isArray(histories?.get?.(key)) ? [...histories.get(key)] : [];
      const journalLines = normalizeSnapshotLines(snapshot.tool_journal_lines);
      const journalBody = journalLines.join("\n");
      const pendingToolIndex = history.findIndex((item) => item?.pending && String(item?.role || "").toLowerCase() === "tool");
      const pendingAssistantIndex = history.findIndex((item) => item?.pending && ["hermes", "assistant"].includes(String(item?.role || "").toLowerCase()));
      const restoredToolCollapsed = typeof snapshot?.tool?.collapsed === "boolean" ? snapshot.tool.collapsed : false;
      let changed = false;
      if (journalBody) {
        if (pendingToolIndex >= 0) {
          const currentTool = history[pendingToolIndex] || {};
          const currentBody = String(currentTool?.body || "");
          const nextTool = {
            ...currentTool,
            body: journalBody,
            pending: true,
            collapsed: typeof currentTool?.collapsed === "boolean" ? currentTool.collapsed : restoredToolCollapsed,
          };
          if (
            currentBody !== journalBody
            || !currentBody.includes(journalBody)
            || currentTool.pending !== true
            || currentTool.collapsed !== nextTool.collapsed
          ) {
            history[pendingToolIndex] = nextTool;
            changed = true;
          }
        } else if (snapshot.tool) {
          history.push({
            ...snapshot.tool,
            body: journalBody,
            pending: true,
            collapsed: restoredToolCollapsed,
          });
          changed = true;
        }
      }
      if (pendingAssistantIndex < 0 && snapshot.assistant && (String(snapshot.assistant.body || "").trim() || snapshot.assistant.pending)) {
        history.push({ ...snapshot.assistant });
        changed = true;
      }
      if (!changed) return false;
      histories?.set?.(key, history);
      return true;
    }

    return {
      readStreamResumeCursorMap,
      writeStreamResumeCursorMap,
      getStoredStreamCursor,
      setStoredStreamCursor,
      clearStoredStreamCursor,
      readPendingStreamSnapshotMap,
      writePendingStreamSnapshotMap,
      clearPendingStreamSnapshot,
      normalizeSnapshotLines,
      mergeSnapshotToolJournalLines,
      hasFreshPendingStreamSnapshot,
      persistPendingStreamSnapshot,
      restorePendingStreamSnapshot,
    };
  }

  const api = {
    STREAM_PHASES,
    normalizeStreamPhase,
    getStreamPhase,
    setStreamPhase,
    isPatchPhaseAllowed,
    markChatStreamPending,
    finalizeChatStreamState,
    clearChatStreamState,
    createPhaseController,
    createLifecycleController,
    createPersistenceController,
  };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
  globalScope.HermesMiniappStreamState = api;
})(typeof window !== "undefined" ? window : globalThis);
