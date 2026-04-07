(function initHermesMiniappChatHistory(globalScope) {
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

    function setActiveChatMeta(chatId, { fullTabRender = true, deferNonCritical = false } = {}) {
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
        const node = template.content.firstElementChild.cloneNode(true);
        node.classList.add('message--system');
        node.querySelector('.message__role').textContent = 'system';
        node.querySelector('.message__time').textContent = nowStamp();
        renderBody(node.querySelector('.message__body'), 'No chats open. Start a new chat to continue.');
        messagesEl.appendChild(node);
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

      const finalizeMeta = () => {
        syncLiveToolStreamForChat(nextActiveChatId);
        syncActivePendingStatus();
        syncActiveLatencyChip();
        updateJumpLatestVisibility();
      };

      if (deferNonCritical) {
        scheduleTimeout(finalizeMeta, 0);
      } else {
        finalizeMeta();
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
      abortStreamController,
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
      finalizeHydratedPendingState,
    } = deps;

    const activeRenderState = {
      scheduled: false,
      chatId: null,
    };
    const deferredMarkReadRetry = new Map();
    const optimisticUnreadClears = new Map();
    const enqueueUiMutation = typeof runAfterUiMutation === 'function'
      ? runAfterUiMutation
      : (callback) => scheduleTimeout(callback, 0);

    function normalizeChatId(chatId) {
      return Number(chatId);
    }

    function isActiveChat(chatId) {
      return normalizeChatId(chatId) === normalizeChatId(getActiveChatId());
    }

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

    function latestAssistantLikeBody(history, { pending } = {}) {
      const entries = Array.isArray(history) ? history : [];
      for (let index = entries.length - 1; index >= 0; index -= 1) {
        const item = entries[index];
        const role = String(item?.role || '').toLowerCase();
        if (role !== 'assistant' && role !== 'hermes') continue;
        if (Boolean(item?.pending) !== Boolean(pending)) continue;
        const body = String(item?.body || '').trim();
        if (!body) continue;
        return body;
      }
      return '';
    }

    function hydratedCompletionMatchesVisibleLocalPending(previousHistory, nextHistory) {
      const pendingBody = latestAssistantLikeBody(previousHistory, { pending: true });
      if (!pendingBody) return false;
      const completedBody = latestAssistantLikeBody(nextHistory, { pending: false });
      if (!completedBody) return false;
      return completedBody === pendingBody;
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

    function historyRenderSignature(history) {
      const entries = Array.isArray(history) ? history : [];
      return entries.map((item, index) => {
        const fileRefs = Array.isArray(item?.file_refs) ? item.file_refs : [];
        const fileRefSignature = fileRefs
          .map((ref) => `${String(ref?.ref_id || '')}:${String(ref?.path || '')}:${String(ref?.label || '')}`)
          .join('|');
        return [
          index,
          String(item?.role || ''),
          String(item?.body || ''),
          item?.pending ? 'pending' : 'final',
          String(item?.created_at || ''),
          fileRefSignature,
        ].join('::');
      }).join('||');
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
      const matchedVisibleHydratedCompletion = !chatPending
        && hydratedCompletionMatchesVisibleLocalPending(previousHistory, data.history || []);
      const preservePendingState = chatPending || (localPendingWithoutLiveStream && !matchedVisibleHydratedCompletion);
      const shouldResumePending = preservePendingState && !hasLiveStreamController(targetChatId);
      const nextHistory = mergeHydratedHistory({
        previousHistory,
        nextHistory: data.history || [],
        chatPending: preservePendingState,
      });
      const historyChanged = historiesDiffer(previousHistory, nextHistory);
      histories.set(targetChatId, nextHistory);
      if (matchedVisibleHydratedCompletion && typeof finalizeHydratedPendingState === 'function') {
        finalizeHydratedPendingState(targetChatId);
      }
      if (preservePendingState && typeof restorePendingStreamSnapshot === 'function') {
        restorePendingStreamSnapshot(targetChatId);
      }

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
        const item = history[index];
        if (!item?.pending) continue;
        const role = String(item?.role || '').toLowerCase();
        if (role !== 'hermes' && role !== 'assistant') {
          continue;
        }
        pendingMessage = item;
        break;
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
      finalizeUnreadClear(key);
      upsertChat(data.chat);
      renderTabs();
      if (isActiveChat(key)) {
        syncActivePendingStatus();
        updateComposerState();
      }
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

    function hasReachedNewestUnreadMessageBottom(chatId, { tolerance = 40 } = {}) {
      const key = normalizeChatId(chatId);
      const unread = getCurrentUnreadCount(key);
      if (unread <= 0) return true;
      const container = messagesContainer;
      if (!container || typeof container.querySelectorAll !== 'function') {
        return isNearBottomFn(messagesContainer, tolerance);
      }

      const assistantNodes = container.querySelectorAll('.message[data-role="assistant"]:not(.message--pending), .message[data-role="hermes"]:not(.message--pending)');
      const newestUnreadNode = assistantNodes?.[assistantNodes.length - 1] || null;
      if (!newestUnreadNode) {
        return isNearBottomFn(messagesContainer, tolerance);
      }

      const viewportBottom = Number(container.scrollTop) + Number(container.clientHeight || container.offsetHeight || 0);
      const messageBottom = getMessageBottomOffset(newestUnreadNode, container);
      if (!Number.isFinite(viewportBottom) || !Number.isFinite(messageBottom)) {
        return isNearBottomFn(messagesContainer, tolerance);
      }
      return viewportBottom + tolerance >= messageBottom;
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
        if (!hasReachedNewestUnreadMessageBottom(key, { tolerance: 40 })) return false;
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
          // Best-effort read sync; retry on next visibility/scroll tick.
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

    function reconcilePendingStateFromStatus(statusChats = []) {
      const entries = Array.isArray(statusChats) ? statusChats : [];
      for (const chat of entries) {
        const key = normalizeChatId(chat?.id);
        if (!key) continue;
        if (Boolean(chat?.pending)) continue;
        if (hasLiveStreamController(key) && typeof abortStreamController === 'function') {
          abortStreamController(key);
        }
        if (typeof finalizeHydratedPendingState === 'function') {
          finalizeHydratedPendingState(key);
        }
      }
    }

    async function refreshChats() {
      const data = await apiPost('/api/chats/status', {});
      const statusChats = data.chats || [];
      syncChats(statusChats);
      reconcilePendingStateFromStatus(statusChats);
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
      const matchedVisibleHydratedCompletion = !chatPending
        && hydratedCompletionMatchesVisibleLocalPending(previousHistory, data.history || []);
      const preservePendingState = chatPending || (localPendingWithoutLiveStream && !matchedVisibleHydratedCompletion);
      const previousRenderSignature = historyRenderSignature(previousHistory);
      const nextHistory = mergeHydratedHistory({
        previousHistory,
        nextHistory: data.history || [],
        chatPending: preservePendingState,
      });
      histories.set(activeId, nextHistory);
      const nextRenderSignature = historyRenderSignature(nextHistory);
      const shouldRenderActiveHistory = previousRenderSignature !== nextRenderSignature;
      if (matchedVisibleHydratedCompletion && typeof finalizeHydratedPendingState === 'function') {
        finalizeHydratedPendingState(activeId);
      }
      if (preservePendingState && typeof restorePendingStreamSnapshot === 'function') {
        restorePendingStreamSnapshot(activeId);
      }
      upsertChat(data.chat);
      refreshTabNode(activeId);
      if (shouldRenderActiveHistory) {
        renderMessages(activeId, { preserveViewport: true });
      }

      const needsVisibilityResume = shouldResumeOnVisibilityChange({
        hidden: Boolean(hidden),
        activeChatId: activeId,
        pendingChats,
        streamAbortControllers,
      });
      const serverPendingWithoutLiveStream = chatPending && !hasLiveStreamController(activeId);
      if (!matchedVisibleHydratedCompletion && (needsVisibilityResume || serverPendingWithoutLiveStream || localPendingWithoutLiveStream)) {
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

  const api = { createController, createMetaController };
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  globalScope.HermesMiniappChatHistory = api;
})(typeof window !== 'undefined' ? window : globalThis);
