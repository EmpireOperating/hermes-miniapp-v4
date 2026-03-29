(function initHermesMiniappChatTabs(globalScope) {
  function createController(deps) {
    const {
      localStorageRef,
      pinnedChatsCollapsedStorageKey,
      pinnedChatsAutoCollapseThreshold,
      chats,
      pinnedChats,
      histories,
      pendingChats,
      streamPhaseByChat,
      unseenStreamChats,
      prefetchingHistories,
      chatScrollTop,
      chatStickToBottom,
      virtualizationRanges,
      virtualMetrics,
      renderedHistoryLength,
      renderedHistoryVirtualized,
      tabNodes,
      clearChatStreamState,
      chatUiHelpers,
      pinnedChatsWrap,
      pinnedChatsEl,
      pinnedChatsCountEl,
      pinnedChatsToggleButton,
      pinChatButton,
      documentObject,
      getActiveChatId,
      getPinnedChatsCollapsed,
      setPinnedChatsCollapsedState,
      getHasPinnedChatsCollapsePreference,
      setHasPinnedChatsCollapsePreference,
    } = deps;

    function normalizeChat(chat, { forcePinned = null } = {}) {
      return {
        ...chat,
        id: Number(chat.id),
        unread_count: Number(chat.unread_count || 0),
        pending: Boolean(chat.pending),
        is_pinned: forcePinned == null ? Boolean(chat.is_pinned) : Boolean(forcePinned),
      };
    }

    function upsertChat(chat) {
      const normalized = normalizeChat(chat);
      chats.set(Number(normalized.id), normalized);
      if (normalized.is_pinned) {
        pinnedChats.set(Number(normalized.id), { ...normalized });
      } else {
        pinnedChats.delete(Number(normalized.id));
      }
    }

    function syncPinnedChats(chatList) {
      if (!Array.isArray(chatList)) {
        return;
      }
      pinnedChats.clear();
      chatList.forEach((chat) => {
        const normalized = normalizeChat(chat, { forcePinned: true });
        if (normalized.id > 0) {
          pinnedChats.set(normalized.id, normalized);
        }
      });
    }

    function syncChats(chatList) {
      const nextIds = new Set((chatList || []).map((chat) => Number(chat.id)));
      [...chats.keys()].forEach((chatId) => {
        if (!nextIds.has(Number(chatId))) {
          chats.delete(Number(chatId));
          histories.delete(Number(chatId));
          clearChatStreamState({
            chatId: Number(chatId),
            pendingChats,
            streamPhaseByChat,
            unseenStreamChats,
          });
          prefetchingHistories.delete(Number(chatId));
          chatScrollTop.delete(Number(chatId));
          chatStickToBottom.delete(Number(chatId));
          virtualizationRanges.delete(Number(chatId));
          virtualMetrics.delete(Number(chatId));
          renderedHistoryLength.delete(Number(chatId));
          renderedHistoryVirtualized.delete(Number(chatId));
          const staleNode = tabNodes.get(Number(chatId));
          staleNode?.remove();
          tabNodes.delete(Number(chatId));
        }
      });
      (chatList || []).forEach(upsertChat);
    }

    function getStoredPinnedChatsCollapsed() {
      try {
        const value = localStorageRef.getItem(pinnedChatsCollapsedStorageKey);
        if (value == null) return null;
        return value === '1';
      } catch {
        return null;
      }
    }

    function persistPinnedChatsCollapsed() {
      try {
        localStorageRef.setItem(
          pinnedChatsCollapsedStorageKey,
          getPinnedChatsCollapsed() ? '1' : '0',
        );
      } catch {
        // non-fatal
      }
    }

    function syncPinnedChatsCollapseUi() {
      if (!pinnedChatsToggleButton || !pinnedChatsWrap || !pinnedChatsEl) return;
      const pinnedCount = pinnedChats.size;
      const hasPinnedChats = pinnedCount > 0;
      const pinnedChatsCollapsed = getPinnedChatsCollapsed();

      if (pinnedChatsCountEl) {
        pinnedChatsCountEl.hidden = !hasPinnedChats;
        pinnedChatsCountEl.textContent = hasPinnedChats ? `(${pinnedCount})` : '';
      }

      pinnedChatsToggleButton.hidden = !hasPinnedChats;
      pinnedChatsEl.hidden = hasPinnedChats ? pinnedChatsCollapsed : false;
      pinnedChatsWrap.classList.toggle('is-collapsed', hasPinnedChats && pinnedChatsCollapsed);
      pinnedChatsToggleButton.setAttribute(
        'aria-expanded',
        hasPinnedChats && !pinnedChatsCollapsed ? 'true' : 'false',
      );
      pinnedChatsToggleButton.setAttribute(
        'aria-label',
        pinnedChatsCollapsed
          ? `Show pinned chats (${pinnedCount})`
          : `Hide pinned chats (${pinnedCount})`,
      );
      pinnedChatsToggleButton.textContent = pinnedChatsCollapsed ? 'Show' : 'Hide';
    }

    function maybeAutoCollapsePinnedChats() {
      if (getHasPinnedChatsCollapsePreference()) return;
      if (pinnedChats.size < pinnedChatsAutoCollapseThreshold) return;
      setPinnedChatsCollapsed(true, { persist: false });
    }

    function setPinnedChatsCollapsed(nextCollapsed, { persist = true } = {}) {
      setPinnedChatsCollapsedState(Boolean(nextCollapsed));
      syncPinnedChatsCollapseUi();
      if (persist) {
        setHasPinnedChatsCollapsePreference(true);
        persistPinnedChatsCollapsed();
      }
    }

    function togglePinnedChatsCollapsed() {
      if (pinnedChats.size === 0) return;
      setPinnedChatsCollapsed(!getPinnedChatsCollapsed());
    }

    function renderPinnedChats() {
      maybeAutoCollapsePinnedChats();
      chatUiHelpers.renderPinnedChats({
        pinnedChatsWrap,
        pinnedChatsEl,
        pinnedChats,
        doc: documentObject,
      });
      syncPinnedChatsCollapseUi();
    }

    function syncPinChatButton() {
      if (!pinChatButton) return;
      const chat = chats.get(Number(getActiveChatId()));
      pinChatButton.textContent = chat?.is_pinned ? 'Unpin chat' : 'Pin chat';
    }

    return {
      normalizeChat,
      upsertChat,
      syncPinnedChats,
      syncChats,
      getStoredPinnedChatsCollapsed,
      persistPinnedChatsCollapsed,
      syncPinnedChatsCollapseUi,
      maybeAutoCollapsePinnedChats,
      setPinnedChatsCollapsed,
      togglePinnedChatsCollapsed,
      renderPinnedChats,
      syncPinChatButton,
    };
  }

  const api = { createController };
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  globalScope.HermesMiniappChatTabs = api;
})(typeof window !== 'undefined' ? window : globalThis);
