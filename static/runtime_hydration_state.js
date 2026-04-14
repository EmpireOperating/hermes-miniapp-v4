(function initHermesMiniappRuntimeHydrationState(globalScope) {
  function createHistoryPendingStateController(deps) {
    const {
      histories,
      hasLiveStreamController,
      mergeHydratedHistory,
      restorePendingStreamSnapshot,
      hasFreshPendingStreamSnapshot,
      finalizeHydratedPendingState,
      hasLocalPendingWithoutLiveStream,
      hydratedCompletionMatchesVisibleLocalPending,
      historiesDiffer,
    } = deps;

    function derivePendingState(targetChatId, previousHistory, data) {
      const chatPending = Boolean(data.chat?.pending);
      const localPendingWithoutLiveStream = hasLocalPendingWithoutLiveStream(targetChatId, previousHistory);
      const hasFreshPendingSnapshot = typeof hasFreshPendingStreamSnapshot === 'function'
        ? Boolean(hasFreshPendingStreamSnapshot(targetChatId))
        : false;
      const snapshotPendingWithoutLiveStream = hasFreshPendingSnapshot && !hasLiveStreamController(targetChatId);
      const matchedVisibleHydratedCompletion = !chatPending
        && hydratedCompletionMatchesVisibleLocalPending(previousHistory, data.history || []);
      const preservePendingState = chatPending || ((localPendingWithoutLiveStream || snapshotPendingWithoutLiveStream) && !matchedVisibleHydratedCompletion);
      return {
        chatPending,
        localPendingWithoutLiveStream,
        snapshotPendingWithoutLiveStream,
        matchedVisibleHydratedCompletion,
        preservePendingState,
        shouldResumePending: preservePendingState && !hasLiveStreamController(targetChatId),
        shouldForceResumePending: !chatPending && snapshotPendingWithoutLiveStream,
      };
    }

    function applyHydratedHistory(targetChatId, previousHistory, nextHistory, preservePendingState) {
      histories.set(targetChatId, mergeHydratedHistory({
        previousHistory,
        nextHistory,
        chatPending: preservePendingState,
      }));
      if (!preservePendingState && typeof finalizeHydratedPendingState === 'function') {
        finalizeHydratedPendingState(targetChatId);
      }
      const restoredPendingSnapshot = preservePendingState && typeof restorePendingStreamSnapshot === 'function'
        ? Boolean(restorePendingStreamSnapshot(targetChatId))
        : false;
      const finalHistory = histories.get(targetChatId) || [];
      return {
        restoredPendingSnapshot,
        finalHistory,
        historyChanged: historiesDiffer(previousHistory, finalHistory),
      };
    }

    return {
      derivePendingState,
      applyHydratedHistory,
    };
  }

  function createHistoryRenderDecisionController(deps) {
    const {
      chats,
      getRenderedTranscriptSignature = null,
      describeActiveTranscriptRender,
    } = deps;

    function buildHydrationRenderState({
      targetChatId,
      previousHistory,
      finalHistory,
      hadCachedHistory,
      historyChanged,
      restoredPendingSnapshot,
    }) {
      const currentUnread = Math.max(0, Number(chats.get(targetChatId)?.unread_count || 0));
      const renderDecision = describeActiveTranscriptRender({
        previousHistory,
        incomingHistory: finalHistory,
        renderedTranscriptSignature: typeof getRenderedTranscriptSignature === 'function'
          ? String(getRenderedTranscriptSignature(targetChatId) || '')
          : '',
        restoredPendingSnapshot,
        historyChanged,
        hadCachedHistory,
        unreadCount: currentUnread,
      });
      return {
        currentUnread,
        ...renderDecision,
      };
    }

    return {
      buildHydrationRenderState,
    };
  }

  const api = {
    createHistoryPendingStateController,
    createHistoryRenderDecisionController,
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  globalScope.HermesMiniappRuntimeHydrationState = api;
})(typeof window !== 'undefined' ? window : globalThis);
