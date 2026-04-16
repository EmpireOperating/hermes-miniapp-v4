(function initHermesMiniappRuntimeHydrationApply(globalScope) {
  function createUnreadHydrationRetryController() {
    function historyContainsMessageId(history, messageId) {
      const targetId = Math.max(0, Number(messageId || 0));
      if (targetId <= 0 || !Array.isArray(history)) {
        return false;
      }
      return history.some((item) => Number(item?.id || 0) === targetId);
    }

    function shouldRetryUnreadHydrate({
      incomingUnreadAnchorMessageId,
      nextHistory,
      preservePendingState,
      restoredPendingSnapshot,
    }) {
      return !preservePendingState
        && !restoredPendingSnapshot
        && Math.max(0, Number(incomingUnreadAnchorMessageId || 0)) > 0
        && !historyContainsMessageId(nextHistory, incomingUnreadAnchorMessageId);
    }

    return {
      historyContainsMessageId,
      shouldRetryUnreadHydrate,
    };
  }

  function createHydrationApplyController(deps, pendingStateController, retryController) {
    const {
      loadChatHistory,
      buildChatPreservingUnread,
      upsertChatPreservingUnread,
      traceChatHistory,
    } = deps;

    async function applyHydratedServerState({
      targetChatId,
      previousHistory,
      data,
      requestId = 0,
      retryEventName = 'hydrate-unread-retry',
      retryActivate = false,
    }) {
      let nextData = data;
      let pendingState = pendingStateController.derivePendingState(targetChatId, previousHistory, nextData);
      let preservePendingState = pendingState.preservePendingState;
      let hydrationResult = typeof pendingStateController.prepareHydratedHistory === 'function'
        ? pendingStateController.prepareHydratedHistory(
          targetChatId,
          previousHistory,
          nextData.history || [],
          pendingState,
        )
        : pendingStateController.applyHydratedHistory(
          targetChatId,
          previousHistory,
          nextData.history || [],
          pendingState,
        );
      const incomingUnreadAnchorMessageId = Math.max(0, Number(nextData.chat?.newest_unread_message_id || 0));
      if (retryController.shouldRetryUnreadHydrate({
        incomingUnreadAnchorMessageId,
        nextHistory: hydrationResult.finalHistory,
        preservePendingState,
        restoredPendingSnapshot: hydrationResult.restoredPendingSnapshot,
      })) {
        traceChatHistory(retryEventName, {
          chatId: targetChatId,
          requestId: Number(requestId) || 0,
          incomingUnreadAnchorMessageId,
        });
        nextData = await loadChatHistory(targetChatId, { activate: Boolean(retryActivate) });
        pendingState = pendingStateController.derivePendingState(targetChatId, previousHistory, nextData);
        preservePendingState = pendingState.preservePendingState;
        hydrationResult = typeof pendingStateController.prepareHydratedHistory === 'function'
          ? pendingStateController.prepareHydratedHistory(
            targetChatId,
            previousHistory,
            nextData.history || [],
            pendingState,
          )
          : pendingStateController.applyHydratedHistory(
            targetChatId,
            previousHistory,
            nextData.history || [],
            pendingState,
          );
      }
      const preparedChat = typeof buildChatPreservingUnread === 'function'
        ? buildChatPreservingUnread(nextData.chat, { preserveActivationUnread: true })
        : nextData.chat;
      let committed = false;
      return {
        data: {
          ...nextData,
          chat: preparedChat,
        },
        pendingState,
        preservePendingState,
        ...hydrationResult,
        commitHydratedState() {
          if (committed) {
            return;
          }
          committed = true;
          hydrationResult.commitHydratedHistory?.();
          if (typeof upsertChatPreservingUnread === 'function') {
            upsertChatPreservingUnread(preparedChat, { preserveActivationUnread: true });
          }
        },
      };
    }

    return {
      applyHydratedServerState,
    };
  }

  const api = {
    createUnreadHydrationRetryController,
    createHydrationApplyController,
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  globalScope.HermesMiniappRuntimeHydrationApply = api;
})(typeof window !== 'undefined' ? window : globalThis);
