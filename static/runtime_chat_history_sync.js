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

    function prefetchChatHistory(chatId, { forceRefresh = false } = {}) {
      const key = normalizeChatId(chatId);
      const hadCachedHistory = histories.has(key);
      if (!key || prefetchingHistories.has(key) || hadCachedHistory) {
        return;
      }
      const currentHistory = [];
      prefetchingHistories.add(key);
      const startedAtMs = nowMs();
      traceChatHistory('prefetch-start', {
        chatId: key,
        forceRefresh: false,
        hadCachedHistory,
      });
      void loadChatHistory(key, { activate: false })
        .then((data) => {
          const decision = transcriptAuthority.describeSpeculativeHistoryCommit({
            currentChat: chats?.get?.(key) || null,
            incomingChat: data?.chat || null,
            currentHistory,
            incomingHistory: data?.history || [],
            source: 'prefetch',
            isActiveChat: isActiveChat(key),
            cacheFilledElsewhere: !hadCachedHistory && histories.has(key),
          });
          const { activeNow, cacheFilledElsewhere, laggingMetadata, transcriptAdvancedWhileLaggingMetadata } = decision.reasons;
          if (!decision.commit) {
            traceChatHistory('prefetch-skipped-commit', {
              chatId: key,
              activeNow,
              cacheFilledElsewhere,
              laggingPrefetchResult: laggingMetadata,
              transcriptAdvancedWhileLaggingMetadata,
              durationMs: Math.max(0, Math.round(nowMs() - startedAtMs)),
            });
            return;
          }
          upsertChatPreservingUnread(data.chat, {
            preserveLaggingLocalState: laggingMetadata,
          });
          histories.set(key, data.history || []);
          traceChatHistory('prefetch-finished', {
            chatId: key,
            forceRefresh: Boolean(forceRefresh),
            hadCachedHistory,
            durationMs: Math.max(0, Math.round(nowMs() - startedAtMs)),
            historyCount: Array.isArray(data?.history) ? data.history.length : 0,
          });
        })
        .catch((error) => {
          traceChatHistory('prefetch-failed', {
            chatId: key,
            forceRefresh: Boolean(forceRefresh),
            hadCachedHistory,
            durationMs: Math.max(0, Math.round(nowMs() - startedAtMs)),
            message: String(error?.message || ''),
          });
        })
        .finally(() => {
          prefetchingHistories.delete(key);
        });
    }

    function warmChatHistoryCache() {
      const candidates = [...chats.keys()]
        .filter((id) => !isActiveChat(id))
        .map((id) => {
          const key = Number(id);
          if (prefetchingHistories.has(key) || histories.has(key)) {
            return null;
          }
          const chat = chats?.get?.(key) || null;
          const hasUnread = Math.max(0, Number(chat?.unread_count || 0)) > 0
            || Math.max(0, Number(chat?.newest_unread_message_id || 0)) > 0;
          const isPending = Boolean(chat?.pending);
          return {
            id: key,
            forceRefresh: false,
            priority: (isPending ? 2 : 0) + (hasUnread ? 1 : 0),
          };
        })
        .filter(Boolean)
        .sort((left, right) => {
          if (left.priority !== right.priority) {
            return right.priority - left.priority;
          }
          return Number(left.id) - Number(right.id);
        })
        .slice(0, 4);
      if (!candidates.length) return;

      const immediateCandidates = candidates.slice(0, 2);
      const remainingCandidates = candidates.slice(2);
      traceChatHistory('warm-cache-start', {
        chatIds: candidates.map((candidate) => normalizeChatId(candidate.id)),
        priorityChatIds: immediateCandidates.map((candidate) => normalizeChatId(candidate.id)),
        refreshChatIds: candidates.filter((candidate) => candidate.forceRefresh).map((candidate) => normalizeChatId(candidate.id)),
      });
      immediateCandidates.forEach((candidate) => prefetchChatHistory(candidate.id, { forceRefresh: candidate.forceRefresh }));
      if (!remainingCandidates.length) {
        return;
      }

      const warmNext = (index) => {
        if (index >= remainingCandidates.length) return;
        const candidate = remainingCandidates[index];
        prefetchChatHistory(candidate.id, { forceRefresh: candidate.forceRefresh });
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
