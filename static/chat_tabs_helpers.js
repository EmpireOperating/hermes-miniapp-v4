(function initHermesMiniappChatTabs(globalScope) {
  function createReconnectResumeController({
    reconnectResumeBlockedChats,
    pendingChats,
    chats,
    resumeCycleCountByChat,
    maxAutoResumeCyclesPerChat,
    resumeCooldownUntilByChat,
    nowFn,
  }) {
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

    return {
      suppressBlockedChatPending,
      clearReconnectResumeBlock,
      resetReconnectResumeBudget,
      consumeReconnectResumeBudget,
      blockReconnectResume,
      isReconnectResumeBlocked,
      applyResumeCooldownPendingSuppression,
      reapplyResumeCooldownPendingSuppression,
    };
  }

  function createChatStateController({
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
    applyResumeCooldownPendingSuppression,
    reapplyResumeCooldownPendingSuppression,
  }) {
    function normalizeChat(chat, { forcePinned = null } = {}) {
      return {
        ...chat,
        id: Number(chat.id),
        unread_count: Number(chat.unread_count || 0),
        pending: Boolean(chat.pending),
        is_pinned: forcePinned == null ? Boolean(chat.is_pinned) : Boolean(forcePinned),
      };
    }

    let orderedChatIds = [];

    function syncOrderedChatIds({ prependChatIds = [], appendChatIds = [] } = {}) {
      const nextOrderedChatIds = [];
      const seenChatIds = new Set();
      const openChatIds = [...chats.keys()]
        .map((chatId) => Number(chatId))
        .filter((chatId) => chatId > 0);

      const pushChatId = (chatId) => {
        const normalizedId = Number(chatId || 0);
        if (!normalizedId || !chats.has(normalizedId) || seenChatIds.has(normalizedId)) {
          return;
        }
        seenChatIds.add(normalizedId);
        nextOrderedChatIds.push(normalizedId);
      };

      prependChatIds.forEach(pushChatId);
      orderedChatIds.forEach(pushChatId);
      openChatIds.sort((a, b) => a - b).forEach(pushChatId);
      appendChatIds.forEach((chatId) => {
        const normalizedId = Number(chatId || 0);
        if (!normalizedId || !seenChatIds.has(normalizedId)) {
          return;
        }
        const existingIndex = nextOrderedChatIds.indexOf(normalizedId);
        if (existingIndex < 0) {
          return;
        }
        nextOrderedChatIds.splice(existingIndex, 1);
        nextOrderedChatIds.push(normalizedId);
      });
      orderedChatIds = nextOrderedChatIds;
      return orderedChatIds.slice();
    }

    function moveChatToEnd(chatId) {
      syncOrderedChatIds({ appendChatIds: [chatId] });
    }

    function getOrderedChatIds() {
      return syncOrderedChatIds();
    }

    function upsertChat(chat) {
      const normalized = normalizeChat(chat);
      chats.set(Number(normalized.id), normalized);
      if (normalized.is_pinned) {
        pinnedChats.set(Number(normalized.id), { ...normalized });
      } else {
        pinnedChats.delete(Number(normalized.id));
      }
      syncOrderedChatIds();
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
      syncOrderedChatIds();
      reapplyResumeCooldownPendingSuppression();
      return nextChats;
    }

    function getOrderedChats() {
      return syncOrderedChatIds()
        .map((chatId) => chats.get(chatId))
        .filter(Boolean);
    }

    return {
      normalizeChat,
      getOrderedChatIds,
      moveChatToEnd,
      upsertChat,
      syncPinnedChats,
      syncChats,
      getOrderedChats,
    };
  }

  function createTabPresentationController({
    chatUiHelpers,
    mobileTabCarouselEnabled,
    getIsMobileCarouselViewport,
    tabOverviewEl,
    documentObject,
    getActiveChatId,
    nowFn,
    mobileTabCarouselInteractionGraceMs,
    tabsEl,
    hiddenUnreadLeftEl,
    hiddenUnreadRightEl,
    hiddenUnreadSummaryEl,
    getOrderedChats,
    getCurrentUnreadCount,
    chats,
    unseenStreamChats,
    pendingChats,
    openChat,
    tabNodes,
  }) {
    function isMobileTabCarouselActive() {
      return Boolean(mobileTabCarouselEnabled && getIsMobileCarouselViewport?.());
    }

    function hiddenUnreadSummaryText(count) {
      if (count <= 0) return '';
      return `${count} hidden unread ${count === 1 ? 'chat' : 'chats'}`;
    }

    function getUnreadState(chatId) {
      const key = Number(chatId || 0);
      if (!key) {
        return { chatId: null, unreadCount: 0, hasUnseenInViewport: false, hasUnreadBadge: false };
      }
      return chatUiHelpers.getTabUnreadState({
        chat: chats.get(key),
        unseenStreamChats,
        getCurrentUnreadCount,
      });
    }

    function getEffectiveUnreadCount(chatId) {
      return getUnreadState(chatId).unreadCount;
    }

    function hasUnreadBadge(chatId) {
      return getUnreadState(chatId).hasUnreadBadge;
    }

    function countHiddenUnreadChats(orderedChats, activeChatId) {
      const activeKey = Number(activeChatId) || 0;
      if (!activeKey) return 0;
      return orderedChats.reduce((total, chat) => {
        const chatId = Number(chat?.id || 0);
        if (!chatId || chatId === activeKey) {
          return total;
        }
        return hasUnreadBadge(chatId) ? total + 1 : total;
      }, 0);
    }

    function getHiddenUnreadDirections(orderedChats, activeChatId) {
      const activeIndex = orderedChats.findIndex((chat) => Number(chat?.id) === Number(activeChatId));
      if (activeIndex < 0) {
        return { left: false, right: false };
      }
      let left = false;
      let right = false;
      orderedChats.forEach((chat, index) => {
        const chatId = Number(chat?.id || 0);
        if (!chatId || chatId === Number(activeChatId) || !hasUnreadBadge(chatId)) {
          return;
        }
        if (index < activeIndex) {
          left = true;
        } else if (index > activeIndex) {
          right = true;
        }
      });
      return { left, right };
    }

    function getOverviewMarkerState(chat) {
      const chatId = Number(chat?.id || 0);
      if (!chatId) return 'idle';
      if (hasUnreadBadge(chatId)) {
        return 'unread';
      }
      if (pendingChats.has(chatId) || Boolean(chat?.pending)) {
        return 'working';
      }
      return 'idle';
    }

    function getOverviewMarkerText(chat, state) {
      if (state === 'working') {
        return '⋯';
      }
      if (state === 'unread') {
        return '';
      }
      return '•';
    }

    function getOverviewMarkerAriaLabel(chat, state, isActive) {
      const title = String(chat?.title || `Chat ${Number(chat?.id || 0) || ''}`).trim() || 'Chat';
      const prefix = isActive ? 'Active chat' : 'Chat';
      if (state === 'working') {
        return `${prefix}: ${title}, working`;
      }
      if (state === 'unread') {
        const unread = getEffectiveUnreadCount(chat?.id);
        if (unread > 0) {
          return `${prefix}: ${title}, ${unread} unread ${unread === 1 ? 'message' : 'messages'}`;
        }
        return `${prefix}: ${title}, unread activity`;
      }
      return `${prefix}: ${title}, idle`;
    }

    function syncMobileTabOverviewAlignment() {
      if (!tabOverviewEl) return;
      const canMeasure = typeof tabOverviewEl.scrollWidth === 'number' && typeof tabOverviewEl.clientWidth === 'number';
      const shouldCenter = Boolean(
        !tabOverviewEl.hidden
        && isMobileTabCarouselActive()
        && canMeasure
        && tabOverviewEl.scrollWidth > 0
        && tabOverviewEl.clientWidth > 0
        && tabOverviewEl.scrollWidth <= (tabOverviewEl.clientWidth + 1)
      );
      tabOverviewEl.classList?.toggle?.('chat-tabs__overview--centered', shouldCenter);
    }

    function renderMobileTabOverview() {
      if (!tabOverviewEl) return;
      const enabled = isMobileTabCarouselActive();
      const orderedChats = getOrderedChats();
      tabOverviewEl.hidden = !enabled || orderedChats.length === 0;
      if (tabOverviewEl.hidden) {
        tabOverviewEl.replaceChildren?.();
        syncMobileTabOverviewAlignment();
        return;
      }
      const activeChatId = Number(getActiveChatId()) || 0;
      const fragmentNodes = orderedChats.map((chat) => {
        const chatId = Number(chat?.id || 0);
        const marker = documentObject?.createElement?.('button');
        if (!marker) return null;
        const state = getOverviewMarkerState(chat);
        const isActive = chatId === activeChatId;
        marker.type = 'button';
        marker.className = 'chat-tabs__overview-marker';
        marker.dataset.chatId = String(chatId);
        marker.dataset.state = state;
        marker.dataset.active = isActive ? 'true' : 'false';
        marker.setAttribute('aria-label', getOverviewMarkerAriaLabel(chat, state, isActive));
        marker.setAttribute('title', String(chat?.title || `Chat ${chatId}`));
        const stateEl = documentObject?.createElement?.('span');
        if (stateEl) {
          stateEl.className = 'chat-tabs__overview-pill';
          stateEl.dataset.state = state;
          stateEl.textContent = getOverviewMarkerText(chat, state);
          marker.appendChild(stateEl);
        } else {
          marker.textContent = getOverviewMarkerText(chat, state);
        }
        marker.addEventListener?.('click', () => {
          if (!chatId || chatId === Number(getActiveChatId())) return;
          void openChat(chatId);
        });
        return marker;
      }).filter(Boolean);
      tabOverviewEl.replaceChildren?.(...fragmentNodes);
      syncMobileTabOverviewAlignment();
    }

    function syncHiddenUnreadDirectionEl(element, { visible = false, direction = '' } = {}) {
      if (!element) return;
      element.hidden = !visible;
      element.textContent = visible ? '•' : '';
      element.setAttribute('aria-hidden', 'true');
      if (direction) {
        element.setAttribute('data-direction', direction);
      } else {
        element.setAttribute('data-direction', '');
      }
    }

    return {
      isMobileTabCarouselActive,
      hiddenUnreadSummaryText,
      hasUnreadBadge,
      countHiddenUnreadChats,
      getHiddenUnreadDirections,
      getOverviewMarkerState,
      getOverviewMarkerText,
      getOverviewMarkerAriaLabel,
      renderMobileTabOverview,
      syncHiddenUnreadDirectionEl,
    };
  }

  function createMobileCarouselController({
    isMobileTabCarouselActive,
    getActiveChatId,
    nowFn,
    mobileTabCarouselInteractionGraceMs,
    tabsEl,
    hiddenUnreadLeftEl,
    hiddenUnreadRightEl,
    hiddenUnreadSummaryEl,
    tabNodes,
    renderMobileTabOverview,
    syncHiddenUnreadDirectionEl,
  }) {
    let lastMobileCarouselInteractionAt = null;
    let lastCenteredCarouselChatId = null;
    let wasMobileTabCarouselActive = false;
    let mobileCarouselManualScrollActiveChatId = null;

    function noteMobileCarouselInteraction() {
      if (!isMobileTabCarouselActive()) return;
      lastMobileCarouselInteractionAt = Number(nowFn()) || 0;
      mobileCarouselManualScrollActiveChatId = Number(getActiveChatId()) || null;
    }

    function shouldRespectMobileCarouselManualScroll() {
      if (!isMobileTabCarouselActive()) return false;
      const activeChatId = Number(getActiveChatId()) || null;
      if (mobileCarouselManualScrollActiveChatId && mobileCarouselManualScrollActiveChatId === activeChatId) {
        return true;
      }
      if (!Number.isFinite(lastMobileCarouselInteractionAt)) return false;
      const now = Number(nowFn()) || 0;
      const graceMs = Math.max(0, Number(mobileTabCarouselInteractionGraceMs) || 0);
      return graceMs > 0 && (now - lastMobileCarouselInteractionAt) < graceMs;
    }

    function syncMobileTabCarouselUi() {
      const enabled = isMobileTabCarouselActive();
      tabsEl?.classList?.toggle?.('chat-tabs--mobile-carousel', enabled);
      tabsEl?.setAttribute?.('data-mobile-carousel', enabled ? 'true' : 'false');
      if (!enabled) {
        lastMobileCarouselInteractionAt = null;
        lastCenteredCarouselChatId = null;
        mobileCarouselManualScrollActiveChatId = null;
      }
      syncHiddenUnreadDirectionEl(hiddenUnreadLeftEl, { visible: false });
      syncHiddenUnreadDirectionEl(hiddenUnreadRightEl, { visible: false });
      renderMobileTabOverview();
      if (!enabled) {
        if (hiddenUnreadSummaryEl) {
          hiddenUnreadSummaryEl.hidden = true;
          hiddenUnreadSummaryEl.textContent = '';
          hiddenUnreadSummaryEl.setAttribute('aria-label', '');
        }
        wasMobileTabCarouselActive = enabled;
        return;
      }
      if (hiddenUnreadSummaryEl) {
        hiddenUnreadSummaryEl.hidden = true;
        hiddenUnreadSummaryEl.textContent = '';
        hiddenUnreadSummaryEl.setAttribute('aria-label', '');
      }
      wasMobileTabCarouselActive = enabled;
    }

    function centerActiveTabInCarousel({ force = false } = {}) {
      if (!isMobileTabCarouselActive()) return;
      const activeChatId = Number(getActiveChatId());
      const shouldCenterBecauseStateChanged = !wasMobileTabCarouselActive || lastCenteredCarouselChatId !== activeChatId;
      if (!force && !shouldCenterBecauseStateChanged) {
        return;
      }
      if (!force && shouldRespectMobileCarouselManualScroll()) return;
      const activeNode = tabNodes.get(activeChatId);
      activeNode?.scrollIntoView?.({ block: 'nearest', inline: 'center' });
      lastCenteredCarouselChatId = activeChatId;
    }

    function resetManualScrollState() {
      mobileCarouselManualScrollActiveChatId = null;
      lastMobileCarouselInteractionAt = null;
    }

    return {
      noteMobileCarouselInteraction,
      shouldRespectMobileCarouselManualScroll,
      syncMobileTabCarouselUi,
      centerActiveTabInCarousel,
      resetManualScrollState,
    };
  }

  function createPinnedChatsController({
    chatUiHelpers,
    documentObject,
    pinChatButton,
    chats,
    getActiveChatId,
    pinnedChats,
    pinnedCollapseController,
    pinnedChatsWrap,
    pinnedChatsEl,
  }) {
    function renderPinnedChats() {
      pinnedCollapseController.maybeAutoCollapsePinnedChats();
      chatUiHelpers.renderPinnedChats({
        pinnedChatsWrap,
        pinnedChatsEl,
        pinnedChats,
        doc: documentObject,
      });
      pinnedCollapseController.syncPinnedChatsCollapseUi();
    }

    function syncPinChatButton() {
      if (!pinChatButton) return;
      const chat = chats.get(Number(getActiveChatId()));
      pinChatButton.textContent = chat?.is_pinned ? 'Unpin chat' : 'Pin chat';
    }

    return {
      renderPinnedChats,
      syncPinChatButton,
    };
  }


  function createPinnedCollapseController({
    localStorageRef,
    pinnedChatsCollapsedStorageKey,
    getPinnedChatsCollapsed,
    setPinnedChatsCollapsedState,
    getHasPinnedChatsCollapsePreference,
    setHasPinnedChatsCollapsePreference,
    pinnedChats,
    pinnedChatsAutoCollapseThreshold,
    pinnedChatsToggleButton,
    pinnedChatsWrap,
    pinnedChatsEl,
    pinnedChatsCountEl,
  }) {
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

    function setPinnedChatsCollapsed(nextCollapsed, { persist = true } = {}) {
      setPinnedChatsCollapsedState(Boolean(nextCollapsed));
      syncPinnedChatsCollapseUi();
      if (persist) {
        setHasPinnedChatsCollapsePreference(true);
        persistPinnedChatsCollapsed();
      }
    }

    function maybeAutoCollapsePinnedChats() {
      if (getHasPinnedChatsCollapsePreference()) return;
      if (pinnedChats.size < pinnedChatsAutoCollapseThreshold) return;
      setPinnedChatsCollapsed(true, { persist: false });
    }

    function togglePinnedChatsCollapsed() {
      if (pinnedChats.size === 0) return;
      setPinnedChatsCollapsed(!getPinnedChatsCollapsed());
    }

    return {
      getStoredPinnedChatsCollapsed,
      persistPinnedChatsCollapsed,
      syncPinnedChatsCollapseUi,
      maybeAutoCollapsePinnedChats,
      setPinnedChatsCollapsed,
      togglePinnedChatsCollapsed,
    };
  }

  function createTabNodeController({
    chatUiHelpers,
    tabNodes,
    tabTemplate,
    pendingChats,
    unseenStreamChats,
    getActiveChatId,
    renderTraceLog,
    chats,
  }) {
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
        getCurrentUnreadCount,
      });
      const chatId = Number(chat?.id || 0);
      if (chatId > 0) {
        const unreadState = chatUiHelpers.getTabUnreadState({
          chat,
          unseenStreamChats,
          getCurrentUnreadCount,
        });
        const unread = unreadState.unreadCount;
        const pending = pendingChats.has(chatId) || Boolean(chat?.pending);
        const unseen = unreadState.hasUnseenInViewport;
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

    return {
      getOrCreateTabNode,
      getTabBadgeState,
      applyTabBadgeState,
      applyTabNodeState,
      removeMissingTabNodes,
    };
  }

  function createTabsRenderController({
    chatUiHelpers,
    chats,
    tabNodes,
    tabTemplate,
    tabsEl,
    getOrderedChats,
    applyTabNodeState,
    syncMobileTabCarouselUi,
    centerActiveTabInCarousel,
    getActiveChatId,
    renderTraceLog,
    pendingChats,
    unseenStreamChats,
    resetManualScrollState,
  }) {
    function renderTabs() {
      chatUiHelpers.renderTabs({
        chats,
        tabNodes,
        tabTemplate,
        tabsEl,
        orderedChats: getOrderedChats(),
        applyTabNodeState,
      });
      syncMobileTabCarouselUi();
      centerActiveTabInCarousel();
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
      syncMobileTabCarouselUi();
    }

    function syncActiveTabSelection(previousChatId, nextChatId) {
      const previousKey = Number(previousChatId) || null;
      const nextKey = Number(nextChatId) || null;
      const didActiveChatChange = previousKey !== nextKey;
      chatUiHelpers.syncActiveTabSelection({
        previousChatId,
        nextChatId,
        tabNodes,
        renderTabs,
        refreshTabNode,
      });
      if (didActiveChatChange) {
        resetManualScrollState();
      }
      syncMobileTabCarouselUi();
      centerActiveTabInCarousel({ force: didActiveChatChange });
    }

    return {
      renderTabs,
      refreshTabNode,
      syncActiveTabSelection,
    };
  }

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
      hiddenUnreadLeftEl,
      hiddenUnreadRightEl,
      hiddenUnreadSummaryEl,
      tabOverviewEl,
      mobileTabCarouselEnabled = false,
      getIsMobileCarouselViewport = () => false,
      mobileTabCarouselInteractionGraceMs = 1200,
      getCurrentUnreadCount = null,
      openChat = async () => {},
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

    const reconnectResumeController = createReconnectResumeController({
      reconnectResumeBlockedChats,
      pendingChats,
      chats,
      resumeCycleCountByChat,
      maxAutoResumeCyclesPerChat,
      resumeCooldownUntilByChat,
      nowFn,
    });
    const {
      suppressBlockedChatPending,
      clearReconnectResumeBlock,
      resetReconnectResumeBudget,
      consumeReconnectResumeBudget,
      blockReconnectResume,
      isReconnectResumeBlocked,
      applyResumeCooldownPendingSuppression,
      reapplyResumeCooldownPendingSuppression,
    } = reconnectResumeController;

    const chatStateController = createChatStateController({
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
      applyResumeCooldownPendingSuppression,
      reapplyResumeCooldownPendingSuppression,
    });
    const {
      normalizeChat,
      getOrderedChatIds,
      moveChatToEnd,
      upsertChat,
      syncPinnedChats,
      syncChats,
      getOrderedChats,
    } = chatStateController;

    const tabNodeController = createTabNodeController({
      chatUiHelpers,
      tabNodes,
      tabTemplate,
      pendingChats,
      unseenStreamChats,
      getActiveChatId,
      renderTraceLog,
      chats,
    });
    const {
      getOrCreateTabNode,
      getTabBadgeState,
      applyTabBadgeState,
      applyTabNodeState,
      removeMissingTabNodes,
    } = tabNodeController;

    const tabPresentationController = createTabPresentationController({
      chatUiHelpers,
      mobileTabCarouselEnabled,
      getIsMobileCarouselViewport,
      tabOverviewEl,
      documentObject,
      getActiveChatId,
      nowFn,
      mobileTabCarouselInteractionGraceMs,
      tabsEl,
      hiddenUnreadLeftEl,
      hiddenUnreadRightEl,
      hiddenUnreadSummaryEl,
      getOrderedChats,
      getCurrentUnreadCount,
      chats,
      unseenStreamChats,
      pendingChats,
      openChat,
      tabNodes,
    });
    const {
      isMobileTabCarouselActive,
      hiddenUnreadSummaryText,
      hasUnreadBadge,
      countHiddenUnreadChats,
      getHiddenUnreadDirections,
      getOverviewMarkerState,
      getOverviewMarkerText,
      getOverviewMarkerAriaLabel,
      renderMobileTabOverview,
      syncHiddenUnreadDirectionEl,
    } = tabPresentationController;

    const mobileCarouselController = createMobileCarouselController({
      isMobileTabCarouselActive,
      getActiveChatId,
      nowFn,
      mobileTabCarouselInteractionGraceMs,
      tabsEl,
      hiddenUnreadLeftEl,
      hiddenUnreadRightEl,
      hiddenUnreadSummaryEl,
      tabNodes,
      renderMobileTabOverview,
      syncHiddenUnreadDirectionEl,
    });
    const {
      noteMobileCarouselInteraction,
      shouldRespectMobileCarouselManualScroll,
      syncMobileTabCarouselUi,
      centerActiveTabInCarousel,
      resetManualScrollState,
    } = mobileCarouselController;

    const tabsRenderController = createTabsRenderController({
      chatUiHelpers,
      chats,
      tabNodes,
      tabTemplate,
      tabsEl,
      getOrderedChats,
      applyTabNodeState,
      syncMobileTabCarouselUi,
      centerActiveTabInCarousel,
      getActiveChatId,
      renderTraceLog,
      pendingChats,
      unseenStreamChats,
      resetManualScrollState,
    });
    const { renderTabs, refreshTabNode, syncActiveTabSelection } = tabsRenderController;

    const pinnedCollapseController = createPinnedCollapseController({
      localStorageRef,
      pinnedChatsCollapsedStorageKey,
      getPinnedChatsCollapsed,
      setPinnedChatsCollapsedState,
      getHasPinnedChatsCollapsePreference,
      setHasPinnedChatsCollapsePreference,
      pinnedChats,
      pinnedChatsAutoCollapseThreshold,
      pinnedChatsToggleButton,
      pinnedChatsWrap,
      pinnedChatsEl,
      pinnedChatsCountEl,
    });
    const {
      getStoredPinnedChatsCollapsed,
      persistPinnedChatsCollapsed,
      syncPinnedChatsCollapseUi,
      maybeAutoCollapsePinnedChats,
      setPinnedChatsCollapsed,
      togglePinnedChatsCollapsed,
    } = pinnedCollapseController;

    const pinnedChatsController = createPinnedChatsController({
      chatUiHelpers,
      documentObject,
      pinChatButton,
      chats,
      getActiveChatId,
      pinnedChats,
      pinnedCollapseController,
      syncPinnedChatsCollapseUi,
      maybeAutoCollapsePinnedChats,
      pinnedChatsWrap,
      pinnedChatsEl,
    });
    const { renderPinnedChats, syncPinChatButton } = pinnedChatsController;

    return {
      normalizeChat,
      getOrderedChatIds,
      moveChatToEnd,
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
      isMobileTabCarouselActive,
      hiddenUnreadSummaryText,
      hasUnreadBadge,
      countHiddenUnreadChats,
      getHiddenUnreadDirections,
      getOverviewMarkerState,
      getOverviewMarkerText,
      getOverviewMarkerAriaLabel,
      renderMobileTabOverview,
      syncHiddenUnreadDirectionEl,
      syncMobileTabCarouselUi,
      noteMobileCarouselInteraction,
      shouldRespectMobileCarouselManualScroll,
      centerActiveTabInCarousel,
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

  const api = {
    createController,
    createReconnectResumeController,
    createChatStateController,
    createTabNodeController,
    createTabsRenderController,
    createTabPresentationController,
    createMobileCarouselController,
    createPinnedCollapseController,
    createPinnedChatsController,
  };
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  globalScope.HermesMiniappChatTabs = api;
})(typeof window !== 'undefined' ? window : globalThis);
