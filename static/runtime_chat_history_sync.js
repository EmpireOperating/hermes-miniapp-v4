(function initHermesMiniappRuntimeChatHistorySync(globalScope) {
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
    throw new Error('HermesMiniappRuntimeTranscriptAuthority is required before runtime_chat_history_sync.js');
  }

  function normalizeChatId(chatId) {
    return Number(chatId);
  }

  function createHistoryFetchController(deps) {
    const {
      apiPost,
      histories,
      chats,
      prefetchingHistories,
      upsertChatPreservingUnread,
      traceChatHistory,
      nowMs,
      syncUnreadNotificationPresence,
      getDocumentVisibilityState = () => 'visible',
      isActiveChat,
      requestIdle,
      scheduleTimeout,
    } = deps;

    async function loadChatHistory(chatId, { activate = true } = {}) {
      const targetChatId = normalizeChatId(chatId);
      const startedAtMs = nowMs();
      traceChatHistory('history-fetch-start', {
        chatId: targetChatId,
        activate: Boolean(activate),
      });
      try {
        const data = await apiPost('/api/chats/history', { chat_id: targetChatId, activate });
        traceChatHistory('history-fetch-finished', {
          chatId: targetChatId,
          activate: Boolean(activate),
          source: 'history',
          durationMs: Math.max(0, Math.round(nowMs() - startedAtMs)),
          historyCount: Array.isArray(data?.history) ? data.history.length : 0,
        });
        if (
          Boolean(activate)
          && typeof syncUnreadNotificationPresence === 'function'
          && getDocumentVisibilityState() === 'visible'
        ) {
          void syncUnreadNotificationPresence({ visible: true, chatId: targetChatId });
        }
        return data;
      } catch (error) {
        const message = String(error?.message || '');
        const isNotFound = /request failed:\s*404/i.test(message);
        if (!isNotFound) {
          traceChatHistory('history-fetch-failed', {
            chatId: targetChatId,
            activate: Boolean(activate),
            durationMs: Math.max(0, Math.round(nowMs() - startedAtMs)),
            message,
          });
          throw error;
        }
        traceChatHistory('history-fetch-fallback-open', {
          chatId: targetChatId,
          activate: Boolean(activate),
          durationMs: Math.max(0, Math.round(nowMs() - startedAtMs)),
        });
        const data = await apiPost('/api/chats/open', { chat_id: targetChatId });
        traceChatHistory('history-fetch-finished', {
          chatId: targetChatId,
          activate: Boolean(activate),
          source: 'open-fallback',
          durationMs: Math.max(0, Math.round(nowMs() - startedAtMs)),
          historyCount: Array.isArray(data?.history) ? data.history.length : 0,
        });
        return data;
      }
    }

    function prefetchChatHistory(chatId) {
      const key = normalizeChatId(chatId);
      if (!key || histories.has(key) || prefetchingHistories.has(key)) {
        return;
      }
      prefetchingHistories.add(key);
      const startedAtMs = nowMs();
      traceChatHistory('prefetch-start', {
        chatId: key,
      });
      void loadChatHistory(key, { activate: false })
        .then((data) => {
          const decision = transcriptAuthority.describeSpeculativeHistoryCommit({
            currentChat: chats?.get?.(key) || null,
            incomingChat: data?.chat || null,
            currentHistory: histories?.get?.(key) || [],
            incomingHistory: data?.history || [],
            source: 'prefetch',
            isActiveChat: isActiveChat(key),
            cacheFilledElsewhere: histories.has(key),
          });
          const { activeNow, cacheFilledElsewhere, laggingMetadata } = decision.reasons;
          if (!decision.commit) {
            traceChatHistory('prefetch-skipped-commit', {
              chatId: key,
              activeNow,
              cacheFilledElsewhere,
              laggingPrefetchResult: laggingMetadata,
              durationMs: Math.max(0, Math.round(nowMs() - startedAtMs)),
            });
            return;
          }
          upsertChatPreservingUnread(data.chat);
          histories.set(key, data.history || []);
          traceChatHistory('prefetch-finished', {
            chatId: key,
            durationMs: Math.max(0, Math.round(nowMs() - startedAtMs)),
            historyCount: Array.isArray(data?.history) ? data.history.length : 0,
          });
        })
        .catch((error) => {
          traceChatHistory('prefetch-failed', {
            chatId: key,
            durationMs: Math.max(0, Math.round(nowMs() - startedAtMs)),
            message: String(error?.message || ''),
          });
        })
        .finally(() => {
          prefetchingHistories.delete(key);
        });
    }

    function warmChatHistoryCache() {
      const ids = [...chats.keys()]
        .filter((id) => !isActiveChat(id))
        .filter((id) => !histories.has(Number(id)) && !prefetchingHistories.has(Number(id)))
        .slice(0, 4);
      if (!ids.length) return;

      const [priorityId, ...remainingIds] = ids;
      traceChatHistory('warm-cache-start', {
        chatIds: ids.map((id) => normalizeChatId(id)),
        priorityChatId: normalizeChatId(priorityId),
      });
      prefetchChatHistory(priorityId);
      if (!remainingIds.length) {
        return;
      }

      const warmNext = (index) => {
        if (index >= remainingIds.length) return;
        prefetchChatHistory(remainingIds[index]);
        scheduleTimeout(() => warmNext(index + 1), 160);
      };

      if (typeof requestIdle === 'function') {
        requestIdle(() => warmNext(0), { timeout: 1200 });
        return;
      }
      scheduleTimeout(() => warmNext(0), 120);
    }

    return {
      loadChatHistory,
      prefetchChatHistory,
      warmChatHistoryCache,
    };
  }

  function createHistoryStatusController(deps) {
    const {
      apiPost,
      buildChatPreservingUnread,
      syncChats,
      syncPinnedChats,
      renderTabs,
      renderPinnedChats,
      syncActivePendingStatus,
      updateComposerState,
      hasLiveStreamController,
      abortStreamController,
      finalizeHydratedPendingState,
    } = deps;

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
      const rawStatusChats = Array.isArray(data.chats) ? data.chats : [];
      const rawPinnedStatusChats = Array.isArray(data.pinned_chats) ? data.pinned_chats : [];
      const statusChats = rawStatusChats.map((chat) => buildChatPreservingUnread(chat, {
        preserveActivationUnread: true,
        preserveLaggingLocalState: true,
      }));
      const pinnedStatusChats = rawPinnedStatusChats.map((chat) => buildChatPreservingUnread(chat, {
        preserveActivationUnread: true,
        preserveLaggingLocalState: true,
      }));
      syncChats(statusChats);
      reconcilePendingStateFromStatus(rawStatusChats);
      syncPinnedChats(pinnedStatusChats);
      renderTabs();
      renderPinnedChats();
      syncActivePendingStatus();
      updateComposerState();
    }

    return {
      reconcilePendingStateFromStatus,
      refreshChats,
    };
  }

  const api = {
    createHistoryFetchController,
    createHistoryStatusController,
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  globalScope.HermesMiniappRuntimeChatHistorySync = api;
})(typeof window !== 'undefined' ? window : globalThis);
