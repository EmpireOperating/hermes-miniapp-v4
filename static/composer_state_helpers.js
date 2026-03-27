(function initHermesMiniappComposerState(globalScope) {
  function deriveComposerState({ activeChatId, pendingChats, chats, isAuthenticated }) {
    const key = Number(activeChatId);
    const pending = pendingChats.has(key) || Boolean(chats.get(key)?.pending);
    return {
      hasActiveChat: Boolean(activeChatId),
      pending,
      canPrompt: Boolean(isAuthenticated),
      canSend: !pending && Boolean(isAuthenticated),
      sendLabel: pending ? "Sending…" : "Send",
      canRemove: !pending && Boolean(isAuthenticated) && Boolean(activeChatId),
      canPin: !pending && Boolean(isAuthenticated) && Boolean(activeChatId),
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

  const api = {
    deriveComposerState,
    applyComposerState,
  };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
  globalScope.HermesMiniappComposerState = api;
})(typeof window !== "undefined" ? window : globalThis);
