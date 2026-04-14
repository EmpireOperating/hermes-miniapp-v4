(function initHermesMiniappRuntimeChatMeta(globalScope) {
  function createSystemMessageNode({ template, nowStamp, renderBody, text }) {
    const node = template.content.firstElementChild.cloneNode(true);
    node.classList.add('message--system');
    node.querySelector('.message__role').textContent = 'system';
    node.querySelector('.message__time').textContent = nowStamp();
    renderBody(node.querySelector('.message__body'), text);
    return node;
  }

  function createMetaController(deps) {
    const {
      getActiveChatId,
      setActiveChatId,
      getRenderedChatId,
      setRenderedChatId,
      chatScrollTop,
      chatStickToBottom,
      messagesEl,
      isNearBottomFn,
      setDraft,
      promptEl,
      activeChatName,
      panelTitle,
      template,
      nowStamp,
      renderBody,
      historyCount,
      updateComposerState,
      syncPinChatButton,
      renderTabs,
      syncActiveTabSelection,
      syncLiveToolStreamForChat,
      syncActivePendingStatus,
      syncActiveLatencyChip,
      updateJumpLatestVisibility,
      getDraft,
      chats,
      scheduleTimeout,
    } = deps;
    let deferredMetaGeneration = 0;

    function setActiveChatMeta(chatId, { fullTabRender = true, deferNonCritical = false } = {}) {
      deferredMetaGeneration += 1;
      const metaGeneration = deferredMetaGeneration;
      const previousActiveRaw = getActiveChatId();
      const hadPreviousActive = previousActiveRaw != null;
      const previousActiveChatId = Number(previousActiveRaw);
      if (hadPreviousActive && Number(getRenderedChatId()) === previousActiveChatId) {
        chatScrollTop.set(previousActiveChatId, messagesEl.scrollTop);
        chatStickToBottom.set(previousActiveChatId, isNearBottomFn(messagesEl));
      }
      if (hadPreviousActive && previousActiveChatId) {
        setDraft(previousActiveChatId, promptEl.value || '');
      }

      const nextActiveChatId = Number(chatId || 0);
      if (!nextActiveChatId) {
        setActiveChatId(null);
        promptEl.value = '';
        activeChatName.textContent = 'None';
        panelTitle.textContent = 'Conversation';
        messagesEl.innerHTML = '';
        messagesEl.appendChild(createSystemMessageNode({
          template,
          nowStamp,
          renderBody,
          text: 'No chats open. Start a new chat to continue.',
        }));
        historyCount.textContent = '0';
        setRenderedChatId(null);
        updateComposerState();
        syncPinChatButton();
        renderTabs();
        syncLiveToolStreamForChat(null);
        syncActivePendingStatus();
        syncActiveLatencyChip();
        updateJumpLatestVisibility();
        return;
      }

      setActiveChatId(nextActiveChatId);
      promptEl.value = getDraft(nextActiveChatId);
      const chat = chats.get(nextActiveChatId);
      const title = chat?.title || 'Chat';
      activeChatName.textContent = title;
      panelTitle.textContent = `Conversation · ${title}`;
      updateComposerState();
      syncPinChatButton();

      if (fullTabRender) {
        renderTabs();
      } else {
        syncActiveTabSelection(previousActiveChatId, nextActiveChatId);
      }

      const syncCriticalMeta = () => {
        syncActivePendingStatus();
        syncActiveLatencyChip();
      };

      const finalizeMeta = () => {
        if (metaGeneration !== deferredMetaGeneration) {
          return;
        }
        if (Number(getActiveChatId()) !== nextActiveChatId) {
          return;
        }
        syncLiveToolStreamForChat(nextActiveChatId);
        updateJumpLatestVisibility();
      };

      if (deferNonCritical) {
        syncCriticalMeta();
        scheduleTimeout(finalizeMeta, 0);
      } else {
        syncLiveToolStreamForChat(nextActiveChatId);
        syncCriticalMeta();
        updateJumpLatestVisibility();
      }
    }

    function setNoActiveChatMeta() {
      setActiveChatMeta(null);
    }

    return {
      setActiveChatMeta,
      setNoActiveChatMeta,
    };
  }

  const api = {
    createMetaController,
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  globalScope.HermesMiniappRuntimeChatMeta = api;
})(typeof window !== 'undefined' ? window : globalThis);
