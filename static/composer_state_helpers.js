(function initHermesMiniappComposerState(globalScope) {
  function deriveComposerState({ activeChatId, pendingChats, chats, isAuthenticated }) {
    const key = Number(activeChatId);
    const pending = pendingChats.has(key) || Boolean(chats.get(key)?.pending);
    const hasActiveChat = Boolean(activeChatId);
    return {
      hasActiveChat,
      pending,
      canPrompt: Boolean(isAuthenticated) && hasActiveChat,
      canSend: hasActiveChat && !pending && Boolean(isAuthenticated),
      sendLabel: pending ? "Sending…" : "Send",
      canRemove: hasActiveChat && !pending && Boolean(isAuthenticated),
      canPin: hasActiveChat && !pending && Boolean(isAuthenticated),
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

  function createDraftController({ localStorageRef, draftStorageKey, draftByChat }) {
    function loadDraftsFromStorage() {
      try {
        const raw = localStorageRef.getItem(draftStorageKey);
        if (!raw) return;
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== "object") return;
        for (const [chatId, value] of Object.entries(parsed)) {
          const key = Number(chatId);
          if (!key) continue;
          const text = String(value || "");
          if (text) {
            draftByChat.set(key, text);
          }
        }
      } catch {
        // non-fatal
      }
    }

    function persistDraftsToStorage() {
      try {
        const payload = {};
        for (const [chatId, draft] of draftByChat.entries()) {
          if (!draft) continue;
          payload[String(chatId)] = draft;
        }
        localStorageRef.setItem(draftStorageKey, JSON.stringify(payload));
      } catch {
        // non-fatal
      }
    }

    function setDraft(chatId, value) {
      const key = Number(chatId);
      if (!key) return;
      const text = String(value || "");
      if (text) {
        draftByChat.set(key, text);
      } else {
        draftByChat.delete(key);
      }
      persistDraftsToStorage();
    }

    function getDraft(chatId) {
      const key = Number(chatId);
      if (!key) return "";
      return String(draftByChat.get(key) || "");
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
    createDraftController,
  };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
  globalScope.HermesMiniappComposerState = api;
})(typeof window !== "undefined" ? window : globalThis);
