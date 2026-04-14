(function (globalScope) {
  function normalizeChatId(chatId) {
    const parsed = Number(chatId);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
  }

  function normalizeAssistantLikeBody(text) {
    return String(text || '').replace(/\s+/g, ' ').trim();
  }

  function latestAssistantMessage(history) {
    const items = Array.isArray(history) ? history : [];
    for (let index = items.length - 1; index >= 0; index -= 1) {
      const item = items[index];
      const role = String(item?.role || '').toLowerCase();
      if (role !== 'hermes' && role !== 'assistant') continue;
      return item;
    }
    return null;
  }

  function latestCompletedAssistantRecord(history) {
    const items = Array.isArray(history) ? history : [];
    for (let index = items.length - 1; index >= 0; index -= 1) {
      const item = items[index];
      const role = String(item?.role || '').toLowerCase();
      if (role !== 'hermes' && role !== 'assistant') continue;
      if (Boolean(item?.pending)) continue;
      const body = String(item?.body || '').trim();
      if (!body) continue;
      return { item, index };
    }
    return null;
  }

  function countUserMessagesThroughIndex(history, endIndex) {
    const items = Array.isArray(history) ? history : [];
    if (!items.length) return 0;
    const targetIndex = Math.max(0, Math.min(items.length - 1, Number(endIndex) || 0));
    let count = 0;
    for (let index = 0; index <= targetIndex; index += 1) {
      if (String(items[index]?.role || '').toLowerCase() === 'user') {
        count += 1;
      }
    }
    return count;
  }

  function latestAssistantRenderSignature(history) {
    const item = latestAssistantMessage(history);
    if (!item) {
      return '';
    }
    const role = String(item?.role || '').toLowerCase();
    const fileRefs = Array.isArray(item?.file_refs) ? item.file_refs : [];
    const fileRefSignature = fileRefs
      .map((ref) => `${String(ref?.ref_id || '')}:${String(ref?.path || '')}:${String(ref?.label || '')}`)
      .join('|');
    return [
      role,
      String(item?.body || ''),
      item?.pending ? 'pending' : 'final',
      fileRefSignature,
    ].join('::');
  }

  function transcriptRenderSignature(history) {
    const items = Array.isArray(history) ? history : [];
    return items
      .filter((item) => {
        const role = String(item?.role || '').toLowerCase();
        return role === 'user' || role === 'tool' || role === 'hermes' || role === 'assistant';
      })
      .map((item) => {
        const role = String(item?.role || '').toLowerCase();
        const fileRefs = Array.isArray(item?.file_refs) ? item.file_refs : [];
        const fileRefSignature = fileRefs
          .map((ref) => `${String(ref?.ref_id || '')}:${String(ref?.path || '')}:${String(ref?.label || '')}`)
          .join('|');
        return [
          role,
          String(item?.body || ''),
          item?.pending ? 'pending' : 'final',
          item?.collapsed ? 'collapsed' : 'expanded',
          fileRefSignature,
        ].join('::');
      })
      .join('||');
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

  function historiesDiffer(currentHistory, incomingHistory) {
    const a = currentHistory || [];
    const b = incomingHistory || [];
    if (a.length !== b.length) return true;
    if (!a.length) return false;

    const aLast = a[a.length - 1] || {};
    const bLast = b[b.length - 1] || {};
    return aLast.id !== bLast.id || aLast.body !== bLast.body || aLast.role !== bLast.role;
  }

  function hasLocalPendingTranscript(history) {
    const previous = Array.isArray(history) ? history : [];
    return previous.some((item) => {
      if (!item?.pending) return false;
      const role = String(item?.role || '').toLowerCase();
      return role === 'tool' || role === 'hermes' || role === 'assistant';
    });
  }

  function latestAssistantLikeBody(entries, { pending } = {}) {
    const items = Array.isArray(entries) ? entries : [];
    for (let index = items.length - 1; index >= 0; index -= 1) {
      const item = items[index];
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
    const completedBody = latestAssistantLikeBody(nextHistory, { pending: false });
    if (!completedBody) return false;
    const pendingBody = latestAssistantLikeBody(previousHistory, { pending: true });
    if (pendingBody) {
      const normalizedCompletedBody = normalizeAssistantLikeBody(completedBody);
      const normalizedPendingBody = normalizeAssistantLikeBody(pendingBody);
      if (!normalizedCompletedBody || !normalizedPendingBody) {
        return false;
      }
      if (normalizedCompletedBody === normalizedPendingBody) {
        return true;
      }
      const shorterBody = normalizedCompletedBody.length <= normalizedPendingBody.length
        ? normalizedCompletedBody
        : normalizedPendingBody;
      const longerBody = shorterBody === normalizedCompletedBody
        ? normalizedPendingBody
        : normalizedCompletedBody;
      return shorterBody.length >= 24 && longerBody.startsWith(shorterBody);
    }
    const hydratedPendingTranscript = Array.isArray(nextHistory) && nextHistory.some((item) => {
      if (!item?.pending) return false;
      const role = String(item?.role || '').toLowerCase();
      return role === 'tool' || role === 'hermes' || role === 'assistant';
    });
    if (hydratedPendingTranscript) {
      return false;
    }
    return hasLocalPendingTranscript(previousHistory);
  }

  function latestCompletedAssistantHydrationKey(chatId, history) {
    const key = normalizeChatId(chatId);
    if (!key) return '';
    const entries = Array.isArray(history) ? history : [];
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      const item = entries[index] || {};
      if (Boolean(item?.pending)) continue;
      const role = String(item?.role || '').toLowerCase();
      if (role !== 'assistant' && role !== 'hermes') continue;
      const messageId = Math.max(0, Number(item?.id || 0));
      if (messageId > 0) {
        return `chat:${key}:msg:${messageId}`;
      }
      const fileRefs = Array.isArray(item?.file_refs) ? item.file_refs : [];
      const fileRefSignature = fileRefs
        .map((ref) => `${String(ref?.ref_id || '')}:${String(ref?.path || '')}:${String(ref?.label || '')}`)
        .join('|');
      return [
        `chat:${key}:local`,
        String(item?.created_at || ''),
        String(item?.body || ''),
        fileRefSignature,
      ].join('|');
    }
    return '';
  }

  function hasVisibleAssistantLikeTranscript(entries) {
    const items = Array.isArray(entries) ? entries : [];
    return items.some((item) => {
      const role = String(item?.role || '').toLowerCase();
      if (role !== 'assistant' && role !== 'hermes') return false;
      return String(item?.body || '').trim().length > 0;
    });
  }

  function preserveLatestCompletedAssistantMessage(previousHistory, nextHistory) {
    const previousRecord = latestCompletedAssistantRecord(previousHistory);
    const incoming = Array.isArray(nextHistory) ? nextHistory.slice() : [];
    const previousAssistant = previousRecord?.item || null;
    const previousBody = String(previousAssistant?.body || '').trim();
    if (!previousAssistant || !previousBody) {
      return incoming;
    }
    const matchingIncomingIndex = incoming.findIndex((item) => {
      const role = String(item?.role || '').toLowerCase();
      if (role !== 'hermes' && role !== 'assistant') return false;
      return String(item?.body || '').trim() === previousBody;
    });
    if (matchingIncomingIndex >= 0) {
      const candidate = incoming[matchingIncomingIndex] || {};
      incoming[matchingIncomingIndex] = {
        ...candidate,
        pending: false,
      };
      return incoming;
    }

    const latestIncomingRecord = latestCompletedAssistantRecord(incoming);
    const previousTurn = countUserMessagesThroughIndex(previousHistory, previousRecord.index);
    const incomingTurn = latestIncomingRecord
      ? countUserMessagesThroughIndex(incoming, latestIncomingRecord.index)
      : -1;

    if (latestIncomingRecord && incomingTurn === previousTurn) {
      incoming[latestIncomingRecord.index] = {
        ...latestIncomingRecord.item,
        ...previousAssistant,
        pending: false,
      };
      return incoming;
    }

    if (latestIncomingRecord && incomingTurn > previousTurn) {
      return incoming;
    }

    incoming.push({
      ...previousAssistant,
      pending: false,
    });
    return incoming;
  }

  function findLatestPendingAssistantRecord(history) {
    const entries = Array.isArray(history) ? history : [];
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      const item = entries[index];
      if (!item?.pending) continue;
      const role = String(item?.role || '').toLowerCase();
      if (role !== 'assistant' && role !== 'hermes') continue;
      return { item, index };
    }
    return null;
  }

  function findCompletedAssistantIndexByNormalizedBody(history, normalizedBody, { skipIndex = -1 } = {}) {
    const targetBody = String(normalizedBody || '').trim();
    if (!targetBody) return -1;
    const entries = Array.isArray(history) ? history : [];
    return entries.findIndex((item, index) => {
      if (!item || index === skipIndex || item.pending) return false;
      const role = String(item?.role || '').toLowerCase();
      if (role !== 'assistant' && role !== 'hermes') return false;
      return normalizeAssistantLikeBody(item?.body) === targetBody;
    });
  }

  function reconcilePendingAssistantUpdate(history, {
    nextBody,
    pendingState = true,
    defaultRole = 'hermes',
    createdAt = '',
  } = {}) {
    const resolvedHistory = Array.isArray(history) ? history.slice() : [];
    const finalPendingState = Boolean(pendingState);
    const rawBody = String(nextBody || '');
    const trimmedBody = rawBody.trim();
    const normalizedBody = normalizeAssistantLikeBody(rawBody);
    const pendingRecord = findLatestPendingAssistantRecord(resolvedHistory);

    if (!pendingRecord) {
      if (!trimmedBody && !finalPendingState) {
        return {
          history: resolvedHistory,
          changed: false,
          action: 'noop-empty-final',
          shouldPersistSnapshot: false,
          shouldClearSnapshot: false,
        };
      }
      if (!finalPendingState) {
        const duplicateCompletedAssistantIndex = findCompletedAssistantIndexByNormalizedBody(resolvedHistory, normalizedBody);
        if (duplicateCompletedAssistantIndex >= 0) {
          return {
            history: resolvedHistory,
            changed: false,
            action: 'noop-duplicate-final',
            shouldPersistSnapshot: false,
            shouldClearSnapshot: true,
          };
        }
      }
      resolvedHistory.push({
        role: defaultRole,
        body: nextBody,
        created_at: createdAt || new Date().toISOString(),
        pending: finalPendingState,
      });
      return {
        history: resolvedHistory,
        changed: true,
        action: finalPendingState ? 'append-pending' : 'append-final',
        shouldPersistSnapshot: true,
        shouldClearSnapshot: !finalPendingState,
      };
    }

    if (!finalPendingState) {
      const duplicateCompletedAssistantIndex = findCompletedAssistantIndexByNormalizedBody(
        resolvedHistory,
        normalizedBody,
        { skipIndex: pendingRecord.index },
      );
      if (duplicateCompletedAssistantIndex >= 0) {
        resolvedHistory.splice(pendingRecord.index, 1);
        return {
          history: resolvedHistory,
          changed: true,
          action: 'drop-pending-duplicate-final',
          shouldPersistSnapshot: false,
          shouldClearSnapshot: true,
        };
      }
    }

    const nextMessage = {
      ...pendingRecord.item,
      body: nextBody,
      pending: finalPendingState,
    };
    resolvedHistory[pendingRecord.index] = nextMessage;
    const changed = nextMessage.body !== pendingRecord.item?.body || Boolean(nextMessage.pending) !== Boolean(pendingRecord.item?.pending);
    return {
      history: resolvedHistory,
      changed,
      action: finalPendingState ? 'update-pending' : 'finalize-pending',
      shouldPersistSnapshot: true,
      shouldClearSnapshot: !finalPendingState,
    };
  }

  function didTranscriptMateriallyAdvance(previousHistory, incomingHistory) {
    return transcriptRenderSignature(previousHistory) !== transcriptRenderSignature(incomingHistory);
  }

  function describeActiveTranscriptRender({
    previousHistory = [],
    incomingHistory = [],
    renderedTranscriptSignature = '',
    restoredPendingSnapshot = false,
    historyChanged = false,
    hadCachedHistory = false,
    unreadCount = 0,
  } = {}) {
    const previousRenderSignature = historyRenderSignature(previousHistory);
    const nextRenderSignature = historyRenderSignature(incomingHistory);
    const normalizedRenderedTranscriptSignature = String(renderedTranscriptSignature || '');
    const shouldForceStaleRenderedTranscriptRender = Boolean(
      normalizedRenderedTranscriptSignature
      && normalizedRenderedTranscriptSignature !== nextRenderSignature
    );
    const shouldForceUnreadTranscriptRender = Boolean(
      hadCachedHistory
      && !historyChanged
      && !restoredPendingSnapshot
      && Math.max(0, Number(unreadCount || 0)) > 0
      && hasVisibleAssistantLikeTranscript(incomingHistory)
    );
    const shouldRenderActiveHistory = previousRenderSignature !== nextRenderSignature
      || Boolean(restoredPendingSnapshot)
      || shouldForceUnreadTranscriptRender
      || shouldForceStaleRenderedTranscriptRender;
    return {
      previousRenderSignature,
      nextRenderSignature,
      renderedTranscriptSignature: normalizedRenderedTranscriptSignature,
      shouldForceUnreadTranscriptRender,
      shouldForceStaleRenderedTranscriptRender,
      shouldRenderActiveHistory,
    };
  }

  function isLaggingChatMetadata(currentChat, incomingChat) {
    if (!currentChat || typeof currentChat !== 'object' || !incomingChat || typeof incomingChat !== 'object') {
      return false;
    }
    const localUnread = Math.max(0, Number(currentChat.unread_count || 0));
    const incomingUnread = Math.max(0, Number(incomingChat.unread_count || 0));
    if (localUnread > incomingUnread) {
      return true;
    }
    const localUnreadAnchor = Math.max(0, Number(currentChat.newest_unread_message_id || 0));
    const incomingUnreadAnchor = Math.max(0, Number(incomingChat.newest_unread_message_id || 0));
    if (localUnreadAnchor > incomingUnreadAnchor) {
      return true;
    }
    return Boolean(currentChat.pending) && !Boolean(incomingChat.pending);
  }

  function describeSpeculativeHistoryCommit({
    currentChat = null,
    incomingChat = null,
    currentHistory = [],
    incomingHistory = [],
    source = '',
    isActiveChat = false,
    localPending = false,
    cacheFilledElsewhere = false,
  } = {}) {
    const reasons = {
      activeNow: Boolean(isActiveChat),
      cacheFilledElsewhere: Boolean(cacheFilledElsewhere),
      laggingMetadata: false,
      unchangedWhilePending: false,
    };

    if (source === 'prefetch') {
      reasons.laggingMetadata = isLaggingChatMetadata(currentChat, incomingChat);
      const commit = !reasons.activeNow && !reasons.cacheFilledElsewhere && !reasons.laggingMetadata;
      return { commit, reasons };
    }

    if (source === 'inactive-terminal-reconcile') {
      reasons.unchangedWhilePending = !isActiveChat
        && localPending
        && !didTranscriptMateriallyAdvance(currentHistory, incomingHistory);
      return {
        commit: !reasons.unchangedWhilePending,
        reasons,
      };
    }

    return {
      commit: true,
      reasons,
    };
  }

  function shouldCommitSpeculativeHistory(options = {}) {
    return describeSpeculativeHistoryCommit(options).commit;
  }

  const api = {
    hasLocalPendingTranscript,
    normalizeAssistantLikeBody,
    latestCompletedAssistantRecord,
    countUserMessagesThroughIndex,
    latestAssistantRenderSignature,
    transcriptRenderSignature,
    historyRenderSignature,
    historiesDiffer,
    hydratedCompletionMatchesVisibleLocalPending,
    latestCompletedAssistantHydrationKey,
    hasVisibleAssistantLikeTranscript,
    preserveLatestCompletedAssistantMessage,
    reconcilePendingAssistantUpdate,
    didTranscriptMateriallyAdvance,
    describeActiveTranscriptRender,
    isLaggingChatMetadata,
    describeSpeculativeHistoryCommit,
    shouldCommitSpeculativeHistory,
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  globalScope.HermesMiniappRuntimeTranscriptAuthority = api;
})(typeof window !== 'undefined' ? window : globalThis);
