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

  const api = {
    STREAM_PHASES,
    normalizeStreamPhase,
    getStreamPhase,
    setStreamPhase,
    isPatchPhaseAllowed,
    markChatStreamPending,
    finalizeChatStreamState,
    clearChatStreamState,
  };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
  globalScope.HermesMiniappStreamState = api;
})(typeof window !== "undefined" ? window : globalThis);
