(function initHermesMiniappRuntimeHydrationFlow(globalScope) {
  function createHydrationFlowController({
    nowMs,
    traceChatHistory,
    loadChatHistory,
    getLastOpenChatRequestId,
    getPreviousHistory,
    applyHydratedServerState,
    buildHydrationRenderState,
    refreshTabNode,
    isActiveChat,
    setActiveChatMeta,
    renderMessages,
    resumePendingChatStream,
  }) {
    async function hydrateChatFromServer(targetChatId, requestId, hadCachedHistory) {
      const hydrateStartedAtMs = nowMs();
      traceChatHistory('hydrate-start', {
        chatId: targetChatId,
        requestId: Number(requestId) || 0,
        hadCachedHistory: Boolean(hadCachedHistory),
        activeAtStart: isActiveChat(targetChatId),
      });
      let data = await loadChatHistory(targetChatId, { activate: true });

      if (requestId !== getLastOpenChatRequestId()) {
        traceChatHistory('hydrate-skipped-stale-request', {
          chatId: targetChatId,
          requestId: Number(requestId) || 0,
          latestRequestId: Number(getLastOpenChatRequestId()) || 0,
          hadCachedHistory: Boolean(hadCachedHistory),
          durationMs: Math.max(0, Math.round(nowMs() - hydrateStartedAtMs)),
        });
        return;
      }

      const previousHistory = getPreviousHistory(targetChatId) || [];
      let restoredPendingSnapshot;
      let finalHistory;
      let historyChanged;
      let pendingState;
      const hydrationState = await applyHydratedServerState({
        targetChatId,
        previousHistory,
        data,
        requestId,
        retryEventName: 'hydrate-unread-retry',
        retryActivate: false,
      });
      ({
        data,
        restoredPendingSnapshot,
        finalHistory,
        historyChanged,
        pendingState,
      } = hydrationState);
      if (requestId !== getLastOpenChatRequestId()) {
        traceChatHistory('hydrate-skipped-stale-post-apply', {
          chatId: targetChatId,
          requestId: Number(requestId) || 0,
          latestRequestId: Number(getLastOpenChatRequestId()) || 0,
          hadCachedHistory: Boolean(hadCachedHistory),
          durationMs: Math.max(0, Math.round(nowMs() - hydrateStartedAtMs)),
        });
        return;
      }
      hydrationState.commitHydratedState?.();
      const shouldResumePending = pendingState.shouldResumePending;
      const shouldForceResumePending = pendingState.shouldForceResumePending;

      refreshTabNode(targetChatId);
      const renderState = buildHydrationRenderState({
        targetChatId,
        previousHistory,
        finalHistory,
        hadCachedHistory,
        historyChanged,
        restoredPendingSnapshot,
      });
      const {
        shouldForceUnreadTranscriptRender,
        shouldForceStaleRenderedTranscriptRender,
        shouldRenderActiveHistory,
      } = renderState;

      traceChatHistory('hydrate-applied', {
        chatId: targetChatId,
        requestId: Number(requestId) || 0,
        hadCachedHistory: Boolean(hadCachedHistory),
        activeAtApply: isActiveChat(targetChatId),
        previousHistoryCount: previousHistory.length,
        nextHistoryCount: finalHistory.length,
        historyChanged,
        restoredPendingSnapshot: Boolean(restoredPendingSnapshot),
        shouldForceUnreadTranscriptRender,
        shouldForceStaleRenderedTranscriptRender,
        shouldResumePending: Boolean(shouldResumePending),
        durationMs: Math.max(0, Math.round(nowMs() - hydrateStartedAtMs)),
      });

      if (!isActiveChat(targetChatId)) {
        setActiveChatMeta(targetChatId);
        renderMessages(targetChatId);
        if (shouldResumePending) {
          void resumePendingChatStream(
            targetChatId,
            shouldForceResumePending ? { force: true } : undefined,
          );
        }
        return;
      }

      if (shouldRenderActiveHistory) {
        renderMessages(targetChatId, { preserveViewport: hadCachedHistory });
      }
      if (shouldResumePending) {
        void resumePendingChatStream(
          targetChatId,
          shouldForceResumePending ? { force: true } : undefined,
        );
      }
    }

    return {
      hydrateChatFromServer,
    };
  }

  const api = {
    createHydrationFlowController,
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  globalScope.HermesMiniappRuntimeHydrationFlow = api;
})(typeof window !== 'undefined' ? window : globalThis);
