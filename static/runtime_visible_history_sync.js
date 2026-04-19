(function initHermesMiniappRuntimeVisibleHistorySync(globalScope) {
  function normalizeChatId(chatId) {
    return Number(chatId);
  }

  function createVisibilityResumeController({
    hasLiveStreamController,
    resumePendingChatStream,
    shouldResumeOnVisibilityChange,
  }) {
    function maybeResumeVisibilitySync({
      activeChatId,
      hidden = false,
      streamAbortControllers = new Map(),
      pendingChats,
      chatPending = false,
      localPendingWithoutLiveStream = false,
      localAssistantPendingWithoutLiveStream = false,
      snapshotPendingWithoutLiveStream = false,
      matchedVisibleHydratedCompletion = false,
    }) {
      const needsVisibilityResume = shouldResumeOnVisibilityChange({
        hidden: Boolean(hidden),
        activeChatId,
        pendingChats,
        streamAbortControllers,
      });
      const serverPendingWithoutLiveStream = chatPending && !hasLiveStreamController(activeChatId);
      const needsSnapshotResume = snapshotPendingWithoutLiveStream && !matchedVisibleHydratedCompletion;
      if (!matchedVisibleHydratedCompletion && (needsVisibilityResume || serverPendingWithoutLiveStream || localAssistantPendingWithoutLiveStream || needsSnapshotResume)) {
        const shouldForceResume = localAssistantPendingWithoutLiveStream || needsSnapshotResume;
        void resumePendingChatStream(activeChatId, shouldForceResume ? { force: true } : undefined);
      }
    }

    return {
      maybeResumeVisibilitySync,
    };
  }

  function createVisibleSyncController({
    histories,
    getActiveChatId,
    loadChatHistory,
    hydrationApplyController,
    renderDecisionController,
    refreshTabNode,
    renderMessages,
    maybeTriggerVisibleHydrationHaptic,
    syncHydratedActiveReadState,
    pendingChats,
    visibleSyncGenerationRef,
    visibilityResumeController,
  }) {
    async function syncVisibleActiveChat(options = {}) {
      const {
        hidden = false,
        streamAbortControllers = new Map(),
      } = options;
      const activeChatId = getActiveChatId();
      if (!activeChatId) return;

      const activeId = normalizeChatId(activeChatId);
      if (!activeId) return;
      const visibleRequestId = Number(visibleSyncGenerationRef.get()) + 1;
      visibleSyncGenerationRef.set(visibleRequestId);
      const activateVisibleChat = !hidden;

      let data = await loadChatHistory(activeId, { activate: activateVisibleChat });
      const latestActiveId = normalizeChatId(getActiveChatId());
      if (latestActiveId !== activeId || visibleRequestId !== Number(visibleSyncGenerationRef.get())) return;
      const previousHistory = histories.get(activeId) || [];
      let restoredPendingSnapshot;
      let finalHistory;
      let historyChanged;
      let pendingState;
      const hydrationState = await hydrationApplyController.applyHydratedServerState({
        targetChatId: activeId,
        previousHistory,
        data,
        requestId: visibleRequestId,
        retryEventName: 'visibility-unread-retry',
        retryActivate: activateVisibleChat,
      });
      ({
        data,
        restoredPendingSnapshot,
        finalHistory,
        historyChanged,
        pendingState,
      } = hydrationState);
      if (visibleRequestId !== Number(visibleSyncGenerationRef.get()) || normalizeChatId(getActiveChatId()) !== activeId) return;
      hydrationState.commitHydratedState?.();
      const chatPending = pendingState.chatPending;
      const localPendingWithoutLiveStream = pendingState.localPendingWithoutLiveStream;
      const localAssistantPendingWithoutLiveStream = pendingState.localAssistantPendingWithoutLiveStream;
      const snapshotPendingWithoutLiveStream = pendingState.snapshotPendingWithoutLiveStream;
      const matchedVisibleHydratedCompletion = pendingState.matchedVisibleHydratedCompletion;
      const renderState = renderDecisionController.buildHydrationRenderState({
        targetChatId: activeId,
        previousHistory,
        finalHistory,
        hadCachedHistory: true,
        historyChanged,
        restoredPendingSnapshot,
      });
      const {
        shouldRenderActiveHistory,
      } = renderState;
      refreshTabNode(activeId);
      if (shouldRenderActiveHistory) {
        renderMessages(activeId, {
          preserveViewport: true,
          suppressAutoStickAtBottom: true,
        });
      }
      syncHydratedActiveReadState(activeId, {
        unreadCount: data.chat?.unread_count,
        beforeMarkRead: () => {
          visibilityResumeController.maybeResumeVisibilitySync({
            activeChatId: activeId,
            hidden,
            streamAbortControllers,
            pendingChats,
            chatPending,
            localPendingWithoutLiveStream,
            localAssistantPendingWithoutLiveStream,
            snapshotPendingWithoutLiveStream,
            matchedVisibleHydratedCompletion,
          });
        },
      });
      maybeTriggerVisibleHydrationHaptic({
        targetChatId: activeId,
        hidden,
        previousHistory,
        finalHistory,
        chat: data.chat,
        shouldRenderActiveHistory,
      });
    }

    return {
      syncVisibleActiveChat,
    };
  }

  const api = {
    createVisibilityResumeController,
    createVisibleSyncController,
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  globalScope.HermesMiniappRuntimeVisibleHistorySync = api;
})(typeof window !== 'undefined' ? window : globalThis);
