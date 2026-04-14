(function initHermesMiniappRuntimeLocalMutation(globalScope) {
  function createSystemMessageNode({ template, nowStamp, renderBody, text }) {
    const node = template.content.firstElementChild.cloneNode(true);
    node.classList.add('message--system');
    node.querySelector('.message__role').textContent = 'system';
    node.querySelector('.message__time').textContent = nowStamp();
    renderBody(node.querySelector('.message__body'), text);
    return node;
  }

  function createLocalMutationController(deps) {
    const {
      histories,
      getActiveChatId,
      messagesEl,
      template,
      nowStamp,
      renderBody,
      renderMessages,
      persistPendingStreamSnapshot,
      clearPendingStreamSnapshot,
      enqueueUiMutation,
      isActiveChat,
      normalizeChatId = (chatId) => Number(chatId),
      reconcilePendingAssistantUpdate,
    } = deps;

    const activeRenderState = {
      scheduled: false,
      chatId: null,
    };

    function addLocalMessage(chatId, message) {
      const key = normalizeChatId(chatId);
      const history = histories.get(key) || [];
      history.push(message);
      histories.set(key, history);
    }

    function appendSystemMessage(text, chatIdOverride = null) {
      const targetChatId = normalizeChatId(chatIdOverride) || normalizeChatId(getActiveChatId());
      if (!targetChatId) {
        messagesEl?.appendChild?.(createSystemMessageNode({
          template,
          nowStamp,
          renderBody,
          text,
        }));
        return;
      }
      addLocalMessage(targetChatId, { role: 'system', body: text, created_at: new Date().toISOString() });
      if (targetChatId === normalizeChatId(getActiveChatId())) {
        renderMessages(targetChatId);
      }
    }

    function updatePendingAssistant(chatId, nextBody, pendingState = true) {
      const key = normalizeChatId(chatId);
      const history = histories.get(key) || [];
      const mutation = reconcilePendingAssistantUpdate(history, {
        nextBody,
        pendingState,
        defaultRole: 'hermes',
      });
      if (!mutation.changed && !mutation.shouldClearSnapshot && !mutation.shouldPersistSnapshot) {
        return;
      }
      if (mutation.changed) {
        histories.set(key, mutation.history);
      }
      if (mutation.shouldPersistSnapshot) {
        persistPendingStreamSnapshot?.(key);
      }
      if (mutation.shouldClearSnapshot) {
        clearPendingStreamSnapshot?.(key);
      }
    }

    function syncActiveMessageView(chatId, options = {}) {
      if (!isActiveChat(chatId)) return;
      renderMessages(chatId, options);
    }

    function scheduleActiveMessageView(chatId) {
      if (!isActiveChat(chatId)) return;
      activeRenderState.chatId = normalizeChatId(chatId);
      if (activeRenderState.scheduled) return;
      activeRenderState.scheduled = true;
      enqueueUiMutation(() => {
        activeRenderState.scheduled = false;
        const targetChatId = activeRenderState.chatId;
        activeRenderState.chatId = null;
        if (targetChatId == null || !isActiveChat(targetChatId)) return;
        renderMessages(targetChatId, { preserveViewport: true });
      });
    }

    return {
      addLocalMessage,
      appendSystemMessage,
      updatePendingAssistant,
      syncActiveMessageView,
      scheduleActiveMessageView,
    };
  }

  const api = {
    createLocalMutationController,
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  globalScope.HermesMiniappRuntimeLocalMutation = api;
})(typeof window !== 'undefined' ? window : globalThis);
