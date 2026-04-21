(function initHermesMiniappRuntimeOpenFlow(globalScope) {
  function createCachedOpenController(deps, hydrationController) {
    const {
      normalizeChatId,
      setActiveChatMeta,
      renderMessages,
      getActiveChatId,
      getLastOpenChatRequestId,
      scheduleTimeout,
      requestIdle,
      enqueueUiMutation,
      shouldDeferNonCriticalCachedOpen,
      shouldUseIdleForDeferredCachedHydration = () => true,
      prioritizedCachedRenderFallbackDelayMs = 24,
      traceChatHistory,
      nowMs,
      isActiveChat,
      chats,
    } = deps;

    function shouldPrioritizeCachedHydration(chatId) {
      const key = normalizeChatId(chatId);
      if (!key) return false;
      const chat = chats?.get?.(key) || null;
      if (!chat || typeof chat !== 'object') return false;
      return Math.max(0, Number(chat.unread_count || 0)) > 0
        || Math.max(0, Number(chat.newest_unread_message_id || 0)) > 0
        || Boolean(chat.pending);
    }

    function renderCachedChat({ targetChatId, requestId, openStartedAtMs, shouldDeferMeta }) {
      if (requestId !== getLastOpenChatRequestId()) {
        traceChatHistory('cached-render-skipped-stale-request', {
          chatId: targetChatId,
          requestId,
          latestRequestId: Number(getLastOpenChatRequestId()) || 0,
        });
        return;
      }
      if (!isActiveChat(targetChatId)) {
        traceChatHistory('cached-render-skipped-inactive', {
          chatId: targetChatId,
          requestId,
          activeChatId: normalizeChatId(getActiveChatId()),
        });
        return;
      }
      traceChatHistory('cached-render-commit', {
        chatId: targetChatId,
        requestId,
        deferred: shouldDeferMeta,
        durationMs: Math.max(0, Math.round(nowMs() - openStartedAtMs)),
      });
      renderMessages(targetChatId);
    }

    function hydrateCachedChat({ targetChatId, requestId, openStartedAtMs }) {
      if (requestId !== getLastOpenChatRequestId()) {
        traceChatHistory('cached-hydrate-skipped-stale-request', {
          chatId: targetChatId,
          requestId,
          latestRequestId: Number(getLastOpenChatRequestId()) || 0,
        });
        return Promise.resolve();
      }
      if (!isActiveChat(targetChatId)) {
        traceChatHistory('cached-hydrate-skipped-inactive', {
          chatId: targetChatId,
          requestId,
          activeChatId: normalizeChatId(getActiveChatId()),
        });
        return Promise.resolve();
      }
      traceChatHistory('cached-hydrate-begin', {
        chatId: targetChatId,
        requestId,
        durationMs: Math.max(0, Math.round(nowMs() - openStartedAtMs)),
      });
      return hydrationController.hydrateChatFromServer(targetChatId, requestId, true).catch(() => {
      });
    }

    function openCachedChat(targetChatId, requestId, openStartedAtMs) {
      const shouldDeferMeta = Boolean(shouldDeferNonCriticalCachedOpen(targetChatId));
      const prioritizeHydration = shouldPrioritizeCachedHydration(targetChatId);
      let hydrationSettled = false;
      setActiveChatMeta(targetChatId, { fullTabRender: false, deferNonCritical: shouldDeferMeta });
      const renderCached = () => {
        if (shouldDeferMeta && hydrationSettled) {
          traceChatHistory('cached-render-skipped-hydrate-settled', {
            chatId: targetChatId,
            requestId,
            prioritizeHydration,
            durationMs: Math.max(0, Math.round(nowMs() - openStartedAtMs)),
          });
          return;
        }
        renderCachedChat({ targetChatId, requestId, openStartedAtMs, shouldDeferMeta });
      };
      const renderFallbackDelayMs = prioritizeHydration && shouldDeferMeta
        ? Math.max(0, Number(prioritizedCachedRenderFallbackDelayMs) || 0)
        : 0;
      if (renderFallbackDelayMs > 0) {
        traceChatHistory('cached-render-scheduled', {
          chatId: targetChatId,
          requestId,
          mode: 'timeout',
          delayMs: renderFallbackDelayMs,
          prioritizeHydration,
        });
        scheduleTimeout(renderCached, renderFallbackDelayMs);
      } else if (shouldDeferMeta) {
        enqueueUiMutation(renderCached);
      } else {
        renderCached();
      }

      const hydrate = () => {
        const hydrationPromise = hydrateCachedChat({ targetChatId, requestId, openStartedAtMs });
        if (hydrationPromise && typeof hydrationPromise.finally === 'function') {
          return hydrationPromise.finally(() => {
            hydrationSettled = true;
          });
        }
        hydrationSettled = true;
        return hydrationPromise;
      };
      const allowIdleHydration = Boolean(shouldUseIdleForDeferredCachedHydration(targetChatId));
      const delayMs = prioritizeHydration ? 0 : (shouldDeferMeta ? 0 : 0);
      traceChatHistory('cached-hydrate-scheduled', {
        chatId: targetChatId,
        requestId,
        mode: 'timeout',
        delayMs,
        prioritizeHydration,
        allowIdleHydration,
      });
      scheduleTimeout(hydrate, delayMs);
    }

    return {
      openCachedChat,
    };
  }

  function createHistoryOpenController(deps) {
    const {
      normalizeChatId,
      histories,
      getLastOpenChatRequestId,
      setLastOpenChatRequestId,
      nowMs,
      traceChatHistory,
      syncOpenActivationReadState,
      setActiveChatMeta,
      renderMessages,
      appendSystemMessage,
      fetchController,
      hydrationController,
      cachedOpenController,
      statusController,
    } = deps;

    async function openChat(chatId, { suppressColdOpenRender = false, suppressFailureSystemMessage = false } = {}) {
      const targetChatId = normalizeChatId(chatId);
      const requestId = getLastOpenChatRequestId() + 1;
      setLastOpenChatRequestId(requestId);
      const hadCachedHistory = histories.has(targetChatId);
      const openStartedAtMs = nowMs();
      traceChatHistory('open-start', {
        chatId: targetChatId,
        requestId,
        hadCachedHistory,
        suppressColdOpenRender: Boolean(suppressColdOpenRender),
        suppressFailureSystemMessage: Boolean(suppressFailureSystemMessage),
      });
      syncOpenActivationReadState(targetChatId);

      if (hadCachedHistory) {
        cachedOpenController.openCachedChat(targetChatId, requestId, openStartedAtMs);
        return;
      }

      setActiveChatMeta(targetChatId, { fullTabRender: false, deferNonCritical: true });
      if (!suppressColdOpenRender) {
        renderMessages(targetChatId);
      }

      try {
        await hydrationController.hydrateChatFromServer(targetChatId, requestId, false);
      } catch (error) {
        traceChatHistory('open-failed', {
          chatId: targetChatId,
          requestId,
          durationMs: Math.max(0, Math.round(nowMs() - openStartedAtMs)),
          message: String(error?.message || ''),
        });
        if (requestId === getLastOpenChatRequestId() && !suppressFailureSystemMessage) {
          appendSystemMessage(error.message || 'Failed to open chat.', targetChatId);
        }
      }
    }

    return {
      loadChatHistory: fetchController.loadChatHistory,
      hydrateChatFromServer: hydrationController.hydrateChatFromServer,
      openChat,
      prefetchChatHistory: fetchController.prefetchChatHistory,
      warmChatHistoryCache: fetchController.warmChatHistoryCache,
      refreshChats: statusController.refreshChats,
      syncVisibleActiveChat: hydrationController.syncVisibleActiveChat,
    };
  }

  const api = {
    createCachedOpenController,
    createHistoryOpenController,
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  globalScope.HermesMiniappRuntimeOpenFlow = api;
})(typeof window !== 'undefined' ? window : globalThis);
