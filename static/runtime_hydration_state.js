(function initHermesMiniappRuntimeHydrationState(globalScope) {
  function createHistoryPendingStateController(deps) {
    const {
      histories,
      hasLiveStreamController,
      mergeHydratedHistory,
      restorePendingStreamSnapshot,
      hasFreshPendingStreamSnapshot,
      readPendingStreamSnapshotMap,
      mergePendingSnapshotIntoHistory,
      finalizeHydratedPendingState,
      hasLocalPendingWithoutLiveStream,
      hydratedCompletionMatchesVisibleLocalPending,
      hasVisibleAssistantLikeTranscript,
      historiesDiffer,
    } = deps;

    function hasPendingAssistantLikeTranscript(history) {
      const items = Array.isArray(history) ? history : [];
      return items.some((item) => {
        if (!item?.pending) return false;
        const role = String(item?.role || '').toLowerCase();
        if (role !== 'assistant' && role !== 'hermes') return false;
        return String(item?.body || '').trim().length > 0;
      });
    }

    function derivePendingState(targetChatId, previousHistory, data) {
      const serverPending = Boolean(data.chat?.pending);
      const localPendingWithoutLiveStream = hasLocalPendingWithoutLiveStream(targetChatId, previousHistory);
      const localAssistantPendingWithoutLiveStream = localPendingWithoutLiveStream
        && hasPendingAssistantLikeTranscript(previousHistory);
      const hasFreshPendingSnapshot = typeof hasFreshPendingStreamSnapshot === 'function'
        ? Boolean(hasFreshPendingStreamSnapshot(targetChatId))
        : false;
      const snapshotPendingWithoutLiveStream = hasFreshPendingSnapshot && !hasLiveStreamController(targetChatId);
      const matchedVisibleHydratedCompletion = !serverPending
        && hydratedCompletionMatchesVisibleLocalPending(previousHistory, data.history || []);
      const completedAssistantVisible = !serverPending
        && typeof hasVisibleAssistantLikeTranscript === 'function'
        && hasVisibleAssistantLikeTranscript(data.history || []);
      const preserveLocalPending = localPendingWithoutLiveStream
        && !matchedVisibleHydratedCompletion
        && (!completedAssistantVisible || localAssistantPendingWithoutLiveStream);
      const allowSnapshotRestore = snapshotPendingWithoutLiveStream
        && !matchedVisibleHydratedCompletion;
      const preservePendingState = serverPending || preserveLocalPending || allowSnapshotRestore;
      return {
        serverPending,
        chatPending: serverPending,
        localPendingWithoutLiveStream,
        localAssistantPendingWithoutLiveStream,
        snapshotPendingWithoutLiveStream,
        matchedVisibleHydratedCompletion,
        preserveLocalPending,
        allowSnapshotRestore,
        preservePendingState,
        shouldResumePending: preservePendingState && !hasLiveStreamController(targetChatId),
        shouldForceResumePending: !serverPending && allowSnapshotRestore,
      };
    }

    function normalizePreparedPendingState(pendingState) {
      const normalized = typeof pendingState === 'object' && pendingState !== null
        ? pendingState
        : {};
      return {
        serverPending: Boolean(normalized.serverPending ?? normalized.chatPending ?? pendingState),
        preserveLocalPending: Boolean(normalized.preserveLocalPending ?? pendingState),
        allowSnapshotRestore: Boolean(normalized.allowSnapshotRestore ?? pendingState),
      };
    }

    function getFreshPendingSnapshot(targetChatId) {
      if (typeof hasFreshPendingStreamSnapshot !== 'function' || !hasFreshPendingStreamSnapshot(targetChatId)) {
        return null;
      }
      if (typeof readPendingStreamSnapshotMap !== 'function') {
        return null;
      }
      const snapshotMap = readPendingStreamSnapshotMap();
      if (!snapshotMap || typeof snapshotMap !== 'object') {
        return null;
      }
      const snapshot = snapshotMap[String(targetChatId)];
      return snapshot && typeof snapshot === 'object' ? snapshot : null;
    }

    function restoreActiveBootstrapPendingState(targetChatId, {
      serverPending = false,
      onRestored = null,
    } = {}) {
      const key = Number(targetChatId) || 0;
      if (key <= 0) {
        return {
          localPendingSnapshot: false,
          restoredPendingSnapshot: false,
        };
      }
      const localPendingSnapshot = typeof hasFreshPendingStreamSnapshot === 'function'
        ? Boolean(hasFreshPendingStreamSnapshot(key))
        : false;
      const shouldAttemptRestore = (Boolean(serverPending) || localPendingSnapshot)
        && typeof restorePendingStreamSnapshot === 'function';
      const restoredPendingSnapshot = shouldAttemptRestore
        ? Boolean(restorePendingStreamSnapshot(key))
        : false;
      if (restoredPendingSnapshot && typeof onRestored === 'function') {
        onRestored(key);
      }
      return {
        localPendingSnapshot,
        restoredPendingSnapshot,
      };
    }

    function prepareHydratedHistory(targetChatId, previousHistory, nextHistory, pendingState) {
      const {
        serverPending,
        preserveLocalPending,
        allowSnapshotRestore,
      } = normalizePreparedPendingState(pendingState);
      const mergedHistory = mergeHydratedHistory({
        previousHistory,
        nextHistory,
        serverPending,
        preserveLocalPending,
      });
      let restoredPendingSnapshot = false;
      let finalHistory = mergedHistory;
      const snapshot = allowSnapshotRestore ? getFreshPendingSnapshot(targetChatId) : null;
      if (snapshot && typeof mergePendingSnapshotIntoHistory === 'function') {
        const mergedSnapshot = mergePendingSnapshotIntoHistory(mergedHistory, snapshot);
        if (mergedSnapshot?.changed) {
          restoredPendingSnapshot = true;
          finalHistory = Array.isArray(mergedSnapshot.history) ? mergedSnapshot.history : mergedHistory;
        }
      } else if ((allowSnapshotRestore || preserveLocalPending) && typeof mergePendingSnapshotIntoHistory !== 'function' && typeof restorePendingStreamSnapshot === 'function') {
        const hadExistingHistory = histories.has(targetChatId);
        const existingHistory = hadExistingHistory ? histories.get(targetChatId) : undefined;
        histories.set(targetChatId, mergedHistory);
        restoredPendingSnapshot = Boolean(restorePendingStreamSnapshot(targetChatId));
        finalHistory = restoredPendingSnapshot
          ? (histories.get(targetChatId) || mergedHistory)
          : mergedHistory;
        if (hadExistingHistory) {
          histories.set(targetChatId, existingHistory);
        } else {
          histories.delete(targetChatId);
        }
      }
      const shouldFinalizePending = !serverPending && !preserveLocalPending && !restoredPendingSnapshot;
      return {
        restoredPendingSnapshot,
        finalHistory,
        historyChanged: historiesDiffer(previousHistory, finalHistory),
        commitHydratedHistory() {
          histories.set(targetChatId, finalHistory);
          if (shouldFinalizePending && typeof finalizeHydratedPendingState === 'function') {
            finalizeHydratedPendingState(targetChatId);
          }
        },
      };
    }

    function applyHydratedHistory(targetChatId, previousHistory, nextHistory, pendingState) {
      const prepared = prepareHydratedHistory(targetChatId, previousHistory, nextHistory, pendingState);
      prepared.commitHydratedHistory();
      return {
        restoredPendingSnapshot: prepared.restoredPendingSnapshot,
        finalHistory: prepared.finalHistory,
        historyChanged: prepared.historyChanged,
      };
    }

    return {
      derivePendingState,
      restoreActiveBootstrapPendingState,
      prepareHydratedHistory,
      applyHydratedHistory,
    };
  }

  function createHistoryRenderDecisionController(deps) {
    const {
      chats,
      getRenderedTranscriptSignature = null,
      getRenderedChatId = null,
      isChatStuckToBottom = null,
      shouldVirtualizeHistory = null,
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
      const normalizedTargetChatId = Number(targetChatId) || 0;
      const currentUnread = Math.max(0, Number(chats.get(normalizedTargetChatId)?.unread_count || 0));
      const renderDecision = describeActiveTranscriptRender({
        previousHistory,
        incomingHistory: finalHistory,
        renderedTranscriptSignature: typeof getRenderedTranscriptSignature === 'function'
          ? String(getRenderedTranscriptSignature(normalizedTargetChatId) || '')
          : '',
        restoredPendingSnapshot,
        historyChanged,
        hadCachedHistory,
        unreadCount: currentUnread,
        isRenderedChatActiveTarget: typeof getRenderedChatId === 'function'
          && normalizedTargetChatId > 0
          && normalizedTargetChatId === (Number(getRenderedChatId()) || 0),
        isChatStuckToBottom: typeof isChatStuckToBottom === 'function'
          ? Boolean(isChatStuckToBottom(normalizedTargetChatId))
          : true,
        shouldVirtualizeIncomingHistory: typeof shouldVirtualizeHistory === 'function'
          ? Boolean(shouldVirtualizeHistory(Array.isArray(finalHistory) ? finalHistory.length : 0))
          : false,
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
