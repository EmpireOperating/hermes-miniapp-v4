(function initHermesMiniappChatHistory(globalScope) {
  function createController(deps) {
    const {
      apiPost,
      histories,
      chats,
      prefetchingHistories,
      upsertChat,
      setActiveChatMeta,
      renderMessages,
      hasLiveStreamController,
      mergeHydratedHistory,
      refreshTabNode,
      getActiveChatId,
      resumePendingChatStream,
      appendSystemMessage,
      getLastOpenChatRequestId,
      setLastOpenChatRequestId,
      scheduleTimeout,
      requestIdle,
      runAfterUiMutation,
      getIsAuthenticated,
      isNearBottomFn,
      messagesContainer,
      unseenStreamChats,
      markReadInFlight,
      renderTabs,
      syncChats,
      syncPinnedChats,
      renderPinnedChats,
      syncActivePendingStatus,
      updateComposerState,
      pendingChats,
      shouldResumeOnVisibilityChange,
      restorePendingStreamSnapshot,
    } = deps;

    const activeRenderState = {
      scheduled: false,
      chatId: null,
    };
    const deferredMarkReadRetry = new Map();
    const enqueueUiMutation = typeof runAfterUiMutation === 'function'
      ? runAfterUiMutation
      : (callback) => scheduleTimeout(callback, 0);

    function normalizeChatId(chatId) {
      return Number(chatId);
    }

    function isActiveChat(chatId) {
      return normalizeChatId(chatId) === normalizeChatId(getActiveChatId());
    }

    function clearUnreadCount(chatId) {
      const key = normalizeChatId(chatId);
      if (!chats.has(key)) return;
      chats.get(key).unread_count = 0;
    }

    function hasLocalPendingWithoutLiveStream(chatId, history) {
      const key = normalizeChatId(chatId);
      if (!key || hasLiveStreamController(key)) {
        return false;
      }
      const previous = Array.isArray(history) ? history : [];
      return previous.some((item) => {
        if (!item?.pending) return false;
        const role = String(item?.role || '').toLowerCase();
        return role === 'tool' || role === 'hermes' || role === 'assistant';
      });
    }

    function historiesDiffer(currentHistory, incomingHistory) {
      const a = currentHistory || [];
      const b = incomingHistory || [];
      if (a.length !== b.length) return true;
      if (!a.length) return false;

      const aLast = a[a.length - 1] || {};
      const bLast = b[b.length - 1] || {};
      return aLast.id !== bLast.id || aLast.body !== bLast.body || aLast.role !== bLast.role;
    }

    async function loadChatHistory(chatId, { activate = true } = {}) {
      const targetChatId = normalizeChatId(chatId);
      try {
        return await apiPost('/api/chats/history', { chat_id: targetChatId, activate });
      } catch (error) {
        const message = String(error?.message || '');
        const isNotFound = /request failed:\s*404/i.test(message);
        if (!isNotFound) {
          throw error;
        }
        return apiPost('/api/chats/open', { chat_id: targetChatId });
      }
    }

    async function hydrateChatFromServer(targetChatId, requestId, hadCachedHistory) {
      const data = await loadChatHistory(targetChatId, { activate: true });
      upsertChat(data.chat);

      if (requestId !== getLastOpenChatRequestId()) {
        return;
      }

      const previousHistory = histories.get(targetChatId) || [];
      const chatPending = Boolean(data.chat?.pending);
      const localPendingWithoutLiveStream = hasLocalPendingWithoutLiveStream(targetChatId, previousHistory);
      const preservePendingState = chatPending || localPendingWithoutLiveStream;
      const shouldResumePending = preservePendingState && !hasLiveStreamController(targetChatId);
      const nextHistory = mergeHydratedHistory({
        previousHistory,
        nextHistory: data.history || [],
        chatPending: preservePendingState,
      });
      const historyChanged = historiesDiffer(previousHistory, nextHistory);
      histories.set(targetChatId, nextHistory);
      if (preservePendingState && typeof restorePendingStreamSnapshot === 'function') {
        restorePendingStreamSnapshot(targetChatId);
      }

      clearUnreadCount(targetChatId);
      refreshTabNode(targetChatId);

      if (!isActiveChat(targetChatId)) {
        setActiveChatMeta(targetChatId);
        renderMessages(targetChatId);
        if (shouldResumePending) {
          void resumePendingChatStream(targetChatId);
        }
        return;
      }

      if (!hadCachedHistory || historyChanged) {
        renderMessages(targetChatId, { preserveViewport: hadCachedHistory });
      }
      if (shouldResumePending) {
        void resumePendingChatStream(targetChatId);
      }
    }

    async function openChat(chatId) {
      const targetChatId = normalizeChatId(chatId);
      const requestId = getLastOpenChatRequestId() + 1;
      setLastOpenChatRequestId(requestId);
      const hadCachedHistory = histories.has(targetChatId);

      clearUnreadCount(targetChatId);

      if (hadCachedHistory) {
        setActiveChatMeta(targetChatId, { fullTabRender: false, deferNonCritical: true });
        renderMessages(targetChatId);

        scheduleTimeout(() => {
          void hydrateChatFromServer(targetChatId, requestId, true).catch(() => {
            // best-effort refresh while cached view is already visible
          });
        }, 0);
        return;
      }

      try {
        await hydrateChatFromServer(targetChatId, requestId, false);
      } catch (error) {
        if (requestId === getLastOpenChatRequestId()) {
          appendSystemMessage(error.message || 'Failed to open chat.');
        }
      }
    }

    function prefetchChatHistory(chatId) {
      const key = normalizeChatId(chatId);
      if (!key || histories.has(key) || prefetchingHistories.has(key)) {
        return;
      }
      prefetchingHistories.add(key);
      void loadChatHistory(key, { activate: false })
        .then((data) => {
          upsertChat(data.chat);
          histories.set(key, data.history || []);
        })
        .catch(() => {
          // Best-effort warm cache
        })
        .finally(() => {
          prefetchingHistories.delete(key);
        });
    }

    function warmChatHistoryCache() {
      const ids = [...chats.keys()].filter((id) => !isActiveChat(id));
      if (!ids.length) return;
      const warmNext = (index) => {
        if (index >= ids.length) return;
        prefetchChatHistory(ids[index]);
        scheduleTimeout(() => warmNext(index + 1), 160);
      };

      if (typeof requestIdle === 'function') {
        requestIdle(() => warmNext(0), { timeout: 1200 });
        return;
      }
      scheduleTimeout(() => warmNext(0), 120);
    }

    function addLocalMessage(chatId, message) {
      const key = normalizeChatId(chatId);
      const history = histories.get(key) || [];
      history.push(message);
      histories.set(key, history);
    }

    function updatePendingAssistant(chatId, nextBody, pendingState = true) {
      const key = normalizeChatId(chatId);
      const history = histories.get(key) || [];
      let pendingMessage = null;
      for (let index = history.length - 1; index >= 0; index -= 1) {
        if (history[index].pending && history[index].role === 'hermes') {
          pendingMessage = history[index];
          break;
        }
      }

      if (!pendingMessage) {
        const safeBody = String(nextBody || '').trim();
        if (!safeBody && !pendingState) {
          return;
        }
        history.push({
          role: 'hermes',
          body: nextBody,
          created_at: new Date().toISOString(),
          pending: pendingState,
        });
        histories.set(key, history);
        return;
      }

      pendingMessage.body = nextBody;
      pendingMessage.pending = pendingState;
      histories.set(key, history);
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

    async function markRead(chatId) {
      const key = normalizeChatId(chatId);
      const data = await apiPost('/api/chats/mark-read', { chat_id: key });
      upsertChat(data.chat);
      renderTabs();
      if (isActiveChat(key)) {
        syncActivePendingStatus();
        updateComposerState();
      }
    }

    function shouldMarkReadNow(chatId, { force = false } = {}) {
      const key = normalizeChatId(chatId);
      if (!key || !getIsAuthenticated() || !isActiveChat(key)) {
        return false;
      }
      if (!force) {
        if (!isNearBottomFn(messagesContainer, 40)) return false;
        if (unseenStreamChats.has(key)) return false;
        const unread = Number(chats.get(key)?.unread_count || 0);
        if (unread <= 0) return false;
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

    function maybeMarkRead(chatId, { force = false } = {}) {
      const key = normalizeChatId(chatId);
      if (!shouldMarkReadNow(key, { force })) {
        return;
      }
      if (markReadInFlight.has(key)) {
        rememberDeferredMarkRead(key, { force });
        return;
      }
      markReadInFlight.add(key);
      void markRead(key)
        .catch(() => {
          // Best-effort read sync; retry on next visibility/scroll tick.
        })
        .finally(() => {
          markReadInFlight.delete(key);
          const deferred = consumeDeferredMarkRead(key);
          if (deferred) {
            maybeMarkRead(key, deferred);
          }
        });
    }

    async function refreshChats() {
      const data = await apiPost('/api/chats/status', {});
      syncChats(data.chats || []);
      syncPinnedChats(data.pinned_chats || []);
      renderTabs();
      renderPinnedChats();
      syncActivePendingStatus();
      updateComposerState();
    }

    async function syncVisibleActiveChat(options = {}) {
      const {
        hidden = false,
        streamAbortControllers = new Map(),
      } = options;
      const activeChatId = getActiveChatId();
      if (!activeChatId) return;

      const activeId = normalizeChatId(activeChatId);
      if (!activeId) return;

      maybeMarkRead(activeId);
      const data = await loadChatHistory(activeId, { activate: true });
      const latestActiveId = normalizeChatId(getActiveChatId());
      if (latestActiveId !== activeId) return;
      const previousHistory = histories.get(activeId) || [];
      const localPendingWithoutLiveStream = hasLocalPendingWithoutLiveStream(activeId, previousHistory);

      const chatPending = Boolean(data.chat?.pending);
      const preservePendingState = chatPending || localPendingWithoutLiveStream;
      const nextHistory = mergeHydratedHistory({
        previousHistory,
        nextHistory: data.history || [],
        chatPending: preservePendingState,
      });
      histories.set(activeId, nextHistory);
      if (preservePendingState && typeof restorePendingStreamSnapshot === 'function') {
        restorePendingStreamSnapshot(activeId);
      }
      upsertChat(data.chat);
      renderMessages(activeId, { preserveViewport: true });

      const needsVisibilityResume = shouldResumeOnVisibilityChange({
        hidden: Boolean(hidden),
        activeChatId: activeId,
        pendingChats,
        streamAbortControllers,
      });
      const serverPendingWithoutLiveStream = chatPending && !hasLiveStreamController(activeId);
      if (needsVisibilityResume || serverPendingWithoutLiveStream || localPendingWithoutLiveStream) {
        void resumePendingChatStream(activeId, { force: localPendingWithoutLiveStream });
      }
    }

    return {
      historiesDiffer,
      loadChatHistory,
      hydrateChatFromServer,
      openChat,
      prefetchChatHistory,
      warmChatHistoryCache,
      addLocalMessage,
      updatePendingAssistant,
      syncActiveMessageView,
      scheduleActiveMessageView,
      markRead,
      maybeMarkRead,
      refreshChats,
      syncVisibleActiveChat,
    };
  }

  const api = { createController };
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  globalScope.HermesMiniappChatHistory = api;
})(typeof window !== 'undefined' ? window : globalThis);
