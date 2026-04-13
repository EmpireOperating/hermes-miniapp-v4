(function initHermesMiniappComposerState(globalScope) {
  function deriveComposerState({ activeChatId, pendingChats, chats, isAuthenticated }) {
    const key = Number(activeChatId);
    const pending = pendingChats.has(key) || Boolean(chats.get(key)?.pending);
    const hasActiveChat = Boolean(activeChatId);
    return {
      hasActiveChat,
      pending,
      canPrompt: Boolean(isAuthenticated) && hasActiveChat,
      canSend: hasActiveChat && Boolean(isAuthenticated),
      sendLabel: pending ? "Interrupt & send" : "Send",
      canRemove: hasActiveChat && !pending && Boolean(isAuthenticated),
      canPin: hasActiveChat && Boolean(isAuthenticated),
    };
  }

  function applyComposerState({
    state,
    sendButton,
    promptEl,
    removeChatButton,
    pinChatButton,
  }) {
    sendButton.disabled = !state.canSend;
    sendButton.textContent = state.sendLabel;
    promptEl.disabled = !state.canPrompt;
    if (removeChatButton) {
      removeChatButton.disabled = !state.canRemove;
    }
    if (pinChatButton) {
      pinChatButton.disabled = !state.canPin;
    }
  }

  function createController({
    getActiveChatId,
    pendingChats,
    chats,
    getIsAuthenticated,
    sendButton,
    promptEl,
    removeChatButton,
    pinChatButton,
  }) {
    function updateComposerState() {
      const state = deriveComposerState({
        activeChatId: typeof getActiveChatId === "function" ? getActiveChatId() : null,
        pendingChats: pendingChats || new Set(),
        chats: chats || new Map(),
        isAuthenticated: typeof getIsAuthenticated === "function" ? getIsAuthenticated() : false,
      });
      applyComposerState({
        state,
        sendButton,
        promptEl,
        removeChatButton,
        pinChatButton,
      });
      return state;
    }

    return {
      updateComposerState,
    };
  }

  function createDraftController({ localStorageRef, draftStorageKey, draftByChat, nowMs = () => Date.now() }) {
    const draftMetaByChat = new Map();

    function normalizeDraftChatId(value) {
      const parsed = Number(value);
      return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
    }

    function normalizeDraftTimestamp(value) {
      const parsed = Number(value);
      return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 0;
    }

    function normalizeDraftText(value) {
      return String(value || "");
    }

    function parseStoredDraftPayload(raw) {
      if (!raw) return new Map();
      try {
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== "object") return new Map();
        const entries = new Map();
        for (const [chatId, value] of Object.entries(parsed)) {
          const key = normalizeDraftChatId(chatId);
          if (!key) continue;
          if (value && typeof value === "object") {
            entries.set(key, {
              value: normalizeDraftText(value.value),
              ts: normalizeDraftTimestamp(value.ts),
            });
            continue;
          }
          entries.set(key, {
            value: normalizeDraftText(value),
            ts: 0,
          });
        }
        return entries;
      } catch {
        return new Map();
      }
    }

    function syncDraftMapFromMeta() {
      draftByChat.clear();
      for (const [chatId, entry] of draftMetaByChat.entries()) {
        const text = normalizeDraftText(entry?.value);
        if (text) {
          draftByChat.set(chatId, text);
        }
      }
    }

    function mergeStoredDraftEntries(storedEntries) {
      let changed = false;
      for (const [chatId, entry] of storedEntries.entries()) {
        const existing = draftMetaByChat.get(chatId);
        const incomingTs = normalizeDraftTimestamp(entry?.ts);
        const existingTs = normalizeDraftTimestamp(existing?.ts);
        const shouldApply = !existing || incomingTs >= existingTs;
        if (!shouldApply) continue;
        const nextValue = normalizeDraftText(entry?.value);
        if (!existing || normalizeDraftText(existing.value) !== nextValue || existingTs !== incomingTs) {
          draftMetaByChat.set(chatId, { value: nextValue, ts: incomingTs });
          changed = true;
        }
      }
      if (changed) {
        syncDraftMapFromMeta();
      }
      return changed;
    }

    function loadDraftsFromStorage() {
      const storedEntries = parseStoredDraftPayload(localStorageRef.getItem(draftStorageKey));
      return mergeStoredDraftEntries(storedEntries);
    }

    function persistDraftsToStorage() {
      try {
        const storedEntries = parseStoredDraftPayload(localStorageRef.getItem(draftStorageKey));
        const merged = new Map(storedEntries);
        for (const [chatId, entry] of draftMetaByChat.entries()) {
          const existing = merged.get(chatId);
          const localTs = normalizeDraftTimestamp(entry?.ts);
          const existingTs = normalizeDraftTimestamp(existing?.ts);
          if (!existing || localTs >= existingTs) {
            merged.set(chatId, {
              value: normalizeDraftText(entry?.value),
              ts: localTs,
            });
          }
        }
        const payload = {};
        for (const [chatId, entry] of merged.entries()) {
          payload[String(chatId)] = {
            value: normalizeDraftText(entry?.value),
            ts: normalizeDraftTimestamp(entry?.ts),
          };
        }
        localStorageRef.setItem(draftStorageKey, JSON.stringify(payload));
        mergeStoredDraftEntries(merged);
      } catch {
        // non-fatal
      }
    }

    function setDraft(chatId, value) {
      const key = normalizeDraftChatId(chatId);
      if (!key) return;
      const text = normalizeDraftText(value);
      const timestamp = normalizeDraftTimestamp(typeof nowMs === "function" ? nowMs() : nowMs) || Date.now();
      draftMetaByChat.set(key, { value: text, ts: timestamp });
      if (text) {
        draftByChat.set(key, text);
      } else {
        draftByChat.delete(key);
      }
      persistDraftsToStorage();
    }

    function getDraft(chatId) {
      const key = normalizeDraftChatId(chatId);
      if (!key) return "";
      return normalizeDraftText(draftMetaByChat.get(key)?.value || draftByChat.get(key) || "");
    }

    return {
      loadDraftsFromStorage,
      persistDraftsToStorage,
      setDraft,
      getDraft,
    };
  }

  const api = {
    deriveComposerState,
    applyComposerState,
    createController,
    createDraftController,
  };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
  globalScope.HermesMiniappComposerState = api;
})(typeof window !== "undefined" ? window : globalThis);
