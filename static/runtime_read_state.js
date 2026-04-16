(function (globalScope) {
  function normalizeChatId(chatId) {
    return Number(chatId);
  }

  function resolvePreservedUnreadState({
    chat,
    chats,
    getActiveChatId,
    hasReachedNewestUnreadMessageBottom,
    preserveActivationUnread = false,
    hasActivationReadThreshold = null,
  } = {}) {
    if (!chat || typeof chat !== 'object') {
      return chat;
    }
    const key = normalizeChatId(chat.id);
    if (!key) {
      return chat;
    }
    const nextChat = { ...chat };
    if (!preserveActivationUnread) {
      return nextChat;
    }
    const localChat = chats.get(key) || null;
    const localUnread = Math.max(0, Number(localChat?.unread_count || 0));
    const localUnreadAnchor = Math.max(0, Number(localChat?.newest_unread_message_id || 0));
    const incomingUnread = Math.max(0, Number(nextChat.unread_count || 0));
    const activeUnreadAboveNewestMessage = Boolean(
      key === normalizeChatId(getActiveChatId?.())
      && localUnread > incomingUnread
      && !hasReachedNewestUnreadMessageBottom(key, { tolerance: 40 })
    );
    const thresholdStillArmed = typeof hasActivationReadThreshold === 'function'
      ? Boolean(hasActivationReadThreshold(key))
      : false;
    if ((thresholdStillArmed || activeUnreadAboveNewestMessage) && localUnread > incomingUnread) {
      nextChat.unread_count = localUnread;
      nextChat.newest_unread_message_id = localUnreadAnchor;
    }
    return nextChat;
  }

  function isIncomingChatLaggingLocalState(currentChat, incomingChat) {
    if (!currentChat || typeof currentChat !== 'object' || !incomingChat || typeof incomingChat !== 'object') {
      return false;
    }
    const localUnread = Math.max(0, Number(currentChat.unread_count || 0));
    const incomingUnread = Math.max(0, Number(incomingChat.unread_count || 0));
    if (localUnread > incomingUnread) {
      return true;
    }
    const localUnreadAnchor = Math.max(0, Number(currentChat.newest_unread_message_id || 0));
    const incomingUnreadAnchor = Math.max(0, Number(incomingChat.newest_unread_message_id || 0));
    if (localUnreadAnchor > incomingUnreadAnchor) {
      return true;
    }
    return Boolean(currentChat.pending) && !Boolean(incomingChat.pending);
  }

  function applyIncomingUnreadIncrement({
    chats,
    chatId,
    nextUnreadCountFn,
    activeChatId = null,
    hidden = false,
    renderTraceLog = null,
  } = {}) {
    const key = normalizeChatId(chatId);
    if (!key || !chats?.has?.(key)) {
      return {
        chatId: key || 0,
        beforeUnread: 0,
        afterUnread: 0,
        incremented: false,
      };
    }
    const chat = chats.get(key);
    const beforeUnread = Math.max(0, Number(chat?.unread_count || 0));
    if (typeof nextUnreadCountFn === 'function') {
      chat.unread_count = nextUnreadCountFn({
        currentUnreadCount: chat.unread_count,
        targetChatId: key,
        activeChatId,
        hidden: Boolean(hidden),
      });
    }
    const afterUnread = Math.max(0, Number(chat?.unread_count || 0));
    const result = {
      chatId: key,
      beforeUnread,
      afterUnread,
      incremented: afterUnread > beforeUnread,
    };
    renderTraceLog?.('unread-increment', {
      ...result,
      activeChatId: normalizeChatId(activeChatId) || 0,
      hidden: Boolean(hidden),
    });
    return result;
  }

  function createUnreadStateController(deps) {
    const {
      chats,
      upsertChat,
      getActiveChatId,
      hasReachedNewestUnreadMessageBottom,
    } = deps;

    const optimisticUnreadClears = new Map();

    function getCurrentUnreadCount(chatId) {
      const key = normalizeChatId(chatId);
      const optimisticUnread = optimisticUnreadClears.get(key);
      if (Number.isFinite(optimisticUnread)) {
        return Math.max(0, Number(optimisticUnread));
      }
      return Math.max(0, Number(chats.get(key)?.unread_count || 0));
    }

    function clearUnreadCount(chatId) {
      const key = normalizeChatId(chatId);
      const chat = chats.get(key);
      if (!chat) return;
      const unread = Math.max(0, Number(chat.unread_count || 0));
      if (!optimisticUnreadClears.has(key)) {
        optimisticUnreadClears.set(key, unread);
      }
      chat.unread_count = 0;
    }

    function restoreUnreadCount(chatId) {
      const key = normalizeChatId(chatId);
      const chat = chats.get(key);
      const previousUnread = optimisticUnreadClears.get(key);
      optimisticUnreadClears.delete(key);
      if (!chat || !Number.isFinite(previousUnread)) return;
      chat.unread_count = Math.max(0, Number(previousUnread));
    }

    function finalizeUnreadClear(chatId) {
      const key = normalizeChatId(chatId);
      optimisticUnreadClears.delete(key);
    }

    function buildChatPreservingUnread(chat, { preserveActivationUnread = false } = {}) {
      return resolvePreservedUnreadState({
        chat,
        chats,
        getActiveChatId,
        hasReachedNewestUnreadMessageBottom,
        preserveActivationUnread,
      });
    }

    function upsertChatPreservingUnread(chat, options = {}) {
      return upsertChat(buildChatPreservingUnread(chat, options));
    }

    return {
      getCurrentUnreadCount,
      clearUnreadCount,
      restoreUnreadCount,
      finalizeUnreadClear,
      buildChatPreservingUnread,
      upsertChatPreservingUnread,
    };
  }

  function createUnreadAnchorController({ chats, isNearBottomFn, messagesContainer }) {
    function getUnreadAnchorMessageId(chatId) {
      const key = normalizeChatId(chatId);
      return Math.max(0, Number(chats.get(key)?.newest_unread_message_id || 0));
    }

    function getMessageBottomOffset(node, container) {
      if (!node || !container) return null;

      const offsetTop = Number(node?.offsetTop);
      const offsetHeight = Number(node?.offsetHeight);
      if (Number.isFinite(offsetTop) && Number.isFinite(offsetHeight)) {
        return Math.max(0, offsetTop + offsetHeight);
      }

      const nodeBottom = Number(node?.dataset?.bottomOffset || node?.bottomOffset);
      if (Number.isFinite(nodeBottom)) {
        return Math.max(0, nodeBottom);
      }

      const containerRect = container?.getBoundingClientRect?.();
      const nodeRect = node?.getBoundingClientRect?.();
      const scrollTop = Number(container?.scrollTop);
      const containerTop = Number(containerRect?.top);
      const nodeRectBottom = Number(nodeRect?.bottom);
      if (Number.isFinite(scrollTop) && Number.isFinite(containerTop) && Number.isFinite(nodeRectBottom)) {
        return Math.max(0, scrollTop + (nodeRectBottom - containerTop));
      }

      return null;
    }

    function findNewestUnreadMessageNode(chatId) {
      const container = messagesContainer;
      if (!container || typeof container.querySelectorAll !== 'function') {
        return { node: null, anchorMessageId: getUnreadAnchorMessageId(chatId) };
      }
      const assistantNodes = container.querySelectorAll('.message[data-role="assistant"]:not(.message--pending), .message[data-role="hermes"]:not(.message--pending)');
      const anchorMessageId = getUnreadAnchorMessageId(chatId);
      if (anchorMessageId > 0) {
        for (let index = assistantNodes.length - 1; index >= 0; index -= 1) {
          const candidate = assistantNodes[index];
          if (Number(candidate?.dataset?.messageId || 0) === anchorMessageId) {
            return { node: candidate, anchorMessageId };
          }
        }
        return { node: null, anchorMessageId };
      }
      return {
        node: assistantNodes?.[assistantNodes.length - 1] || null,
        anchorMessageId,
      };
    }

    function hasReachedNewestUnreadMessageBottom(chatId, { tolerance = 40 } = {}) {
      const key = normalizeChatId(chatId);
      const unread = Math.max(0, Number(chats.get(key)?.unread_count || 0));
      if (unread <= 0) return true;
      const container = messagesContainer;
      if (!container || typeof container.querySelectorAll !== 'function') {
        return isNearBottomFn(messagesContainer, tolerance);
      }

      const { node: newestUnreadNode, anchorMessageId } = findNewestUnreadMessageNode(key);
      if (!newestUnreadNode) {
        if (anchorMessageId > 0) {
          return false;
        }
        return isNearBottomFn(messagesContainer, tolerance);
      }

      const viewportBottom = Number(container.scrollTop) + Number(container.clientHeight || container.offsetHeight || 0);
      const messageBottom = getMessageBottomOffset(newestUnreadNode, container);
      if (!Number.isFinite(viewportBottom) || !Number.isFinite(messageBottom)) {
        return isNearBottomFn(messagesContainer, tolerance);
      }
      return viewportBottom + tolerance >= messageBottom;
    }

    return {
      getUnreadAnchorMessageId,
      hasReachedNewestUnreadMessageBottom,
    };
  }

  function createActivationReadThresholdController({ chats }, anchorController) {
    const activationReadThresholdState = new Map();
    const {
      getUnreadAnchorMessageId,
      hasReachedNewestUnreadMessageBottom,
    } = anchorController;

    function clearActivationReadThreshold(chatId) {
      activationReadThresholdState.delete(normalizeChatId(chatId));
    }

    function armActivationReadThreshold(chatId, unreadCount = null) {
      const key = normalizeChatId(chatId);
      if (!key) return;
      const unread = unreadCount == null
        ? Math.max(0, Number(chats.get(key)?.unread_count || 0))
        : Math.max(0, Number(unreadCount || 0));
      if (unread > 0) {
        const reachedBottomAtActivation = hasReachedNewestUnreadMessageBottom(key, { tolerance: 40 });
        activationReadThresholdState.set(key, {
          anchorMessageId: getUnreadAnchorMessageId(key),
          hasBeenAboveThreshold: !reachedBottomAtActivation,
        });
        return;
      }
      clearActivationReadThreshold(key);
    }

    function ensureActivationReadThreshold(chatId, unreadCount = null) {
      const key = normalizeChatId(chatId);
      if (!key) return false;
      const unread = unreadCount == null
        ? Math.max(0, Number(chats.get(key)?.unread_count || 0))
        : Math.max(0, Number(unreadCount || 0));
      if (unread <= 0) {
        clearActivationReadThreshold(key);
        return false;
      }
      const anchorMessageId = getUnreadAnchorMessageId(key);
      const existing = activationReadThresholdState.get(key);
      if (existing && Number(existing.anchorMessageId || 0) === anchorMessageId) {
        return true;
      }
      const reachedBottomAtActivation = hasReachedNewestUnreadMessageBottom(key, { tolerance: 40 });
      activationReadThresholdState.set(key, {
        anchorMessageId,
        hasBeenAboveThreshold: !reachedBottomAtActivation,
      });
      return true;
    }

    function hasSatisfiedActivationReadThreshold(chatId, { reachedBottom = false, force = false } = {}) {
      const key = normalizeChatId(chatId);
      const state = activationReadThresholdState.get(key);
      if (!state) return true;
      if (force) {
        clearActivationReadThreshold(key);
        return true;
      }
      const currentAnchorMessageId = getUnreadAnchorMessageId(key);
      if (Number(state.anchorMessageId || 0) !== currentAnchorMessageId) {
        const reachedBottomAtActivation = hasReachedNewestUnreadMessageBottom(key, { tolerance: 40 });
        activationReadThresholdState.set(key, {
          anchorMessageId: currentAnchorMessageId,
          hasBeenAboveThreshold: !reachedBottomAtActivation,
        });
        return false;
      }
      if (!reachedBottom) {
        state.hasBeenAboveThreshold = true;
        return false;
      }
      if (!state.hasBeenAboveThreshold) {
        return false;
      }
      clearActivationReadThreshold(key);
      return true;
    }

    return {
      clearActivationReadThreshold,
      armActivationReadThreshold,
      ensureActivationReadThreshold,
      hasSatisfiedActivationReadThreshold,
      hasActivationReadThreshold(chatId) {
        return activationReadThresholdState.has(normalizeChatId(chatId));
      },
    };
  }

  function createReadThresholdController(deps) {
    const {
      chats,
      isNearBottomFn,
      messagesContainer,
    } = deps;

    const anchorController = createUnreadAnchorController({
      chats,
      isNearBottomFn,
      messagesContainer,
    });
    const activationController = createActivationReadThresholdController({ chats }, anchorController);

    return {
      getUnreadAnchorMessageId: anchorController.getUnreadAnchorMessageId,
      hasReachedNewestUnreadMessageBottom: anchorController.hasReachedNewestUnreadMessageBottom,
      clearActivationReadThreshold: activationController.clearActivationReadThreshold,
      hasActivationReadThreshold: activationController.hasActivationReadThreshold,
      armActivationReadThreshold: activationController.armActivationReadThreshold,
      ensureActivationReadThreshold: activationController.ensureActivationReadThreshold,
      hasSatisfiedActivationReadThreshold: activationController.hasSatisfiedActivationReadThreshold,
    };
  }

  function createUnreadPreservationController({ chats, getActiveChatId }, unreadStateController, thresholdController) {
    function buildChatPreservingUnread(chat, { preserveActivationUnread = false } = {}) {
      return resolvePreservedUnreadState({
        chat,
        chats,
        getActiveChatId,
        hasReachedNewestUnreadMessageBottom: thresholdController.hasReachedNewestUnreadMessageBottom,
        preserveActivationUnread,
        hasActivationReadThreshold: thresholdController.hasActivationReadThreshold,
      });
    }

    function upsertChatPreservingUnread(chat, options = {}) {
      return unreadStateController.upsertChatPreservingUnread(buildChatPreservingUnread(chat, options), { preserveActivationUnread: false });
    }

    return {
      buildChatPreservingUnread,
      upsertChatPreservingUnread,
    };
  }


  function createReadRequestController(deps, unreadStateController, thresholdController) {
    const {
      apiPost,
      chats,
      getActiveChatId,
      getIsAuthenticated,
      unseenStreamChats,
      markReadInFlight,
      renderTabs,
      syncActivePendingStatus,
      updateComposerState,
      pendingChats,
      hasLiveStreamController,
      upsertChat,
    } = deps;
    const {
      getCurrentUnreadCount,
      clearUnreadCount,
      restoreUnreadCount,
      finalizeUnreadClear,
    } = unreadStateController;
    const {
      clearActivationReadThreshold,
      hasReachedNewestUnreadMessageBottom,
      hasSatisfiedActivationReadThreshold,
    } = thresholdController;

    const deferredMarkReadRetry = new Map();

    function isActiveChat(chatId) {
      return normalizeChatId(chatId) === normalizeChatId(getActiveChatId());
    }

    async function markRead(chatId) {
      const key = normalizeChatId(chatId);
      const data = await apiPost('/api/chats/mark-read', { chat_id: key });
      finalizeUnreadClear(key);
      clearActivationReadThreshold(key);
      const localChat = chats.get(key);
      const shouldPreservePending = Boolean(
        pendingChats.has(key)
        || localChat?.pending
        || hasLiveStreamController(key)
      );
      const nextChat = data?.chat && typeof data.chat === 'object'
        ? { ...data.chat }
        : data?.chat;
      if (shouldPreservePending && nextChat && typeof nextChat === 'object') {
        nextChat.pending = true;
      }
      upsertChat(nextChat);
      renderTabs();
      if (isActiveChat(key)) {
        syncActivePendingStatus();
        updateComposerState();
      }
    }

    function shouldMarkReadNow(chatId, { force = false, requireUnread = true } = {}) {
      const key = normalizeChatId(chatId);
      if (!key || !getIsAuthenticated() || !isActiveChat(key)) {
        return false;
      }
      if (!force) {
        if (unseenStreamChats.has(key)) return false;
        if (requireUnread) {
          const unread = getCurrentUnreadCount(key);
          if (unread <= 0) return false;
        }
        const reachedBottom = hasReachedNewestUnreadMessageBottom(key, { tolerance: 40 });
        if (!hasSatisfiedActivationReadThreshold(key, { reachedBottom, force: false })) return false;
        if (!reachedBottom) return false;
      }
      return true;
    }

    function rememberDeferredMarkRead(chatId, { force = false } = {}) {
      const key = normalizeChatId(chatId);
      const existing = deferredMarkReadRetry.get(key);
      deferredMarkReadRetry.set(key, { force: Boolean(existing?.force || force) });
    }

    function consumeDeferredMarkRead(chatId) {
      const key = normalizeChatId(chatId);
      const deferred = deferredMarkReadRetry.get(key) || null;
      deferredMarkReadRetry.delete(key);
      return deferred;
    }

    function startMarkReadRequest(chatId, { force = false } = {}) {
      const key = normalizeChatId(chatId);
      clearUnreadCount(key);
      renderTabs();
      if (isActiveChat(key)) {
        syncActivePendingStatus();
        updateComposerState();
      }
      markReadInFlight.add(key);
      void markRead(key)
        .catch(() => {
          restoreUnreadCount(key);
          renderTabs();
          if (isActiveChat(key)) {
            syncActivePendingStatus();
            updateComposerState();
          }
        })
        .finally(() => {
          markReadInFlight.delete(key);
          const deferred = consumeDeferredMarkRead(key);
          if (deferred && shouldMarkReadNow(key, { ...deferred, requireUnread: false })) {
            startMarkReadRequest(key, deferred);
          }
        });
    }

    function maybeMarkRead(chatId, { force = false } = {}) {
      const key = normalizeChatId(chatId);
      if (!shouldMarkReadNow(key, { force })) {
        return;
      }
      if (markReadInFlight.has(key)) {
        rememberDeferredMarkRead(key, { force });
        return;
      }
      startMarkReadRequest(key, { force });
    }

    return {
      markRead,
      maybeMarkRead,
      isActiveChat,
    };
  }

  function createReadSyncController(deps) {
    const {
      chats,
      upsertChat,
      getActiveChatId,
      getIsAuthenticated,
      isNearBottomFn,
      messagesContainer,
      unseenStreamChats,
      markReadInFlight,
      renderTabs,
      syncActivePendingStatus,
      updateComposerState,
      pendingChats,
      hasLiveStreamController,
    } = deps;

    const thresholdControllerRef = { current: null };
    const unreadStateController = createUnreadStateController({
      chats,
      upsertChat,
      getActiveChatId,
      hasReachedNewestUnreadMessageBottom: (...args) => thresholdControllerRef.current.hasReachedNewestUnreadMessageBottom(...args),
    });
    const thresholdController = createReadThresholdController({
      chats,
      isNearBottomFn,
      messagesContainer,
    }, unreadStateController);
    thresholdControllerRef.current = thresholdController;
    const requestController = createReadRequestController({
      apiPost: deps.apiPost,
      chats,
      getActiveChatId,
      getIsAuthenticated,
      unseenStreamChats,
      markReadInFlight,
      renderTabs,
      syncActivePendingStatus,
      updateComposerState,
      pendingChats,
      hasLiveStreamController,
      upsertChat,
    }, unreadStateController, thresholdController);
    const unreadPreservationController = createUnreadPreservationController({
      chats,
      getActiveChatId,
    }, unreadStateController, thresholdController);

    function buildChatPreservingUnread(chat, { preserveActivationUnread = false } = {}) {
      return unreadPreservationController.buildChatPreservingUnread(chat, { preserveActivationUnread });
    }

    function upsertChatPreservingUnread(chat, options = {}) {
      return upsertChat(buildChatPreservingUnread(chat, options));
    }

    function syncOpenActivationReadState(chatId, {
      unreadCount = null,
    } = {}) {
      thresholdController.armActivationReadThreshold(chatId, unreadCount);
      return true;
    }

    function syncBootstrapActivationReadState(chatId, {
      unreadCount = null,
    } = {}) {
      thresholdController.ensureActivationReadThreshold(chatId, unreadCount);
      return true;
    }

    function syncHydratedActiveReadState(chatId, {
      unreadCount = null,
      beforeMarkRead = null,
      forceMarkRead = false,
    } = {}) {
      thresholdController.ensureActivationReadThreshold(chatId, unreadCount);
      if (typeof beforeMarkRead === 'function') {
        beforeMarkRead();
      }
      requestController.maybeMarkRead(chatId, { force: forceMarkRead });
    }

    function syncActiveViewportReadState(chatId, {
      atBottom = false,
      forceMarkRead = false,
      onViewportBottom = null,
    } = {}) {
      const key = normalizeChatId(chatId);
      if (!key || !requestController.isActiveChat(key)) {
        return false;
      }
      if (atBottom) {
        unseenStreamChats.delete(key);
        if (typeof onViewportBottom === 'function') {
          onViewportBottom(key);
        }
      }
      requestController.maybeMarkRead(key, { force: forceMarkRead });
      return true;
    }

    function syncActiveStreamUnseenState(chatId, {
      atBottom = false,
      onBecameUnseen = null,
    } = {}) {
      const key = normalizeChatId(chatId);
      if (!key || !requestController.isActiveChat(key) || atBottom) {
        return false;
      }
      unseenStreamChats.add(key);
      if (typeof onBecameUnseen === 'function') {
        onBecameUnseen(key);
      }
      return true;
    }

    return {
      buildChatPreservingUnread,
      upsertChatPreservingUnread,
      getCurrentUnreadCount: unreadStateController.getCurrentUnreadCount,
      syncOpenActivationReadState,
      syncBootstrapActivationReadState,
      syncHydratedActiveReadState,
      syncActiveViewportReadState,
      syncActiveStreamUnseenState,
      markRead: requestController.markRead,
      maybeMarkRead: requestController.maybeMarkRead,
      hasLocalPendingWithoutLiveStream(chatId, history) {
        const key = normalizeChatId(chatId);
        if (!key || hasLiveStreamController(key)) {
          return false;
        }
        return deps.hasLocalPendingTranscript(history);
      },
      finalizeHydratedPendingState(chatId) {
        unreadStateController.finalizeUnreadClear(chatId);
        thresholdController.clearActivationReadThreshold(chatId);
      },
    };
  }

  const api = {
    normalizeChatId,
    resolvePreservedUnreadState,
    isIncomingChatLaggingLocalState,
    applyIncomingUnreadIncrement,
    createUnreadStateController,
    createUnreadAnchorController,
    createActivationReadThresholdController,
    createReadThresholdController,
    createUnreadPreservationController,
    createReadRequestController,
    createReadSyncController,
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  globalScope.HermesMiniappRuntimeReadState = api;
})(typeof window !== 'undefined' ? window : globalThis);
