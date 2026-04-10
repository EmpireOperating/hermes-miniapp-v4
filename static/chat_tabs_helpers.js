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
      tabTemplate,
      tabsEl,
      clearChatStreamState,
      chatUiHelpers,
      pinnedChatsWrap,
      pinnedChatsEl,
      pinnedChatsCountEl,
      pinnedChatsToggleButton,
      pinChatButton,
      documentObject,
      renderTraceLog,
      getActiveChatId,
      getPinnedChatsCollapsed,
      setPinnedChatsCollapsedState,
      getHasPinnedChatsCollapsePreference,
      setHasPinnedChatsCollapsePreference,
      resumeCooldownUntilByChat,
      reconnectResumeBlockedChats,
      resumeCycleCountByChat,
      maxAutoResumeCyclesPerChat = 6,
      nowFn = () => Date.now(),
    } = deps;

    function toPositiveInt(value) {
      const parsed = Number(value);
      return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
    }

    function suppressBlockedChatPending(chatId) {
      const key = toPositiveInt(chatId);
      if (!key || !reconnectResumeBlockedChats?.has?.(key)) return;
      pendingChats?.delete?.(key);
      const chat = chats.get(key);
      if (chat && typeof chat === 'object') {
        chat.pending = false;
      }
    }

    function clearReconnectResumeBlock(chatId) {
      const key = toPositiveInt(chatId);
      if (!key) return;
      reconnectResumeBlockedChats?.delete?.(key);
    }

    function resetReconnectResumeBudget(chatId) {
      const key = toPositiveInt(chatId);
      if (!key) return;
      resumeCycleCountByChat?.delete?.(key);
    }

    function consumeReconnectResumeBudget(chatId) {
      const key = toPositiveInt(chatId);
      if (!key) {
        return { allowed: false, attempts: 0, maxAttempts: maxAutoResumeCyclesPerChat };
      }
      const nextAttempts = Number(resumeCycleCountByChat?.get?.(key) || 0) + 1;
      resumeCycleCountByChat?.set?.(key, nextAttempts);
      return {
        allowed: nextAttempts <= maxAutoResumeCyclesPerChat,
        attempts: nextAttempts,
        maxAttempts: maxAutoResumeCyclesPerChat,
      };
    }

    function blockReconnectResume(chatId) {
      const key = toPositiveInt(chatId);
      if (!key) return;
      reconnectResumeBlockedChats?.add?.(key);
      suppressBlockedChatPending(key);
    }

    function isReconnectResumeBlocked(chatId) {
      const key = toPositiveInt(chatId);
      return Boolean(key && reconnectResumeBlockedChats?.has?.(key));
    }

    function normalizeChat(chat, { forcePinned = null } = {}) {
      return {
        ...chat,
        id: Number(chat.id),
        unread_count: Number(chat.unread_count || 0),
        pending: Boolean(chat.pending),
        is_pinned: forcePinned == null ? Boolean(chat.is_pinned) : Boolean(forcePinned),
      };
    }

    function applyResumeCooldownPendingSuppression(chatId) {
      const key = Number(chatId);
      const cooldownUntil = Number(resumeCooldownUntilByChat?.get?.(key) || 0);
      if (key > 0 && cooldownUntil > nowFn()) {
        const synced = chats.get(key);
        if (synced && typeof synced === 'object') {
          synced.pending = false;
        }
      }
      suppressBlockedChatPending?.(key);
    }

    function reapplyResumeCooldownPendingSuppression() {
      const now = nowFn();
      for (const [chatId, until] of resumeCooldownUntilByChat?.entries?.() || []) {
        const key = Number(chatId);
        const cooldownUntil = Number(until || 0);
        if (!key || cooldownUntil <= now) continue;
        const chat = chats.get(key);
        if (chat && typeof chat === 'object') {
          chat.pending = false;
        }
      }
      for (const blockedChatId of reconnectResumeBlockedChats || []) {
        suppressBlockedChatPending?.(blockedChatId);
      }
    }

    function upsertChat(chat) {
      const normalized = normalizeChat(chat);
      chats.set(Number(normalized.id), normalized);
      if (normalized.is_pinned) {
        pinnedChats.set(Number(normalized.id), { ...normalized });
      } else {
        pinnedChats.delete(Number(normalized.id));
      }
      applyResumeCooldownPendingSuppression(normalized.id);
      return normalized;
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
          pinnedChats.delete(Number(chatId));
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
      const nextChats = (chatList || []).map(upsertChat);
      reapplyResumeCooldownPendingSuppression();
      return nextChats;
    }

    function getOrCreateTabNode(chatId) {
      return chatUiHelpers.getOrCreateTabNode({
        tabNodes,
        tabTemplate,
        chatId,
      });
    }

    function getTabBadgeState(chat) {
      const badgeState = chatUiHelpers.getTabBadgeState({
        chat,
        pendingChats,
        unseenStreamChats,
      });
      const chatId = Number(chat?.id || 0);
      if (chatId > 0) {
        const unread = Math.max(0, Number(chat?.unread_count || 0));
        const pending = pendingChats.has(chatId) || Boolean(chat?.pending);
        const unseen = unseenStreamChats.has(chatId);
        if (pending || unread > 0 || unseen || chatId === Number(getActiveChatId())) {
          renderTraceLog?.('tab-badge-state', {
            chatId,
            activeChatId: Number(getActiveChatId()),
            pending,
            unread,
            unseen,
            badgeText: String(badgeState?.text || ''),
            badgeClasses: Array.isArray(badgeState?.classes) ? badgeState.classes.slice() : [],
          });
        }
      }
      return badgeState;
    }

    function applyTabBadgeState(badge, badgeState) {
      chatUiHelpers.applyTabBadgeState({ badge, badgeState });
    }

    function applyTabNodeState(node, chat) {
      chatUiHelpers.applyTabNodeState({
        node,
        chat,
        activeChatId: getActiveChatId(),
        pendingChats,
        unseenStreamChats,
        getTabBadgeState,
        applyTabBadgeState,
      });
    }

    function removeMissingTabNodes(nextIds) {
      chatUiHelpers.removeMissingTabNodes({ tabNodes, nextIds });
    }

    function renderTabs() {
      chatUiHelpers.renderTabs({
        chats,
        tabNodes,
        tabTemplate,
        tabsEl,
        applyTabNodeState,
      });
    }

    function refreshTabNode(chatId) {
      const key = Number(chatId);
      const chat = chats.get(key);
      renderTraceLog?.('tab-refresh-request', {
        chatId: key,
        activeChatId: Number(getActiveChatId()),
        pendingLocal: pendingChats.has(key),
        pendingServer: Boolean(chat?.pending),
        unread: Math.max(0, Number(chat?.unread_count || 0)),
        unseen: unseenStreamChats.has(key),
      });
      chatUiHelpers.refreshTabNode({
        chatId,
        tabNodes,
        chats,
        applyTabNodeState,
      });
    }

    function syncActiveTabSelection(previousChatId, nextChatId) {
      chatUiHelpers.syncActiveTabSelection({
        previousChatId,
        nextChatId,
        tabNodes,
        renderTabs,
        refreshTabNode,
      });
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
      suppressBlockedChatPending,
      clearReconnectResumeBlock,
      resetReconnectResumeBudget,
      consumeReconnectResumeBudget,
      blockReconnectResume,
      isReconnectResumeBlocked,
      getOrCreateTabNode,
      getTabBadgeState,
      applyTabBadgeState,
      applyTabNodeState,
      removeMissingTabNodes,
      renderTabs,
      refreshTabNode,
      syncActiveTabSelection,
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
