(function (globalScope) {
  function normalizeChatId(value) {
    const parsed = Number(value);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
  }

  function shouldPreservePendingLocalMessage(message) {
    if (!message || !message.pending) return false;
    const role = String(message.role || "").toLowerCase();
    return role === "tool" || role === "hermes" || role === "assistant";
  }

  function messageFingerprint(message) {
    const id = Number(message?.id || 0);
    if (Number.isInteger(id) && id > 0) {
      return `id:${id}`;
    }
    return [
      String(message?.role || "").toLowerCase(),
      String(message?.created_at || ""),
      String(message?.body || ""),
      message?.pending ? "pending" : "sent",
    ].join("|");
  }

  function applyPendingLocalUiState(incomingItem, localItem) {
    if (!incomingItem || !localItem) return incomingItem;
    const nextItem = { ...incomingItem };
    const role = String(localItem?.role || '').toLowerCase();
    const localBody = String(localItem?.body || '');
    if ((role === 'tool' || role === 'hermes' || role === 'assistant') && localBody.trim()) {
      nextItem.body = localBody;
    }
    if (role === 'tool' && typeof localItem?.collapsed === 'boolean') {
      nextItem.collapsed = localItem.collapsed;
    }
    return nextItem;
  }

  function collapseDuplicatePendingToolRows(history) {
    const items = Array.isArray(history) ? history : [];
    let keptPendingTool = null;
    const nextHistory = [];

    for (const item of items) {
      const isPendingTool = Boolean(item?.pending) && String(item?.role || '').toLowerCase() === 'tool';
      if (!isPendingTool) {
        nextHistory.push(item);
        continue;
      }

      if (!keptPendingTool) {
        keptPendingTool = { ...item };
        nextHistory.push(keptPendingTool);
        continue;
      }

      const keptBody = String(keptPendingTool?.body || '');
      const candidateBody = String(item?.body || '');
      if (candidateBody.length > keptBody.length) {
        keptPendingTool.body = candidateBody;
      }
      if (typeof item?.collapsed === 'boolean') {
        keptPendingTool.collapsed = item.collapsed;
      }
      const keptCreatedAt = String(keptPendingTool?.created_at || '');
      const candidateCreatedAt = String(item?.created_at || '');
      if (!keptCreatedAt && candidateCreatedAt) {
        keptPendingTool.created_at = candidateCreatedAt;
      }
    }

    return nextHistory;
  }

  function preserveCompletedLocalToolMessages(previousHistory, nextHistory) {
    const previous = Array.isArray(previousHistory) ? previousHistory : [];
    const incoming = Array.isArray(nextHistory) ? nextHistory.slice() : [];
    const localCompletedTools = previous.filter((item) => {
      if (!item || typeof item !== "object") return false;
      if (String(item.role || "").toLowerCase() !== "tool") return false;
      if (Boolean(item.pending)) return false;
      return Boolean(String(item.body || "").trim());
    });
    if (!localCompletedTools.length) {
      return incoming;
    }

    const normalizedBody = (message) => String(message?.body || "").trim();
    const relaxedIncomingMatchIndex = (message) => {
      const targetRole = String(message?.role || "").toLowerCase();
      const targetBody = normalizedBody(message);
      if (!targetRole || !targetBody) {
        return -1;
      }
      for (let index = 0; index < incoming.length; index += 1) {
        const candidate = incoming[index];
        if (String(candidate?.role || "").toLowerCase() !== targetRole) {
          continue;
        }
        if (normalizedBody(candidate) !== targetBody) {
          continue;
        }
        return index;
      }
      return -1;
    };

    const findIncomingIndexByFingerprint = (message) => {
      const target = messageFingerprint(message);
      const targetRole = String(message?.role || "").toLowerCase();
      const targetCreatedAt = String(message?.created_at || "");
      const targetBody = String(message?.body || "");
      const targetPending = Boolean(message?.pending);
      for (let index = 0; index < incoming.length; index += 1) {
        const candidate = incoming[index];
        if (messageFingerprint(candidate) === target) {
          return index;
        }
        if (
          String(candidate?.role || "").toLowerCase() === targetRole
          && String(candidate?.created_at || "") === targetCreatedAt
          && String(candidate?.body || "") === targetBody
          && Boolean(candidate?.pending) === targetPending
        ) {
          return index;
        }
      }
      return relaxedIncomingMatchIndex(message);
    };

    for (const toolMessage of localCompletedTools) {
      if (findIncomingIndexByFingerprint(toolMessage) >= 0) {
        continue;
      }

      const previousIndex = previous.indexOf(toolMessage);
      let anchorIndex = -1;
      for (let index = previousIndex + 1; index < previous.length; index += 1) {
        const candidate = previous[index];
        anchorIndex = findIncomingIndexByFingerprint(candidate);
        if (anchorIndex >= 0) {
          break;
        }
      }

      if (anchorIndex >= 0) {
        incoming.splice(anchorIndex, 0, { ...toolMessage });
      } else {
        incoming.push({ ...toolMessage });
      }
    }

    return incoming;
  }

  function mergeHydratedHistory({ previousHistory, nextHistory, chatPending, preserveCompletedToolTrace = false }) {
    const incoming = collapseDuplicatePendingToolRows(Array.isArray(nextHistory) ? nextHistory.slice() : []);
    const previous = collapseDuplicatePendingToolRows(Array.isArray(previousHistory) ? previousHistory : []);
    if (!chatPending) {
      return preserveCompletedToolTrace
        ? preserveCompletedLocalToolMessages(previous, incoming)
        : incoming;
    }

    const localPending = previous.filter(shouldPreservePendingLocalMessage);
    if (!localPending.length) {
      return incoming;
    }

    const existingIndexes = new Map();
    for (let index = 0; index < incoming.length; index += 1) {
      const item = incoming[index];
      const key = messageFingerprint(item);
      if (!existingIndexes.has(key)) {
        existingIndexes.set(key, []);
      }
      existingIndexes.get(key).push(index);
    }

    function findRelaxedPendingMatchIndex(localItem) {
      const localRole = String(localItem?.role || '').toLowerCase();
      const localCreatedAt = String(localItem?.created_at || '');
      const localPendingState = Boolean(localItem?.pending);
      const localId = Number(localItem?.id || 0);
      const candidateIndexes = [];
      for (let index = 0; index < incoming.length; index += 1) {
        const candidate = incoming[index];
        if (String(candidate?.role || '').toLowerCase() !== localRole) {
          continue;
        }
        if (Boolean(candidate?.pending) !== localPendingState) {
          continue;
        }
        candidateIndexes.push(index);
        const candidateId = Number(candidate?.id || 0);
        if (localId > 0 && candidateId > 0) {
          if (candidateId === localId) {
            return index;
          }
          continue;
        }
        if (localCreatedAt && String(candidate?.created_at || '') === localCreatedAt) {
          return index;
        }
      }
      if (
        candidateIndexes.length === 1
        && (localRole === 'tool' || localRole === 'assistant' || localRole === 'hermes')
      ) {
        return candidateIndexes[0];
      }
      return -1;
    }

    for (const item of localPending) {
      const key = messageFingerprint(item);
      const indexes = existingIndexes.get(key) || [];
      if (indexes.length > 0) {
        const matchIndex = indexes.shift();
        incoming[matchIndex] = applyPendingLocalUiState(incoming[matchIndex], item);
        continue;
      }
      const relaxedMatchIndex = findRelaxedPendingMatchIndex(item);
      if (relaxedMatchIndex >= 0) {
        incoming[relaxedMatchIndex] = applyPendingLocalUiState(incoming[relaxedMatchIndex], item);
        continue;
      }
      incoming.push({ ...item });
    }
    return incoming;
  }

  function messageStableKey(message, index = 0) {
    const messageId = Number(message?.id || 0);
    if (Number.isFinite(messageId) && messageId > 0) {
      return `id:${messageId}`;
    }

    const role = String(message?.role || "").toLowerCase();
    const pending = Boolean(message?.pending) ? "pending" : "sent";
    const createdAt = String(message?.created_at || "");
    return `local:${role}:${pending}:${createdAt}:${index}`;
  }

  function shouldUseAppendOnlyRender({ history, previouslyRenderedLength, renderedMessageKeys }) {
    const nextHistory = Array.isArray(history) ? history : [];
    const renderedLen = Math.max(0, Number(previouslyRenderedLength) || 0);
    const keys = Array.isArray(renderedMessageKeys) ? renderedMessageKeys : [];

    if (renderedLen <= 0) return false;
    if (nextHistory.length <= renderedLen) return false;
    if (keys.length !== renderedLen) return false;

    for (let index = 0; index < renderedLen; index += 1) {
      if (String(keys[index] || "") !== messageStableKey(nextHistory[index], index)) {
        return false;
      }
    }
    return true;
  }

  function getNextChatTabId({ orderedChatIds, activeChatId, reverse = false }) {
    const ids = Array.isArray(orderedChatIds)
      ? orderedChatIds.map((id) => normalizeChatId(id)).filter(Boolean)
      : [];
    if (ids.length <= 1) return null;

    const active = normalizeChatId(activeChatId);
    if (!active) return null;

    const currentIndex = ids.indexOf(active);
    if (currentIndex < 0) return null;

    const step = reverse ? -1 : 1;
    const nextIndex = (currentIndex + step + ids.length) % ids.length;
    const nextId = ids[nextIndex];
    return Number.isInteger(nextId) && nextId > 0 ? nextId : null;
  }

  const api = {
    mergeHydratedHistory,
    shouldUseAppendOnlyRender,
    getNextChatTabId,
  };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
  globalScope.HermesMiniappRuntimeHistory = api;
})(typeof window !== "undefined" ? window : globalThis);
