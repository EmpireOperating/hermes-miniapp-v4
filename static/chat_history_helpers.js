(function initHermesMiniappChatHistory(globalScope) {
  function resolveTranscriptAuthorityHelpers() {
    if (globalScope.HermesMiniappRuntimeTranscriptAuthority) {
      return globalScope.HermesMiniappRuntimeTranscriptAuthority;
    }
    if (typeof module !== 'undefined' && module.exports && typeof require === 'function') {
      try {
        return require('./runtime_transcript_authority.js');
      } catch {
        return null;
      }
    }
    return null;
  }

  const transcriptAuthority = resolveTranscriptAuthorityHelpers();
  if (!transcriptAuthority) {
    throw new Error('HermesMiniappRuntimeTranscriptAuthority is required before chat_history_helpers.js');
  }

  function resolveAttentionEffectsHelpers() {
    if (globalScope.HermesMiniappRuntimeAttentionEffects) {
      return globalScope.HermesMiniappRuntimeAttentionEffects;
    }
    if (typeof module !== 'undefined' && module.exports && typeof require === 'function') {
      try {
        return require('./runtime_attention_effects.js');
      } catch {
        return null;
      }
    }
    return null;
  }

  const attentionEffects = resolveAttentionEffectsHelpers();
  if (!attentionEffects) {
    throw new Error('HermesMiniappRuntimeAttentionEffects is required before chat_history_helpers.js');
  }

  function resolveReadStateHelpers() {
    if (globalScope.HermesMiniappRuntimeReadState) {
      return globalScope.HermesMiniappRuntimeReadState;
    }
    if (typeof module !== 'undefined' && module.exports && typeof require === 'function') {
      try {
        return require('./runtime_read_state.js');
      } catch {
        return null;
      }
    }
    return null;
  }

  const readState = resolveReadStateHelpers();
  if (!readState) {
    throw new Error('HermesMiniappRuntimeReadState is required before chat_history_helpers.js');
  }

  function resolveChatHistorySyncHelpers() {
    if (globalScope.HermesMiniappRuntimeChatHistorySync) {
      return globalScope.HermesMiniappRuntimeChatHistorySync;
    }
    if (typeof module !== 'undefined' && module.exports && typeof require === 'function') {
      try {
        return require('./runtime_chat_history_sync.js');
      } catch {
        return null;
      }
    }
    return null;
  }

  const chatHistorySync = resolveChatHistorySyncHelpers();
  if (!chatHistorySync) {
    throw new Error('HermesMiniappRuntimeChatHistorySync is required before chat_history_helpers.js');
  }

  function resolveVisibleHistorySyncHelpers() {
    if (globalScope.HermesMiniappRuntimeVisibleHistorySync) {
      return globalScope.HermesMiniappRuntimeVisibleHistorySync;
    }
    if (typeof module !== 'undefined' && module.exports && typeof require === 'function') {
      try {
        return require('./runtime_visible_history_sync.js');
      } catch {
        return null;
      }
    }
    return null;
  }

  const visibleHistorySync = resolveVisibleHistorySyncHelpers();
  if (!visibleHistorySync) {
    throw new Error('HermesMiniappRuntimeVisibleHistorySync is required before chat_history_helpers.js');
  }

  function resolveHydrationApplyHelpers() {
    if (globalScope.HermesMiniappRuntimeHydrationApply) {
      return globalScope.HermesMiniappRuntimeHydrationApply;
    }
    if (typeof module !== 'undefined' && module.exports && typeof require === 'function') {
      try {
        return require('./runtime_hydration_apply.js');
      } catch {
        return null;
      }
    }
    return null;
  }

  const hydrationApplyHelpers = resolveHydrationApplyHelpers();
  if (!hydrationApplyHelpers) {
    throw new Error('HermesMiniappRuntimeHydrationApply is required before chat_history_helpers.js');
  }

  function resolveHydrationStateHelpers() {
    if (globalScope.HermesMiniappRuntimeHydrationState) {
      return globalScope.HermesMiniappRuntimeHydrationState;
    }
    if (typeof module !== 'undefined' && module.exports && typeof require === 'function') {
      try {
        return require('./runtime_hydration_state.js');
      } catch {
        return null;
      }
    }
    return null;
  }

  const hydrationStateHelpers = resolveHydrationStateHelpers();
  if (!hydrationStateHelpers) {
    throw new Error('HermesMiniappRuntimeHydrationState is required before chat_history_helpers.js');
  }

  function resolveVisibleHydrationHelpers() {
    if (globalScope.HermesMiniappRuntimeVisibleHydration) {
      return globalScope.HermesMiniappRuntimeVisibleHydration;
    }
    if (typeof module !== 'undefined' && module.exports && typeof require === 'function') {
      try {
        return require('./runtime_visible_hydration.js');
      } catch {
        return null;
      }
    }
    return null;
  }

  const visibleHydrationHelpers = resolveVisibleHydrationHelpers();
  if (!visibleHydrationHelpers) {
    throw new Error('HermesMiniappRuntimeVisibleHydration is required before chat_history_helpers.js');
  }

  function resolveHydrationFlowHelpers() {
    if (globalScope.HermesMiniappRuntimeHydrationFlow) {
      return globalScope.HermesMiniappRuntimeHydrationFlow;
    }
    if (typeof module !== 'undefined' && module.exports && typeof require === 'function') {
      try {
        return require('./runtime_hydration_flow.js');
      } catch {
        return null;
      }
    }
    return null;
  }

  const hydrationFlowHelpers = resolveHydrationFlowHelpers();
  if (!hydrationFlowHelpers) {
    throw new Error('HermesMiniappRuntimeHydrationFlow is required before chat_history_helpers.js');
  }

  function resolveOpenFlowHelpers() {
    if (globalScope.HermesMiniappRuntimeOpenFlow) {
      return globalScope.HermesMiniappRuntimeOpenFlow;
    }
    if (typeof module !== 'undefined' && module.exports && typeof require === 'function') {
      try {
        return require('./runtime_open_flow.js');
      } catch {
        return null;
      }
    }
    return null;
  }

  const openFlowHelpers = resolveOpenFlowHelpers();
  if (!openFlowHelpers) {
    throw new Error('HermesMiniappRuntimeOpenFlow is required before chat_history_helpers.js');
  }

  function resolveChatMetaHelpers() {
    if (globalScope.HermesMiniappRuntimeChatMeta) {
      return globalScope.HermesMiniappRuntimeChatMeta;
    }
    if (typeof module !== 'undefined' && module.exports && typeof require === 'function') {
      try {
        return require('./runtime_chat_meta.js');
      } catch {
        return null;
      }
    }
    return null;
  }

  const chatMetaHelpers = resolveChatMetaHelpers();
  if (!chatMetaHelpers) {
    throw new Error('HermesMiniappRuntimeChatMeta is required before chat_history_helpers.js');
  }

  function resolveLocalMutationHelpers() {
    if (globalScope.HermesMiniappRuntimeLocalMutation) {
      return globalScope.HermesMiniappRuntimeLocalMutation;
    }
    if (typeof module !== 'undefined' && module.exports && typeof require === 'function') {
      try {
        return require('./runtime_local_mutation.js');
      } catch {
        return null;
      }
    }
    return null;
  }

  const localMutationHelpers = resolveLocalMutationHelpers();
  if (!localMutationHelpers) {
    throw new Error('HermesMiniappRuntimeLocalMutation is required before chat_history_helpers.js');
  }

  function createMetaController(deps) {
    return chatMetaHelpers.createMetaController(deps);
  }


  function normalizeChatId(chatId) {
    return Number(chatId);
  }

  const hasLocalPendingTranscript = transcriptAuthority.hasLocalPendingTranscript;
  const hydratedCompletionMatchesVisibleLocalPending = transcriptAuthority.hydratedCompletionMatchesVisibleLocalPending;
  const historiesDiffer = transcriptAuthority.historiesDiffer;
  const hasVisibleAssistantLikeTranscript = transcriptAuthority.hasVisibleAssistantLikeTranscript;
  const latestCompletedAssistantHydrationKey = transcriptAuthority.latestCompletedAssistantHydrationKey;
  const reconcilePendingAssistantUpdate = transcriptAuthority.reconcilePendingAssistantUpdate;

  function createUnreadStateController(deps) {
    return readState.createUnreadStateController(deps);
  }

  function createUnreadAnchorController(deps) {
    return readState.createUnreadAnchorController(deps);
  }

  function createActivationReadThresholdController(deps, anchorController) {
    return readState.createActivationReadThresholdController(deps, anchorController);
  }

  function createReadThresholdController(deps) {
    return readState.createReadThresholdController(deps);
  }

  function createReadRequestController(deps, unreadStateController, thresholdController) {
    return readState.createReadRequestController(deps, unreadStateController, thresholdController);
  }

  function createUnreadPreservationController(deps, unreadStateController, thresholdController) {
    return readState.createUnreadPreservationController(deps, unreadStateController, thresholdController);
  }

  function createReadSyncController(deps) {
    return readState.createReadSyncController({
      ...deps,
      hasLocalPendingTranscript,
    });
  }

  function createLocalMutationController(deps) {
    return localMutationHelpers.createLocalMutationController({
      ...deps,
      normalizeChatId,
      reconcilePendingAssistantUpdate,
    });
  }

  function createHistoryFetchController(deps) {
    return chatHistorySync.createHistoryFetchController(deps);
  }

  function createHistoryPendingStateController(deps) {
    return hydrationStateHelpers.createHistoryPendingStateController({
      ...deps,
      hydratedCompletionMatchesVisibleLocalPending,
      hasVisibleAssistantLikeTranscript,
      historiesDiffer,
    });
  }

  function createHistoryRenderDecisionController(deps) {
    return hydrationStateHelpers.createHistoryRenderDecisionController({
      ...deps,
      describeActiveTranscriptRender: transcriptAuthority.describeActiveTranscriptRender,
    });
  }

  function createUnreadHydrationRetryController() {
    return hydrationApplyHelpers.createUnreadHydrationRetryController();
  }

  function createHydrationApplyController(deps, pendingStateController, retryController) {
    return hydrationApplyHelpers.createHydrationApplyController(deps, pendingStateController, retryController);
  }

  function createVisibilityResumeController(deps) {
    return visibleHistorySync.createVisibilityResumeController(deps);
  }

  function createCachedOpenController(deps, hydrationController) {
    const {
      chats,
      setActiveChatMeta,
      renderMessages,
      getActiveChatId,
      getLastOpenChatRequestId,
      scheduleTimeout,
      requestIdle,
      enqueueUiMutation,
      shouldDeferNonCriticalCachedOpen,
      traceChatHistory,
      nowMs,
      isActiveChat,
    } = deps;

    return openFlowHelpers.createCachedOpenController({
      normalizeChatId,
      chats,
      setActiveChatMeta,
      renderMessages,
      getActiveChatId,
      getLastOpenChatRequestId,
      scheduleTimeout,
      requestIdle,
      enqueueUiMutation,
      shouldDeferNonCriticalCachedOpen,
      traceChatHistory,
      nowMs,
      isActiveChat,
    }, hydrationController);
  }

  function createHistoryHydrationController(deps) {
    const {
      loadChatHistory,
      histories,
      chats,
      hasLiveStreamController,
      mergeHydratedHistory,
      refreshTabNode,
      getActiveChatId,
      resumePendingChatStream,
      getLastOpenChatRequestId,
      setActiveChatMeta,
      renderMessages,
      pendingChats,
      shouldResumeOnVisibilityChange,
      restorePendingStreamSnapshot,
      hasFreshPendingStreamSnapshot,
      readPendingStreamSnapshotMap,
      mergePendingSnapshotIntoHistory,
      finalizeHydratedPendingState,
      traceChatHistory,
      nowMs,
      syncUnreadNotificationPresence,
      getDocumentVisibilityState = () => 'visible',
      buildChatPreservingUnread,
      upsertChatPreservingUnread,
      maybeMarkRead,
      syncHydratedActiveReadState,
      isActiveChat,
      hasLocalPendingWithoutLiveStream,
      getRenderedTranscriptSignature = null,
      triggerIncomingMessageHaptic = null,
    } = deps;

    const pendingStateController = createHistoryPendingStateController({
      histories,
      hasLiveStreamController,
      mergeHydratedHistory,
      restorePendingStreamSnapshot,
      hasFreshPendingStreamSnapshot,
      readPendingStreamSnapshotMap,
      mergePendingSnapshotIntoHistory,
      finalizeHydratedPendingState,
      hasLocalPendingWithoutLiveStream,
    });
    const renderDecisionController = createHistoryRenderDecisionController({
      chats,
      getRenderedTranscriptSignature,
    });
    const retryController = createUnreadHydrationRetryController();
    const hydrationApplyController = createHydrationApplyController({
      loadChatHistory,
      buildChatPreservingUnread,
      upsertChatPreservingUnread,
      traceChatHistory,
    }, pendingStateController, retryController);
    const visibilityResumeController = createVisibilityResumeController({
      hasLiveStreamController,
      resumePendingChatStream,
      shouldResumeOnVisibilityChange,
    });
    let visibleSyncGeneration = 0;
    const visibleHydrationEffectsController = visibleHydrationHelpers.createVisibleHydrationEffectsController({
      describeHydrationAttentionEffect: attentionEffects.describeHydrationAttentionEffect,
      executeAttentionEffect: attentionEffects.executeAttentionEffect,
      triggerIncomingMessageHaptic,
      traceChatHistory,
    });

    const hydrationFlowController = hydrationFlowHelpers.createHydrationFlowController({
      nowMs,
      traceChatHistory,
      loadChatHistory,
      getLastOpenChatRequestId,
      getPreviousHistory: (targetChatId) => histories.get(targetChatId) || [],
      applyHydratedServerState: hydrationApplyController.applyHydratedServerState,
      buildHydrationRenderState: renderDecisionController.buildHydrationRenderState,
      refreshTabNode,
      isActiveChat,
      setActiveChatMeta,
      renderMessages,
      resumePendingChatStream,
    });

    async function hydrateChatFromServer(targetChatId, requestId, hadCachedHistory) {
      return hydrationFlowController.hydrateChatFromServer(targetChatId, requestId, hadCachedHistory);
    }

    const visibleSyncGenerationRef = {
      get: () => visibleSyncGeneration,
      set: (value) => {
        visibleSyncGeneration = Number(value) || 0;
      },
    };
    const visibleSyncController = visibleHistorySync.createVisibleSyncController({
      histories,
      getActiveChatId,
      loadChatHistory,
      hydrationApplyController,
      renderDecisionController,
      refreshTabNode,
      renderMessages,
      maybeTriggerVisibleHydrationHaptic: visibleHydrationEffectsController.maybeTriggerVisibleHydrationHaptic,
      syncHydratedActiveReadState,
      pendingChats,
      visibleSyncGenerationRef,
      visibilityResumeController,
    });

    return {
      loadChatHistory,
      hydrateChatFromServer,
      syncVisibleActiveChat: visibleSyncController.syncVisibleActiveChat,
      restoreActiveBootstrapPendingState: pendingStateController.restoreActiveBootstrapPendingState,
    };
  }

  function createHistoryStatusController(deps) {
    return chatHistorySync.createHistoryStatusController(deps);
  }

  function createHistoryOpenController(deps) {
    const {
      histories,
      setActiveChatMeta,
      renderMessages,
      getActiveChatId,
      getLastOpenChatRequestId,
      setLastOpenChatRequestId,
      scheduleTimeout,
      requestIdle,
      enqueueUiMutation,
      shouldDeferNonCriticalCachedOpen,
      traceChatHistory,
      nowMs,
      appendSystemMessage,
      buildChatPreservingUnread,
      upsertChatPreservingUnread,
      syncOpenActivationReadState,
      maybeMarkRead,
      isActiveChat,
      hasLocalPendingWithoutLiveStream,
    } = deps;

    const fetchController = createHistoryFetchController({
      apiPost: deps.apiPost,
      histories,
      chats: deps.chats,
      prefetchingHistories: deps.prefetchingHistories,
      upsertChatPreservingUnread,
      traceChatHistory,
      nowMs,
      syncUnreadNotificationPresence: deps.syncUnreadNotificationPresence,
      getDocumentVisibilityState: deps.getDocumentVisibilityState,
      isActiveChat,
      requestIdle,
      scheduleTimeout,
    });
    const hydrationController = createHistoryHydrationController({
      loadChatHistory: fetchController.loadChatHistory,
      histories,
      chats: deps.chats,
      hasLiveStreamController: deps.hasLiveStreamController,
      mergeHydratedHistory: deps.mergeHydratedHistory,
      refreshTabNode: deps.refreshTabNode,
      getActiveChatId,
      resumePendingChatStream: deps.resumePendingChatStream,
      getLastOpenChatRequestId,
      setActiveChatMeta,
      renderMessages,
      pendingChats: deps.pendingChats,
      shouldResumeOnVisibilityChange: deps.shouldResumeOnVisibilityChange,
      restorePendingStreamSnapshot: deps.restorePendingStreamSnapshot,
      hasFreshPendingStreamSnapshot: deps.hasFreshPendingStreamSnapshot,
      readPendingStreamSnapshotMap: deps.readPendingStreamSnapshotMap,
      mergePendingSnapshotIntoHistory: deps.mergePendingSnapshotIntoHistory,
      finalizeHydratedPendingState: deps.finalizeHydratedPendingState,
      traceChatHistory,
      nowMs,
      syncUnreadNotificationPresence: deps.syncUnreadNotificationPresence,
      getDocumentVisibilityState: deps.getDocumentVisibilityState,
      buildChatPreservingUnread,
      upsertChatPreservingUnread,
      maybeMarkRead,
      syncHydratedActiveReadState: deps.syncHydratedActiveReadState,
      isActiveChat,
      hasLocalPendingWithoutLiveStream,
      getRenderedTranscriptSignature: deps.getRenderedTranscriptSignature,
      triggerIncomingMessageHaptic: deps.triggerIncomingMessageHaptic,
    });
    const cachedOpenController = createCachedOpenController({
      ...deps,
      setActiveChatMeta,
      renderMessages,
      getActiveChatId,
      getLastOpenChatRequestId,
      scheduleTimeout,
      requestIdle,
      enqueueUiMutation,
      shouldDeferNonCriticalCachedOpen,
      traceChatHistory,
      nowMs,
      isActiveChat,
    }, hydrationController);
    const statusController = createHistoryStatusController({
      apiPost: deps.apiPost,
      buildChatPreservingUnread,
      syncChats: deps.syncChats,
      syncPinnedChats: deps.syncPinnedChats,
      renderTabs: deps.renderTabs,
      renderPinnedChats: deps.renderPinnedChats,
      syncActivePendingStatus: deps.syncActivePendingStatus,
      updateComposerState: deps.updateComposerState,
      hasLiveStreamController: deps.hasLiveStreamController,
      abortStreamController: deps.abortStreamController,
      finalizeHydratedPendingState: deps.finalizeHydratedPendingState,
    });

    return openFlowHelpers.createHistoryOpenController({
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
    });
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
      messagesEl,
      template,
      nowStamp,
      renderBody,
      getLastOpenChatRequestId,
      setLastOpenChatRequestId,
      scheduleTimeout,
      requestIdle,
      runAfterUiMutation,
      getIsAuthenticated = () => true,
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
      hasFreshPendingStreamSnapshot,
      readPendingStreamSnapshotMap,
      mergePendingSnapshotIntoHistory,
      persistPendingStreamSnapshot,
      clearPendingStreamSnapshot,
      finalizeHydratedPendingState,
      shouldDeferNonCriticalCachedOpen = () => false,
      getRenderedTranscriptSignature = null,
      triggerIncomingMessageHaptic = null,
      syncUnreadNotificationPresence = null,
      getDocumentVisibilityState = () => 'visible',
      renderTraceLog = () => {},
      nowMs = () => Date.now(),
    } = deps;

    const enqueueUiMutation = typeof runAfterUiMutation === 'function'
      ? runAfterUiMutation
      : (callback) => scheduleTimeout(callback, 0);

    function isActiveChat(chatId) {
      return normalizeChatId(chatId) === normalizeChatId(getActiveChatId());
    }

    function traceChatHistory(eventName, details = null) {
      renderTraceLog(`chat-history-${eventName}`, details);
    }

    const readSyncController = createReadSyncController({
      apiPost,
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
    });

    const mutationController = createLocalMutationController({
      histories,
      getActiveChatId,
      messagesEl,
      template,
      nowStamp,
      renderBody,
      renderMessages,
      persistPendingStreamSnapshot,
      clearPendingStreamSnapshot,
      enqueueUiMutation,
      isActiveChat,
    });

    const historyController = createHistoryOpenController({
      apiPost,
      histories,
      chats,
      prefetchingHistories,
      setActiveChatMeta,
      renderMessages,
      hasLiveStreamController,
      abortStreamController,
      mergeHydratedHistory,
      refreshTabNode,
      getActiveChatId,
      resumePendingChatStream,
      getLastOpenChatRequestId,
      setLastOpenChatRequestId,
      scheduleTimeout,
      requestIdle,
      enqueueUiMutation,
      syncChats,
      syncPinnedChats,
      renderTabs,
      renderPinnedChats,
      syncActivePendingStatus,
      updateComposerState,
      pendingChats,
      shouldResumeOnVisibilityChange,
      restorePendingStreamSnapshot,
      hasFreshPendingStreamSnapshot,
      readPendingStreamSnapshotMap,
      mergePendingSnapshotIntoHistory,
      finalizeHydratedPendingState,
      shouldDeferNonCriticalCachedOpen,
      traceChatHistory,
      nowMs,
      syncUnreadNotificationPresence,
      getDocumentVisibilityState,
      appendSystemMessage: mutationController.appendSystemMessage,
      buildChatPreservingUnread: readSyncController.buildChatPreservingUnread,
      upsertChatPreservingUnread: readSyncController.upsertChatPreservingUnread,
      syncOpenActivationReadState: readSyncController.syncOpenActivationReadState,
      maybeMarkRead: readSyncController.maybeMarkRead,
      syncHydratedActiveReadState: readSyncController.syncHydratedActiveReadState,
      isActiveChat,
      hasLocalPendingWithoutLiveStream: readSyncController.hasLocalPendingWithoutLiveStream,
      getRenderedTranscriptSignature,
      triggerIncomingMessageHaptic,
    });

    return {
      historiesDiffer,
      loadChatHistory: historyController.loadChatHistory,
      hydrateChatFromServer: historyController.hydrateChatFromServer,
      openChat: historyController.openChat,
      prefetchChatHistory: historyController.prefetchChatHistory,
      warmChatHistoryCache: historyController.warmChatHistoryCache,
      addLocalMessage: mutationController.addLocalMessage,
      appendSystemMessage: mutationController.appendSystemMessage,
      updatePendingAssistant: mutationController.updatePendingAssistant,
      syncActiveMessageView: mutationController.syncActiveMessageView,
      scheduleActiveMessageView: mutationController.scheduleActiveMessageView,
      markRead: readSyncController.markRead,
      maybeMarkRead: readSyncController.maybeMarkRead,
      buildChatPreservingUnread: readSyncController.buildChatPreservingUnread,
      syncActiveViewportReadState: readSyncController.syncActiveViewportReadState,
      syncActiveStreamUnseenState: readSyncController.syncActiveStreamUnseenState,
      getCurrentUnreadCount: readSyncController.getCurrentUnreadCount,
      syncOpenActivationReadState: readSyncController.syncOpenActivationReadState,
      syncBootstrapActivationReadState: readSyncController.syncBootstrapActivationReadState,
      refreshChats: historyController.refreshChats,
      syncVisibleActiveChat: historyController.syncVisibleActiveChat,
      restoreActiveBootstrapPendingState: historyController.restoreActiveBootstrapPendingState,
    };
  }


  const api = {
    createController,
    createMetaController,
    createUnreadAnchorController,
    createActivationReadThresholdController,
    createUnreadPreservationController,
    createHistoryPendingStateController,
    createHistoryRenderDecisionController,
    createHydrationApplyController,
    createVisibilityResumeController,
    createUnreadHydrationRetryController,
    createCachedOpenController,
  };
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  globalScope.HermesMiniappChatHistory = api;
})(typeof window !== 'undefined' ? window : globalThis);