(function initRenderTraceHistoryHelpers(global) {
  "use strict";

  function createHistoryRenderController(deps) {
    const {
      messagesEl,
      jumpLatestButton,
      jumpLastStartButton,
      histories,
      virtualizationRanges,
      virtualMetrics,
      renderedHistoryLength,
      renderedHistoryVirtualized,
      unseenStreamChats,
      chatScrollTop,
      chatStickToBottom,
      historyCountEl,
      virtualizeThreshold = 220,
      estimatedMessageHeight = 108,
      virtualOverscan = 18,
      getActiveChatId,
      getRenderedChatId,
      setRenderedChatId,
      refreshTabNode,
      clearSelectionQuoteStateFn,
      syncLiveToolStreamForChatFn,
      appendMessagesFn,
      shouldUseAppendOnlyRenderFn,
      renderTraceLogFn,
      createSpacerElementFn,
      createFragmentFn,
    } = deps || {};

    function isNearBottom(element, threshold = 24) {
      if (!element) return true;
      return (element.scrollHeight - element.clientHeight - element.scrollTop) <= threshold;
    }

    function shouldVirtualizeHistory(historyLength) {
      return Number(historyLength) > Number(virtualizeThreshold);
    }

    function getEstimatedMessageHeight(chatId) {
      const metric = virtualMetrics.get(Number(chatId));
      return Math.max(56, Number(metric?.avgHeight) || Number(estimatedMessageHeight));
    }

    function updateVirtualMetrics(chatId) {
      const nodes = messagesEl?.querySelectorAll?.('.message') || [];
      if (!nodes.length) return;

      let totalHeight = 0;
      nodes.forEach((node) => {
        totalHeight += Number(node?.offsetHeight) || 0;
      });
      if (totalHeight <= 0) return;

      const sampleAvg = totalHeight / nodes.length;
      const prior = getEstimatedMessageHeight(chatId);
      const blended = Math.round((prior * 0.68) + (sampleAvg * 0.32));
      virtualMetrics.set(Number(chatId), { avgHeight: blended });
    }

    function updateJumpLatestVisibility() {
      const key = Number(getActiveChatId?.());
      const hasActiveChat = key > 0;

      const showJumpLatest = hasActiveChat && !isNearBottom(messagesEl, 64);
      if (jumpLatestButton) {
        jumpLatestButton.hidden = !showJumpLatest;
      }

      if (jumpLastStartButton) {
        const renderedMessages = messagesEl?.querySelectorAll?.('.message') || [];
        const lastRenderedMessage = renderedMessages[renderedMessages.length - 1];
        const showJumpLastStart = Boolean(
          hasActiveChat
          && lastRenderedMessage
          && Number(lastRenderedMessage.offsetTop) < (messagesEl.scrollTop - 6)
        );
        jumpLastStartButton.hidden = !showJumpLastStart;
      }
    }

    function markStreamUpdate(chatId) {
      const key = Number(chatId);
      if (!key || key !== Number(getActiveChatId?.())) return;
      if (isNearBottom(messagesEl, 40)) return;
      unseenStreamChats.add(key);
      refreshTabNode?.(key);
      updateJumpLatestVisibility();
    }

    function computeVirtualRange({ total, scrollTop, viewportHeight, forceBottom, estimatedHeight }) {
      const rowHeight = Math.max(56, Number(estimatedHeight) || Number(estimatedMessageHeight));
      const estimatedVisible = Math.max(1, Math.ceil(Number(viewportHeight) / rowHeight));
      const windowSize = estimatedVisible + (Number(virtualOverscan) * 2);

      if (forceBottom) {
        const end = Number(total);
        const start = Math.max(0, end - windowSize);
        return { start, end };
      }

      const approxStart = Math.max(0, Math.floor(Number(scrollTop) / rowHeight) - Number(virtualOverscan));
      const start = Math.min(approxStart, Math.max(0, Number(total) - windowSize));
      const end = Math.min(Number(total), start + windowSize);
      return { start, end };
    }

    function renderVirtualizedHistory(targetChatId, history, {
      prevScrollTop,
      preserveViewport,
      forceBottom,
      shouldStick,
      estimatedHeight,
    }) {
      const viewportHeight = Math.max(messagesEl.clientHeight || 0, 320);
      const range = computeVirtualRange({
        total: history.length,
        scrollTop: forceBottom ? Number.MAX_SAFE_INTEGER : prevScrollTop,
        viewportHeight,
        forceBottom: forceBottom || (!preserveViewport && shouldStick),
        estimatedHeight,
      });

      const renderStart = range.start;
      const renderEnd = range.end;

      const topSpacer = typeof createSpacerElementFn === 'function'
        ? createSpacerElementFn()
        : document.createElement('div');
      topSpacer.className = 'messages__spacer';
      topSpacer.style.height = `${renderStart * estimatedHeight}px`;

      const bottomSpacer = typeof createSpacerElementFn === 'function'
        ? createSpacerElementFn()
        : document.createElement('div');
      bottomSpacer.className = 'messages__spacer';
      bottomSpacer.style.height = `${Math.max(0, history.length - renderEnd) * estimatedHeight}px`;

      messagesEl.appendChild(topSpacer);
      const fragment = typeof createFragmentFn === 'function'
        ? createFragmentFn()
        : document.createDocumentFragment();
      appendMessagesFn(fragment, history.slice(renderStart, renderEnd));
      messagesEl.appendChild(fragment);
      messagesEl.appendChild(bottomSpacer);

      virtualizationRanges.set(targetChatId, {
        start: renderStart,
        end: renderEnd,
        total: history.length,
        estimatedHeight,
      });
    }

    function renderFullHistory(targetChatId, history) {
      const fragment = typeof createFragmentFn === 'function'
        ? createFragmentFn()
        : document.createDocumentFragment();
      appendMessagesFn(fragment, history);
      messagesEl.appendChild(fragment);
      virtualizationRanges.delete(targetChatId);
    }

    function tryAppendOnlyRender(targetChatId, history, {
      preserveViewport,
      forceBottom,
      isSameRenderedChat,
      shouldVirtualize,
      prevScrollTop,
      prevViewportSnapshot,
      wasNearBottom,
    }) {
      if (forceBottom || !preserveViewport || !isSameRenderedChat || shouldVirtualize) {
        return false;
      }

      if (renderedHistoryVirtualized.get(targetChatId)) {
        return false;
      }

      const previouslyRenderedLength = Number(renderedHistoryLength.get(targetChatId));
      if (!Number.isFinite(previouslyRenderedLength) || previouslyRenderedLength < 0) {
        return false;
      }

      if (history.length <= previouslyRenderedLength) {
        return false;
      }

      const renderedMessageKeys = Array.from(messagesEl.querySelectorAll('.message'))
        .map((node) => String(node?.dataset?.messageKey || ''));

      if (!shouldUseAppendOnlyRenderFn({
        history,
        previouslyRenderedLength,
        renderedMessageKeys,
      })) {
        renderTraceLogFn?.('append-only-skip-history-misaligned', {
          chatId: Number(targetChatId),
          previouslyRenderedLength,
          renderedMessageNodes: renderedMessageKeys.length,
          historyLength: history.length,
        });
        return false;
      }

      const appendedSlice = history.slice(previouslyRenderedLength);
      if (!appendedSlice.length) {
        return false;
      }

      const fragment = typeof createFragmentFn === 'function'
        ? createFragmentFn()
        : document.createDocumentFragment();
      appendMessagesFn(fragment, appendedSlice, { startIndex: previouslyRenderedLength });
      messagesEl.appendChild(fragment);

      const shouldStickBottom = Boolean(wasNearBottom);
      if (shouldStickBottom) {
        messagesEl.scrollTop = messagesEl.scrollHeight;
      } else {
        restoreViewportSnapshot(prevViewportSnapshot || { scrollTop: prevScrollTop });
      }

      renderTraceLogFn?.('append-only-render', {
        chatId: Number(targetChatId),
        appendedCount: appendedSlice.length,
        shouldStickBottom,
        preservedScrollTop: Math.max(0, prevScrollTop),
      });

      return true;
    }

    function captureViewportSnapshot() {
      const scrollTop = Math.max(0, Number(messagesEl.scrollTop || 0));
      const nodes = messagesEl.querySelectorAll('.message');
      for (const node of nodes) {
        const nodeTop = Number(node?.offsetTop);
        const nodeHeight = Number(node?.offsetHeight);
        if (!Number.isFinite(nodeTop) || !Number.isFinite(nodeHeight)) continue;
        if ((nodeTop + nodeHeight) <= scrollTop) continue;
        const messageKey = String(node?.dataset?.messageKey || '');
        if (!messageKey) break;
        return {
          scrollTop,
          messageKey,
          offsetWithinMessage: scrollTop - nodeTop,
        };
      }
      return {
        scrollTop,
        messageKey: '',
        offsetWithinMessage: 0,
      };
    }

    function restoreViewportSnapshot(snapshot) {
      if (!snapshot) return false;
      const messageKey = String(snapshot?.messageKey || '');
      if (messageKey) {
        const anchorNode = messagesEl.querySelector(`.message[data-message-key="${messageKey}"]`);
        const anchorTop = Number(anchorNode?.offsetTop);
        if (anchorNode && Number.isFinite(anchorTop)) {
          messagesEl.scrollTop = Math.max(0, anchorTop + (Number(snapshot?.offsetWithinMessage) || 0));
          return true;
        }
      }
      messagesEl.scrollTop = Math.max(0, Number(snapshot?.scrollTop) || 0);
      return true;
    }

    function restoreMessageViewport(targetChatId, {
      forceBottom,
      preserveViewport,
      isSameRenderedChat,
      shouldStick,
      prevScrollTop,
      prevViewportSnapshot,
    }) {
      if (forceBottom) {
        messagesEl.scrollTop = messagesEl.scrollHeight;
      } else if (preserveViewport && isSameRenderedChat && !shouldStick) {
        restoreViewportSnapshot(prevViewportSnapshot || { scrollTop: prevScrollTop });
      } else if (chatScrollTop.has(targetChatId) && !shouldStick) {
        messagesEl.scrollTop = Math.max(0, chatScrollTop.get(targetChatId));
      } else {
        messagesEl.scrollTop = messagesEl.scrollHeight;
      }
    }

    function finalizeRenderMessages(targetChatId, history, { shouldVirtualize, forceBottom }) {
      setRenderedChatId?.(targetChatId);
      renderedHistoryLength.set(targetChatId, history.length);
      renderedHistoryVirtualized.set(targetChatId, Boolean(shouldVirtualize));
      if (shouldVirtualize) {
        updateVirtualMetrics(targetChatId);
      }

      const atBottom = isNearBottom(messagesEl, 40);
      if (forceBottom || atBottom) {
        unseenStreamChats.delete(targetChatId);
        refreshTabNode?.(targetChatId);
      }
      chatScrollTop.set(targetChatId, messagesEl.scrollTop);
      chatStickToBottom.set(targetChatId, atBottom);
      updateJumpLatestVisibility();
      if (historyCountEl) {
        historyCountEl.textContent = String(history.filter((item) => item.role !== 'system').length);
      }
    }

    function renderMessages(chatId, { preserveViewport = false, forceBottom = false, forceVirtualize = false } = {}) {
      const targetChatId = Number(chatId);
      const isSameRenderedChat = Number(getRenderedChatId?.()) === targetChatId;
      const prevScrollTop = Number(messagesEl.scrollTop || 0);
      const prevViewportSnapshot = captureViewportSnapshot();
      const wasNearBottom = isNearBottom(messagesEl, 40);
      const shouldStick = Boolean(forceBottom || (preserveViewport && isSameRenderedChat && wasNearBottom));

      const history = histories.get(targetChatId) || [];
      const shouldVirtualize = Boolean(forceVirtualize) || shouldVirtualizeHistory(history.length);
      const estimatedHeight = getEstimatedMessageHeight(targetChatId);

      if (tryAppendOnlyRender(targetChatId, history, {
        preserveViewport,
        forceBottom,
        isSameRenderedChat,
        shouldVirtualize,
        prevScrollTop,
        prevViewportSnapshot,
        wasNearBottom,
      })) {
        finalizeRenderMessages(targetChatId, history, { shouldVirtualize, forceBottom });
        if (Number(getActiveChatId?.()) === targetChatId) {
          syncLiveToolStreamForChatFn?.(targetChatId);
        }
        return;
      }

      renderTraceLogFn?.('full-render', {
        chatId: Number(targetChatId),
        reason: 'append-only-unavailable',
        preserveViewport: Boolean(preserveViewport),
        forceBottom: Boolean(forceBottom),
        shouldVirtualize,
        historyLength: history.length,
      });

      messagesEl.innerHTML = '';
      clearSelectionQuoteStateFn?.();

      if (shouldVirtualize) {
        renderVirtualizedHistory(targetChatId, history, {
          prevScrollTop,
          preserveViewport,
          forceBottom,
          shouldStick,
          estimatedHeight,
        });
      } else {
        renderFullHistory(targetChatId, history);
      }

      restoreMessageViewport(targetChatId, {
        forceBottom,
        preserveViewport,
        isSameRenderedChat,
        shouldStick,
        prevScrollTop,
        prevViewportSnapshot,
      });

      finalizeRenderMessages(targetChatId, history, { shouldVirtualize, forceBottom });
      if (Number(getActiveChatId?.()) === targetChatId) {
        syncLiveToolStreamForChatFn?.(targetChatId);
      }
    }

    return {
      isNearBottom,
      shouldVirtualizeHistory,
      getEstimatedMessageHeight,
      updateVirtualMetrics,
      updateJumpLatestVisibility,
      markStreamUpdate,
      computeVirtualRange,
      renderVirtualizedHistory,
      renderFullHistory,
      tryAppendOnlyRender,
      restoreMessageViewport,
      finalizeRenderMessages,
      renderMessages,
    };
  }
  const api = {
    createHistoryRenderController,
  };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
  global.HermesMiniappRenderTraceHistory = api;
})(typeof window !== "undefined" ? window : globalThis);
