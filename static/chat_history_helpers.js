(function initHermesMiniappChatHistory(globalScope) {
  function createSystemMessageNode({ template, nowStamp, renderBody, text }) {
    const node = template.content.firstElementChild.cloneNode(true);
    node.classList.add('message--system');
    node.querySelector('.message__role').textContent = 'system';
    node.querySelector('.message__time').textContent = nowStamp();
    renderBody(node.querySelector('.message__body'), text);
    return node;
  }

  function createMetaController(deps) {
    const {
      getActiveChatId,
      setActiveChatId,
      getRenderedChatId,
      setRenderedChatId,
      chatScrollTop,
      chatStickToBottom,
      messagesEl,
      isNearBottomFn,
      setDraft,
      promptEl,
      activeChatName,
      panelTitle,
      template,
      nowStamp,
      renderBody,
      historyCount,
      updateComposerState,
      syncPinChatButton,
      renderTabs,
      syncActiveTabSelection,
      syncLiveToolStreamForChat,
      syncActivePendingStatus,
      syncActiveLatencyChip,
      updateJumpLatestVisibility,
      getDraft,
      chats,
      scheduleTimeout,
    } = deps;
    let deferredMetaGeneration = 0;

    function setActiveChatMeta(chatId, { fullTabRender = true, deferNonCritical = false } = {}) {
      deferredMetaGeneration += 1;
      const metaGeneration = deferredMetaGeneration;
      const previousActiveRaw = getActiveChatId();
      const hadPreviousActive = previousActiveRaw != null;
      const previousActiveChatId = Number(previousActiveRaw);
      if (hadPreviousActive && Number(getRenderedChatId()) === previousActiveChatId) {
        chatScrollTop.set(previousActiveChatId, messagesEl.scrollTop);
        chatStickToBottom.set(previousActiveChatId, isNearBottomFn(messagesEl));
      }
      if (hadPreviousActive && previousActiveChatId) {
        setDraft(previousActiveChatId, promptEl.value || '');
      }

      const nextActiveChatId = Number(chatId || 0);
      if (!nextActiveChatId) {
        setActiveChatId(null);
        promptEl.value = '';
        activeChatName.textContent = 'None';
        panelTitle.textContent = 'Conversation';
        messagesEl.innerHTML = '';
        messagesEl.appendChild(createSystemMessageNode({
          template,
          nowStamp,
          renderBody,
          text: 'No chats open. Start a new chat to continue.',
        }));
        historyCount.textContent = '0';
        setRenderedChatId(null);
        updateComposerState();
        syncPinChatButton();
        renderTabs();
        syncLiveToolStreamForChat(null);
        syncActivePendingStatus();
        syncActiveLatencyChip();
        updateJumpLatestVisibility();
        return;
      }

      setActiveChatId(nextActiveChatId);
      promptEl.value = getDraft(nextActiveChatId);
      const chat = chats.get(nextActiveChatId);
      const title = chat?.title || 'Chat';
      activeChatName.textContent = title;
      panelTitle.textContent = `Conversation · ${title}`;
      updateComposerState();
      syncPinChatButton();

      if (fullTabRender) {
        renderTabs();
      } else {
        syncActiveTabSelection(previousActiveChatId, nextActiveChatId);
      }

      const syncCriticalMeta = () => {
        syncActivePendingStatus();
        syncActiveLatencyChip();
      };

      const finalizeMeta = () => {
        if (metaGeneration !== deferredMetaGeneration) {
          return;
        }
        if (Number(getActiveChatId()) !== nextActiveChatId) {
          return;
        }
        syncLiveToolStreamForChat(nextActiveChatId);
        updateJumpLatestVisibility();
      };

      if (deferNonCritical) {
        syncCriticalMeta();
        scheduleTimeout(finalizeMeta, 0);
      } else {
        syncLiveToolStreamForChat(nextActiveChatId);
        syncCriticalMeta();
        updateJumpLatestVisibility();
      }
    }

    function setNoActiveChatMeta() {
      setActiveChatMeta(null);
    }

    return {
      setActiveChatMeta,
      setNoActiveChatMeta,
    };
  }


  function normalizeChatId(chatId) {
    return Number(chatId);
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

  function hasVisibleAssistantLikeTranscript(entries) {
    const items = Array.isArray(entries) ? entries : [];
    return items.some((item) => {
      const role = String(item?.role || '').toLowerCase();
      if (role !== 'assistant' && role !== 'hermes') return false;
      return String(item?.body || '').trim().length > 0;
    });
  }

  function hydratedCompletionMatchesVisibleLocalPending(previousHistory, nextHistory) {
    const completedBody = latestAssistantLikeBody(nextHistory, { pending: false });
    if (!completedBody) return false;
    const pendingBody = latestAssistantLikeBody(previousHistory, { pending: true });
    if (pendingBody) {
      return completedBody === pendingBody;
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

  function historiesDiffer(currentHistory, incomingHistory) {
    const a = currentHistory || [];
    const b = incomingHistory || [];
    if (a.length !== b.length) return true;
    if (!a.length) return false;

    const aLast = a[a.length - 1] || {};
    const bLast = b[b.length - 1] || {};
    return aLast.id !== bLast.id || aLast.body !== bLast.body || aLast.role !== bLast.role;
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

  function createUnreadStateController(deps) {
    const {
      chats,
      upsertChat,
      getActiveChatId,
      hasReachedNewestUnreadMessageBottom,
    } = deps;

    const optimisticUnreadClears = new Map();

    function getCurrentUnreadCount(chatId) {
      const key = normalizeChatId(chatId);
      const optimisticUnread = optimisticUnreadClears.get(key);
      if (Number.isFinite(optimisticUnread)) {
        return Math.max(0, Number(optimisticUnread));
      }
      return Math.max(0, Number(chats.get(key)?.unread_count || 0));
    }

    function clearUnreadCount(chatId) {
      const key = normalizeChatId(chatId);
      const chat = chats.get(key);
      if (!chat) return;
      const unread = Math.max(0, Number(chat.unread_count || 0));
      if (!optimisticUnreadClears.has(key)) {
        optimisticUnreadClears.set(key, unread);
      }
      chat.unread_count = 0;
    }

    function restoreUnreadCount(chatId) {
      const key = normalizeChatId(chatId);
      const chat = chats.get(key);
      const previousUnread = optimisticUnreadClears.get(key);
      optimisticUnreadClears.delete(key);
      if (!chat || !Number.isFinite(previousUnread)) return;
      chat.unread_count = Math.max(0, Number(previousUnread));
    }

    function finalizeUnreadClear(chatId) {
      const key = normalizeChatId(chatId);
      optimisticUnreadClears.delete(key);
    }

    function buildChatPreservingUnread(chat, { preserveActivationUnread = false } = {}) {
      if (!chat || typeof chat !== 'object') {
        return chat;
      }
      const key = normalizeChatId(chat.id);
      if (!key) {
        return chat;
      }
      const nextChat = { ...chat };
      if (preserveActivationUnread) {
        const localChat = chats.get(key) || null;
        const localUnread = Math.max(0, Number(localChat?.unread_count || 0));
        const localUnreadAnchor = Math.max(0, Number(localChat?.newest_unread_message_id || 0));
        const incomingUnread = Math.max(0, Number(nextChat.unread_count || 0));
        const activeUnreadAboveNewestMessage = Boolean(
          key === normalizeChatId(getActiveChatId())
          && localUnread > incomingUnread
          && !hasReachedNewestUnreadMessageBottom(key, { tolerance: 40 })
        );
        if (activeUnreadAboveNewestMessage && localUnread > incomingUnread) {
          nextChat.unread_count = localUnread;
          nextChat.newest_unread_message_id = localUnreadAnchor;
        }
      }
      return nextChat;
    }

    function upsertChatPreservingUnread(chat, options = {}) {
      return upsertChat(buildChatPreservingUnread(chat, options));
    }

    return {
      getCurrentUnreadCount,
      clearUnreadCount,
      restoreUnreadCount,
      finalizeUnreadClear,
      buildChatPreservingUnread,
      upsertChatPreservingUnread,
    };
  }

  function createUnreadAnchorController({ chats, isNearBottomFn, messagesContainer }) {
    function getUnreadAnchorMessageId(chatId) {
      const key = normalizeChatId(chatId);
      return Math.max(0, Number(chats.get(key)?.newest_unread_message_id || 0));
    }

    function getMessageBottomOffset(node, container) {
      if (!node || !container) return null;

      const offsetTop = Number(node?.offsetTop);
      const offsetHeight = Number(node?.offsetHeight);
      if (Number.isFinite(offsetTop) && Number.isFinite(offsetHeight)) {
        return Math.max(0, offsetTop + offsetHeight);
      }

      const nodeBottom = Number(node?.dataset?.bottomOffset || node?.bottomOffset);
      if (Number.isFinite(nodeBottom)) {
        return Math.max(0, nodeBottom);
      }

      const containerRect = container?.getBoundingClientRect?.();
      const nodeRect = node?.getBoundingClientRect?.();
      const scrollTop = Number(container?.scrollTop);
      const containerTop = Number(containerRect?.top);
      const nodeRectBottom = Number(nodeRect?.bottom);
      if (Number.isFinite(scrollTop) && Number.isFinite(containerTop) && Number.isFinite(nodeRectBottom)) {
        return Math.max(0, scrollTop + (nodeRectBottom - containerTop));
      }

      return null;
    }

    function findNewestUnreadMessageNode(chatId) {
      const container = messagesContainer;
      if (!container || typeof container.querySelectorAll !== 'function') {
        return { node: null, anchorMessageId: getUnreadAnchorMessageId(chatId) };
      }
      const assistantNodes = container.querySelectorAll('.message[data-role="assistant"]:not(.message--pending), .message[data-role="hermes"]:not(.message--pending)');
      const anchorMessageId = getUnreadAnchorMessageId(chatId);
      if (anchorMessageId > 0) {
        for (let index = assistantNodes.length - 1; index >= 0; index -= 1) {
          const candidate = assistantNodes[index];
          if (Number(candidate?.dataset?.messageId || 0) === anchorMessageId) {
            return { node: candidate, anchorMessageId };
          }
        }
        return { node: null, anchorMessageId };
      }
      return {
        node: assistantNodes?.[assistantNodes.length - 1] || null,
        anchorMessageId,
      };
    }

    function hasReachedNewestUnreadMessageBottom(chatId, { tolerance = 40 } = {}) {
      const key = normalizeChatId(chatId);
      const unread = Math.max(0, Number(chats.get(key)?.unread_count || 0));
      if (unread <= 0) return true;
      const container = messagesContainer;
      if (!container || typeof container.querySelectorAll !== 'function') {
        return isNearBottomFn(messagesContainer, tolerance);
      }

      const { node: newestUnreadNode, anchorMessageId } = findNewestUnreadMessageNode(key);
      if (!newestUnreadNode) {
        if (anchorMessageId > 0) {
          return false;
        }
        return isNearBottomFn(messagesContainer, tolerance);
      }

      const viewportBottom = Number(container.scrollTop) + Number(container.clientHeight || container.offsetHeight || 0);
      const messageBottom = getMessageBottomOffset(newestUnreadNode, container);
      if (!Number.isFinite(viewportBottom) || !Number.isFinite(messageBottom)) {
        return isNearBottomFn(messagesContainer, tolerance);
      }
      return viewportBottom + tolerance >= messageBottom;
    }

    return {
      getUnreadAnchorMessageId,
      hasReachedNewestUnreadMessageBottom,
    };
  }

  function createActivationReadThresholdController({ chats }, anchorController) {
    const activationReadThresholdState = new Map();
    const {
      getUnreadAnchorMessageId,
      hasReachedNewestUnreadMessageBottom,
    } = anchorController;

    function clearActivationReadThreshold(chatId) {
      activationReadThresholdState.delete(normalizeChatId(chatId));
    }

    function armActivationReadThreshold(chatId, unreadCount = null) {
      const key = normalizeChatId(chatId);
      if (!key) return;
      const unread = unreadCount == null
        ? Math.max(0, Number(chats.get(key)?.unread_count || 0))
        : Math.max(0, Number(unreadCount || 0));
      if (unread > 0) {
        const reachedBottomAtActivation = hasReachedNewestUnreadMessageBottom(key, { tolerance: 40 });
        activationReadThresholdState.set(key, {
          anchorMessageId: getUnreadAnchorMessageId(key),
          hasBeenAboveThreshold: !reachedBottomAtActivation,
        });
        return;
      }
      clearActivationReadThreshold(key);
    }

    function ensureActivationReadThreshold(chatId, unreadCount = null) {
      const key = normalizeChatId(chatId);
      if (!key) return false;
      const unread = unreadCount == null
        ? Math.max(0, Number(chats.get(key)?.unread_count || 0))
        : Math.max(0, Number(unreadCount || 0));
      if (unread <= 0) {
        clearActivationReadThreshold(key);
        return false;
      }
      const anchorMessageId = getUnreadAnchorMessageId(key);
      const existing = activationReadThresholdState.get(key);
      if (existing && Number(existing.anchorMessageId || 0) === anchorMessageId) {
        return true;
      }
      const reachedBottomAtActivation = hasReachedNewestUnreadMessageBottom(key, { tolerance: 40 });
      activationReadThresholdState.set(key, {
        anchorMessageId,
        hasBeenAboveThreshold: !reachedBottomAtActivation,
      });
      return true;
    }

    function hasSatisfiedActivationReadThreshold(chatId, { reachedBottom = false, force = false } = {}) {
      const key = normalizeChatId(chatId);
      const state = activationReadThresholdState.get(key);
      if (!state) return true;
      if (force) {
        clearActivationReadThreshold(key);
        return true;
      }
      const currentAnchorMessageId = getUnreadAnchorMessageId(key);
      if (Number(state.anchorMessageId || 0) !== currentAnchorMessageId) {
        const reachedBottomAtActivation = hasReachedNewestUnreadMessageBottom(key, { tolerance: 40 });
        activationReadThresholdState.set(key, {
          anchorMessageId: currentAnchorMessageId,
          hasBeenAboveThreshold: !reachedBottomAtActivation,
        });
        return false;
      }
      if (!reachedBottom) {
        state.hasBeenAboveThreshold = true;
        return false;
      }
      if (!state.hasBeenAboveThreshold) {
        return false;
      }
      clearActivationReadThreshold(key);
      return true;
    }

    return {
      clearActivationReadThreshold,
      armActivationReadThreshold,
      ensureActivationReadThreshold,
      hasSatisfiedActivationReadThreshold,
      hasActivationReadThreshold(chatId) {
        return activationReadThresholdState.has(normalizeChatId(chatId));
      },
    };
  }

  function createReadThresholdController(deps, unreadStateController) {
    const {
      chats,
      isNearBottomFn,
      messagesContainer,
    } = deps;

    const anchorController = createUnreadAnchorController({
      chats,
      isNearBottomFn,
      messagesContainer,
    });
    const activationController = createActivationReadThresholdController({ chats }, anchorController);

    return {
      getUnreadAnchorMessageId: anchorController.getUnreadAnchorMessageId,
      hasReachedNewestUnreadMessageBottom: anchorController.hasReachedNewestUnreadMessageBottom,
      clearActivationReadThreshold: activationController.clearActivationReadThreshold,
      hasActivationReadThreshold: activationController.hasActivationReadThreshold,
      armActivationReadThreshold: activationController.armActivationReadThreshold,
      ensureActivationReadThreshold: activationController.ensureActivationReadThreshold,
      hasSatisfiedActivationReadThreshold: activationController.hasSatisfiedActivationReadThreshold,
    };
  }

  function createReadRequestController(deps, unreadStateController, thresholdController) {
    const {
      apiPost,
      chats,
      getActiveChatId,
      getIsAuthenticated,
      unseenStreamChats,
      markReadInFlight,
      renderTabs,
      syncActivePendingStatus,
      updateComposerState,
      pendingChats,
      hasLiveStreamController,
      upsertChat,
    } = deps;
    const {
      getCurrentUnreadCount,
      clearUnreadCount,
      restoreUnreadCount,
      finalizeUnreadClear,
    } = unreadStateController;
    const {
      clearActivationReadThreshold,
      hasReachedNewestUnreadMessageBottom,
      hasSatisfiedActivationReadThreshold,
    } = thresholdController;

    const deferredMarkReadRetry = new Map();

    function isActiveChat(chatId) {
      return normalizeChatId(chatId) === normalizeChatId(getActiveChatId());
    }

    async function markRead(chatId) {
      const key = normalizeChatId(chatId);
      const data = await apiPost('/api/chats/mark-read', { chat_id: key });
      finalizeUnreadClear(key);
      clearActivationReadThreshold(key);
      const localChat = chats.get(key);
      const shouldPreservePending = Boolean(
        pendingChats.has(key)
        || localChat?.pending
        || hasLiveStreamController(key)
      );
      const nextChat = data?.chat && typeof data.chat === 'object'
        ? { ...data.chat }
        : data?.chat;
      if (shouldPreservePending && nextChat && typeof nextChat === 'object') {
        nextChat.pending = true;
      }
      upsertChat(nextChat);
      renderTabs();
      if (isActiveChat(key)) {
        syncActivePendingStatus();
        updateComposerState();
      }
    }

    function shouldMarkReadNow(chatId, { force = false, requireUnread = true } = {}) {
      const key = normalizeChatId(chatId);
      if (!key || !getIsAuthenticated() || !isActiveChat(key)) {
        return false;
      }
      if (!force) {
        if (unseenStreamChats.has(key)) return false;
        if (requireUnread) {
          const unread = getCurrentUnreadCount(key);
          if (unread <= 0) return false;
        }
        const reachedBottom = hasReachedNewestUnreadMessageBottom(key, { tolerance: 40 });
        if (!hasSatisfiedActivationReadThreshold(key, { reachedBottom, force: false })) return false;
        if (!reachedBottom) return false;
      }
      return true;
    }

    function rememberDeferredMarkRead(chatId, { force = false } = {}) {
      const key = normalizeChatId(chatId);
      const existing = deferredMarkReadRetry.get(key);
      deferredMarkReadRetry.set(key, { force: Boolean(existing?.force || force) });
    }

    function consumeDeferredMarkRead(chatId) {
      const key = normalizeChatId(chatId);
      const deferred = deferredMarkReadRetry.get(key) || null;
      deferredMarkReadRetry.delete(key);
      return deferred;
    }

    function startMarkReadRequest(chatId, { force = false } = {}) {
      const key = normalizeChatId(chatId);
      clearUnreadCount(key);
      renderTabs();
      if (isActiveChat(key)) {
        syncActivePendingStatus();
        updateComposerState();
      }
      markReadInFlight.add(key);
      void markRead(key)
        .catch(() => {
          restoreUnreadCount(key);
          renderTabs();
          if (isActiveChat(key)) {
            syncActivePendingStatus();
            updateComposerState();
          }
        })
        .finally(() => {
          markReadInFlight.delete(key);
          const deferred = consumeDeferredMarkRead(key);
          if (deferred && shouldMarkReadNow(key, { ...deferred, requireUnread: false })) {
            startMarkReadRequest(key, deferred);
          }
        });
    }

    function maybeMarkRead(chatId, { force = false } = {}) {
      const key = normalizeChatId(chatId);
      if (!shouldMarkReadNow(key, { force })) {
        return;
      }
      if (markReadInFlight.has(key)) {
        rememberDeferredMarkRead(key, { force });
        return;
      }
      startMarkReadRequest(key, { force });
    }

    return {
      markRead,
      maybeMarkRead,
      isActiveChat,
    };
  }

  function createUnreadPreservationController({ chats, getActiveChatId }, unreadStateController, thresholdController) {
    function buildChatPreservingUnread(chat, { preserveActivationUnread = false } = {}) {
      if (!preserveActivationUnread) {
        return unreadStateController.buildChatPreservingUnread(chat, { preserveActivationUnread: false });
      }
      const nextChat = unreadStateController.buildChatPreservingUnread(chat, { preserveActivationUnread });
      const key = normalizeChatId(nextChat?.id);
      if (!key) {
        return nextChat;
      }
      const localChat = chats.get(key) || null;
      const localUnread = Math.max(0, Number(localChat?.unread_count || 0));
      const localUnreadAnchor = Math.max(0, Number(localChat?.newest_unread_message_id || 0));
      const incomingUnread = Math.max(0, Number(nextChat?.unread_count || 0));
      const activeUnreadAboveNewestMessage = Boolean(
        key === normalizeChatId(getActiveChatId())
        && localUnread > incomingUnread
        && !thresholdController.hasReachedNewestUnreadMessageBottom(key, { tolerance: 40 })
      );
      if ((thresholdController.hasActivationReadThreshold(key) || activeUnreadAboveNewestMessage) && localUnread > incomingUnread) {
        nextChat.unread_count = localUnread;
        nextChat.newest_unread_message_id = localUnreadAnchor;
      }
      return nextChat;
    }

    return {
      buildChatPreservingUnread,
    };
  }

  function createReadSyncController(deps) {
    const {
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
    } = deps;

    const thresholdControllerRef = { current: null };
    const unreadStateController = createUnreadStateController({
      chats,
      upsertChat,
      getActiveChatId,
      hasReachedNewestUnreadMessageBottom: (...args) => thresholdControllerRef.current.hasReachedNewestUnreadMessageBottom(...args),
    });
    const thresholdController = createReadThresholdController({
      chats,
      isNearBottomFn,
      messagesContainer,
    }, unreadStateController);
    thresholdControllerRef.current = thresholdController;
    const requestController = createReadRequestController({
      ...deps,
      getIsAuthenticated,
      unseenStreamChats,
      markReadInFlight,
      renderTabs,
      syncActivePendingStatus,
      updateComposerState,
      pendingChats,
      hasLiveStreamController,
    }, unreadStateController, thresholdController);
    const unreadPreservationController = createUnreadPreservationController({
      chats,
      getActiveChatId,
    }, unreadStateController, thresholdController);

    function buildChatPreservingUnread(chat, { preserveActivationUnread = false } = {}) {
      return unreadPreservationController.buildChatPreservingUnread(chat, { preserveActivationUnread });
    }

    function upsertChatPreservingUnread(chat, options = {}) {
      return upsertChat(buildChatPreservingUnread(chat, options));
    }

    return {
      buildChatPreservingUnread,
      upsertChatPreservingUnread,
      getCurrentUnreadCount: unreadStateController.getCurrentUnreadCount,
      armActivationReadThreshold: thresholdController.armActivationReadThreshold,
      ensureActivationReadThreshold: thresholdController.ensureActivationReadThreshold,
      markRead: requestController.markRead,
      maybeMarkRead: requestController.maybeMarkRead,
      hasLocalPendingWithoutLiveStream(chatId, history) {
        const key = normalizeChatId(chatId);
        if (!key || hasLiveStreamController(key)) {
          return false;
        }
        return hasLocalPendingTranscript(history);
      },
      finalizeHydratedPendingState(chatId) {
        unreadStateController.finalizeUnreadClear(chatId);
        thresholdController.clearActivationReadThreshold(chatId);
      },
    };
  }

  function createLocalMutationController(deps) {
    const {
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
    } = deps;

    const activeRenderState = {
      scheduled: false,
      chatId: null,
    };

    function addLocalMessage(chatId, message) {
      const key = normalizeChatId(chatId);
      const history = histories.get(key) || [];
      history.push(message);
      histories.set(key, history);
    }

    function appendSystemMessage(text, chatIdOverride = null) {
      const targetChatId = normalizeChatId(chatIdOverride) || normalizeChatId(getActiveChatId());
      if (!targetChatId) {
        messagesEl?.appendChild?.(createSystemMessageNode({
          template,
          nowStamp,
          renderBody,
          text,
        }));
        return;
      }
      addLocalMessage(targetChatId, { role: 'system', body: text, created_at: new Date().toISOString() });
      if (targetChatId === normalizeChatId(getActiveChatId())) {
        renderMessages(targetChatId);
      }
    }

    function updatePendingAssistant(chatId, nextBody, pendingState = true) {
      const key = normalizeChatId(chatId);
      const history = histories.get(key) || [];
      let pendingMessage = null;
      for (let index = history.length - 1; index >= 0; index -= 1) {
        const item = history[index];
        if (!item?.pending) continue;
        const role = String(item?.role || '').toLowerCase();
        if (role !== 'hermes' && role !== 'assistant') {
          continue;
        }
        pendingMessage = item;
        break;
      }

      if (!pendingMessage) {
        const safeBody = String(nextBody || '').trim();
        if (!safeBody && !pendingState) {
          return;
        }
        if (!pendingState) {
          const latestCompletedAssistant = [...history].reverse().find((item) => {
            if (!item || item.pending) return false;
            const role = String(item.role || '').toLowerCase();
            if (role !== 'hermes' && role !== 'assistant') {
              return false;
            }
            return String(item.body || '').trim() === safeBody;
          });
          if (latestCompletedAssistant) {
            clearPendingStreamSnapshot?.(key);
            return;
          }
        }
        history.push({
          role: 'hermes',
          body: nextBody,
          created_at: new Date().toISOString(),
          pending: pendingState,
        });
        histories.set(key, history);
        persistPendingStreamSnapshot?.(key);
        if (!pendingState) {
          clearPendingStreamSnapshot?.(key);
        }
        return;
      }

      pendingMessage.body = nextBody;
      pendingMessage.pending = pendingState;
      histories.set(key, history);
      persistPendingStreamSnapshot?.(key);
      if (!pendingState) {
        clearPendingStreamSnapshot?.(key);
      }
    }

    function syncActiveMessageView(chatId, options = {}) {
      if (!isActiveChat(chatId)) return;
      renderMessages(chatId, options);
    }

    function scheduleActiveMessageView(chatId) {
      if (!isActiveChat(chatId)) return;
      activeRenderState.chatId = normalizeChatId(chatId);
      if (activeRenderState.scheduled) return;
      activeRenderState.scheduled = true;
      enqueueUiMutation(() => {
        activeRenderState.scheduled = false;
        const targetChatId = activeRenderState.chatId;
        activeRenderState.chatId = null;
        if (targetChatId == null || !isActiveChat(targetChatId)) return;
        renderMessages(targetChatId, { preserveViewport: true });
      });
    }

    return {
      addLocalMessage,
      appendSystemMessage,
      updatePendingAssistant,
      syncActiveMessageView,
      scheduleActiveMessageView,
    };
  }

  function createHistoryFetchController(deps) {
    const {
      apiPost,
      histories,
      chats,
      prefetchingHistories,
      upsertChatPreservingUnread,
      shouldDeferNonCriticalCachedOpen,
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

    function isLaggingPrefetchResult(chatId, chat) {
      const key = normalizeChatId(chatId);
      if (!key || !chat || typeof chat !== 'object') {
        return false;
      }
      const localChat = chats?.get?.(key) || null;
      if (!localChat || typeof localChat !== 'object') {
        return false;
      }
      const localUnread = Math.max(0, Number(localChat.unread_count || 0));
      const incomingUnread = Math.max(0, Number(chat.unread_count || 0));
      if (localUnread > incomingUnread) {
        return true;
      }
      const localUnreadAnchor = Math.max(0, Number(localChat.newest_unread_message_id || 0));
      const incomingUnreadAnchor = Math.max(0, Number(chat.newest_unread_message_id || 0));
      if (localUnreadAnchor > incomingUnreadAnchor) {
        return true;
      }
      return Boolean(localChat.pending) && !Boolean(chat.pending);
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
          const activeNow = isActiveChat(key);
          const cacheFilledElsewhere = histories.has(key);
          const laggingPrefetchResult = isLaggingPrefetchResult(key, data?.chat);
          if (activeNow || cacheFilledElsewhere || laggingPrefetchResult) {
            traceChatHistory('prefetch-skipped-commit', {
              chatId: key,
              activeNow,
              cacheFilledElsewhere,
              laggingPrefetchResult,
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

  function createHistoryPendingStateController(deps) {
    const {
      histories,
      hasLiveStreamController,
      mergeHydratedHistory,
      restorePendingStreamSnapshot,
      hasFreshPendingStreamSnapshot,
      finalizeHydratedPendingState,
      hasLocalPendingWithoutLiveStream,
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
    } = deps;

    function buildHydrationRenderState({
      targetChatId,
      previousHistory,
      finalHistory,
      hadCachedHistory,
      historyChanged,
      restoredPendingSnapshot,
    }) {
      const nextRenderSignature = historyRenderSignature(finalHistory);
      const previousRenderSignature = historyRenderSignature(previousHistory);
      const renderedTranscriptSignature = typeof getRenderedTranscriptSignature === 'function'
        ? String(getRenderedTranscriptSignature(targetChatId) || '')
        : '';
      const shouldForceStaleRenderedTranscriptRender = Boolean(
        renderedTranscriptSignature
        && renderedTranscriptSignature !== nextRenderSignature
      );
      const currentUnread = Math.max(0, Number(chats.get(targetChatId)?.unread_count || 0));
      const shouldForceUnreadTranscriptRender = Boolean(
        hadCachedHistory
        && !historyChanged
        && !restoredPendingSnapshot
        && currentUnread > 0
        && hasVisibleAssistantLikeTranscript(finalHistory)
      );
      const shouldRenderActiveHistory = previousRenderSignature !== nextRenderSignature
        || restoredPendingSnapshot
        || shouldForceUnreadTranscriptRender
        || shouldForceStaleRenderedTranscriptRender;
      return {
        currentUnread,
        nextRenderSignature,
        previousRenderSignature,
        renderedTranscriptSignature,
        shouldForceUnreadTranscriptRender,
        shouldForceStaleRenderedTranscriptRender,
        shouldRenderActiveHistory,
      };
    }

    return {
      buildHydrationRenderState,
    };
  }

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
      upsertChatPreservingUnread(nextData.chat, { preserveActivationUnread: true });
      let pendingState = pendingStateController.derivePendingState(targetChatId, previousHistory, nextData);
      let preservePendingState = pendingState.preservePendingState;
      let hydrationResult = pendingStateController.applyHydratedHistory(
        targetChatId,
        previousHistory,
        nextData.history || [],
        preservePendingState,
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
        upsertChatPreservingUnread(nextData.chat, { preserveActivationUnread: true });
        pendingState = pendingStateController.derivePendingState(targetChatId, previousHistory, nextData);
        preservePendingState = pendingState.preservePendingState;
        hydrationResult = pendingStateController.applyHydratedHistory(
          targetChatId,
          previousHistory,
          nextData.history || [],
          preservePendingState,
        );
      }
      return {
        data: nextData,
        pendingState,
        preservePendingState,
        ...hydrationResult,
      };
    }

    return {
      applyHydratedServerState,
    };
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
      if (!matchedVisibleHydratedCompletion && (needsVisibilityResume || serverPendingWithoutLiveStream || localPendingWithoutLiveStream || needsSnapshotResume)) {
        const shouldForceResume = localPendingWithoutLiveStream || needsSnapshotResume;
        void resumePendingChatStream(activeChatId, shouldForceResume ? { force: true } : undefined);
      }
    }

    return {
      maybeResumeVisibilitySync,
    };
  }

  function createCachedOpenController(deps, hydrationController) {
    const {
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
      chats,
    } = deps;

    function shouldPrioritizeCachedHydration(chatId) {
      const key = normalizeChatId(chatId);
      if (!key) return false;
      const chat = chats?.get?.(key) || null;
      if (!chat || typeof chat !== 'object') return false;
      return Math.max(0, Number(chat.unread_count || 0)) > 0
        || Math.max(0, Number(chat.newest_unread_message_id || 0)) > 0
        || Boolean(chat.pending);
    }

    function renderCachedChat({ targetChatId, requestId, openStartedAtMs, shouldDeferMeta }) {
      if (requestId !== getLastOpenChatRequestId()) {
        traceChatHistory('cached-render-skipped-stale-request', {
          chatId: targetChatId,
          requestId,
          latestRequestId: Number(getLastOpenChatRequestId()) || 0,
        });
        return;
      }
      if (!isActiveChat(targetChatId)) {
        traceChatHistory('cached-render-skipped-inactive', {
          chatId: targetChatId,
          requestId,
          activeChatId: normalizeChatId(getActiveChatId()),
        });
        return;
      }
      traceChatHistory('cached-render-commit', {
        chatId: targetChatId,
        requestId,
        deferred: shouldDeferMeta,
        durationMs: Math.max(0, Math.round(nowMs() - openStartedAtMs)),
      });
      renderMessages(targetChatId);
    }

    function hydrateCachedChat({ targetChatId, requestId, openStartedAtMs }) {
      if (requestId !== getLastOpenChatRequestId()) {
        traceChatHistory('cached-hydrate-skipped-stale-request', {
          chatId: targetChatId,
          requestId,
          latestRequestId: Number(getLastOpenChatRequestId()) || 0,
        });
        return;
      }
      if (!isActiveChat(targetChatId)) {
        traceChatHistory('cached-hydrate-skipped-inactive', {
          chatId: targetChatId,
          requestId,
          activeChatId: normalizeChatId(getActiveChatId()),
        });
        return;
      }
      traceChatHistory('cached-hydrate-begin', {
        chatId: targetChatId,
        requestId,
        durationMs: Math.max(0, Math.round(nowMs() - openStartedAtMs)),
      });
      void hydrationController.hydrateChatFromServer(targetChatId, requestId, true).catch(() => {
      });
    }

    function openCachedChat(targetChatId, requestId, openStartedAtMs) {
      const shouldDeferMeta = Boolean(shouldDeferNonCriticalCachedOpen(targetChatId));
      const prioritizeHydration = shouldPrioritizeCachedHydration(targetChatId);
      setActiveChatMeta(targetChatId, { fullTabRender: false, deferNonCritical: shouldDeferMeta });
      const renderCached = () => renderCachedChat({ targetChatId, requestId, openStartedAtMs, shouldDeferMeta });
      if (shouldDeferMeta) {
        enqueueUiMutation(renderCached);
      } else {
        renderCached();
      }

      const hydrate = () => hydrateCachedChat({ targetChatId, requestId, openStartedAtMs });
      if (shouldDeferMeta && typeof requestIdle === 'function' && !prioritizeHydration) {
        traceChatHistory('cached-hydrate-scheduled', {
          chatId: targetChatId,
          requestId,
          mode: 'idle',
          timeoutMs: 250,
          prioritizeHydration,
        });
        requestIdle(hydrate, { timeout: 250 });
      } else {
        const delayMs = prioritizeHydration ? 0 : (shouldDeferMeta ? 32 : 0);
        traceChatHistory('cached-hydrate-scheduled', {
          chatId: targetChatId,
          requestId,
          mode: 'timeout',
          delayMs,
          prioritizeHydration,
        });
        scheduleTimeout(hydrate, delayMs);
      }
    }

    return {
      openCachedChat,
    };
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
      finalizeHydratedPendingState,
      traceChatHistory,
      nowMs,
      syncUnreadNotificationPresence,
      getDocumentVisibilityState = () => 'visible',
      buildChatPreservingUnread,
      upsertChatPreservingUnread,
      ensureActivationReadThreshold,
      maybeMarkRead,
      isActiveChat,
      hasLocalPendingWithoutLiveStream,
      getRenderedTranscriptSignature = null,
    } = deps;

    const pendingStateController = createHistoryPendingStateController(deps);
    const renderDecisionController = createHistoryRenderDecisionController(deps);
    const retryController = createUnreadHydrationRetryController();
    const hydrationApplyController = createHydrationApplyController({
      loadChatHistory,
      upsertChatPreservingUnread,
      traceChatHistory,
    }, pendingStateController, retryController);
    const visibilityResumeController = createVisibilityResumeController({
      hasLiveStreamController,
      resumePendingChatStream,
      shouldResumeOnVisibilityChange,
    });
    let visibleSyncGeneration = 0;

    async function hydrateChatFromServer(targetChatId, requestId, hadCachedHistory) {
      const hydrateStartedAtMs = nowMs();
      traceChatHistory('hydrate-start', {
        chatId: targetChatId,
        requestId: Number(requestId) || 0,
        hadCachedHistory: Boolean(hadCachedHistory),
        activeAtStart: isActiveChat(targetChatId),
      });
      let data = await loadChatHistory(targetChatId, { activate: true });

      if (requestId !== getLastOpenChatRequestId()) {
        traceChatHistory('hydrate-skipped-stale-request', {
          chatId: targetChatId,
          requestId: Number(requestId) || 0,
          latestRequestId: Number(getLastOpenChatRequestId()) || 0,
          hadCachedHistory: Boolean(hadCachedHistory),
          durationMs: Math.max(0, Math.round(nowMs() - hydrateStartedAtMs)),
        });
        return;
      }

      const previousHistory = histories.get(targetChatId) || [];
      let restoredPendingSnapshot;
      let finalHistory;
      let historyChanged;
      let pendingState;
      const hydrationState = await hydrationApplyController.applyHydratedServerState({
        targetChatId,
        previousHistory,
        data,
        requestId,
        retryEventName: 'hydrate-unread-retry',
        retryActivate: false,
      });
      ({
        data,
        restoredPendingSnapshot,
        finalHistory,
        historyChanged,
        pendingState,
      } = hydrationState);
      const shouldResumePending = pendingState.shouldResumePending;
      const shouldForceResumePending = pendingState.shouldForceResumePending;

      refreshTabNode(targetChatId);
      const renderState = renderDecisionController.buildHydrationRenderState({
        targetChatId,
        previousHistory,
        finalHistory,
        hadCachedHistory,
        historyChanged,
        restoredPendingSnapshot,
      });
      const {
        shouldForceUnreadTranscriptRender,
        shouldForceStaleRenderedTranscriptRender,
      } = renderState;

      traceChatHistory('hydrate-applied', {
        chatId: targetChatId,
        requestId: Number(requestId) || 0,
        hadCachedHistory: Boolean(hadCachedHistory),
        activeAtApply: isActiveChat(targetChatId),
        previousHistoryCount: previousHistory.length,
        nextHistoryCount: finalHistory.length,
        historyChanged,
        restoredPendingSnapshot: Boolean(restoredPendingSnapshot),
        shouldForceUnreadTranscriptRender,
        shouldForceStaleRenderedTranscriptRender,
        shouldResumePending: Boolean(shouldResumePending),
        durationMs: Math.max(0, Math.round(nowMs() - hydrateStartedAtMs)),
      });

      if (!isActiveChat(targetChatId)) {
        setActiveChatMeta(targetChatId);
        renderMessages(targetChatId);
        if (shouldResumePending) {
          void resumePendingChatStream(
            targetChatId,
            shouldForceResumePending ? { force: true } : undefined,
          );
        }
        return;
      }

      if (!hadCachedHistory || historyChanged || restoredPendingSnapshot || shouldForceUnreadTranscriptRender || shouldForceStaleRenderedTranscriptRender) {
        renderMessages(targetChatId, { preserveViewport: hadCachedHistory });
      }
      if (shouldResumePending) {
        void resumePendingChatStream(
          targetChatId,
          shouldForceResumePending ? { force: true } : undefined,
        );
      }
    }

    async function syncVisibleActiveChat(options = {}) {
      const {
        hidden = false,
        streamAbortControllers = new Map(),
      } = options;
      const activeChatId = getActiveChatId();
      if (!activeChatId) return;

      const activeId = normalizeChatId(activeChatId);
      if (!activeId) return;
      const visibleRequestId = visibleSyncGeneration + 1;
      visibleSyncGeneration = visibleRequestId;
      const activateVisibleChat = !hidden;

      let data = await loadChatHistory(activeId, { activate: activateVisibleChat });
      const latestActiveId = normalizeChatId(getActiveChatId());
      if (latestActiveId !== activeId || visibleRequestId !== visibleSyncGeneration) return;
      const previousHistory = histories.get(activeId) || [];
      let restoredPendingSnapshot;
      let finalHistory;
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
        pendingState,
      } = hydrationState);
      if (visibleRequestId !== visibleSyncGeneration || normalizeChatId(getActiveChatId()) !== activeId) return;
      const chatPending = pendingState.chatPending;
      const localPendingWithoutLiveStream = pendingState.localPendingWithoutLiveStream;
      const snapshotPendingWithoutLiveStream = pendingState.snapshotPendingWithoutLiveStream;
      const matchedVisibleHydratedCompletion = pendingState.matchedVisibleHydratedCompletion;
      const renderState = renderDecisionController.buildHydrationRenderState({
        targetChatId: activeId,
        previousHistory,
        finalHistory,
        hadCachedHistory: true,
        historyChanged: false,
        restoredPendingSnapshot,
      });
      const {
        shouldForceUnreadTranscriptRender,
        shouldForceStaleRenderedTranscriptRender,
        shouldRenderActiveHistory,
      } = renderState;
      refreshTabNode(activeId);
      if (shouldRenderActiveHistory) {
        renderMessages(activeId, { preserveViewport: true });
      }
      ensureActivationReadThreshold(activeId, data.chat?.unread_count);
      maybeMarkRead(activeId);

      visibilityResumeController.maybeResumeVisibilitySync({
        activeChatId: activeId,
        hidden,
        streamAbortControllers,
        pendingChats,
        chatPending,
        localPendingWithoutLiveStream,
        snapshotPendingWithoutLiveStream,
        matchedVisibleHydratedCompletion,
      });
    }

    return {
      loadChatHistory,
      hydrateChatFromServer,
      syncVisibleActiveChat,
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
      const statusChats = (data.chats || []).map((chat) => buildChatPreservingUnread(chat, { preserveActivationUnread: true }));
      const pinnedStatusChats = (data.pinned_chats || []).map((chat) => buildChatPreservingUnread(chat, { preserveActivationUnread: true }));
      syncChats(statusChats);
      reconcilePendingStateFromStatus(statusChats);
      syncPinnedChats(pinnedStatusChats);
      renderTabs();
      renderPinnedChats();
      syncActivePendingStatus();
      updateComposerState();
    }

    return {
      refreshChats,
    };
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
      armActivationReadThreshold,
      ensureActivationReadThreshold,
      maybeMarkRead,
      isActiveChat,
      hasLocalPendingWithoutLiveStream,
    } = deps;

    const fetchController = createHistoryFetchController({
      ...deps,
      upsertChatPreservingUnread,
      shouldDeferNonCriticalCachedOpen,
      traceChatHistory,
      nowMs,
      isActiveChat,
      requestIdle,
      scheduleTimeout,
    });
    const hydrationController = createHistoryHydrationController({
      ...deps,
      loadChatHistory: fetchController.loadChatHistory,
      setActiveChatMeta,
      renderMessages,
      getActiveChatId,
      traceChatHistory,
      nowMs,
      buildChatPreservingUnread,
      upsertChatPreservingUnread,
      ensureActivationReadThreshold,
      maybeMarkRead,
      isActiveChat,
      hasLocalPendingWithoutLiveStream,
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
      ...deps,
      buildChatPreservingUnread,
    });

    async function openChat(chatId) {
      const targetChatId = normalizeChatId(chatId);
      const requestId = getLastOpenChatRequestId() + 1;
      setLastOpenChatRequestId(requestId);
      const hadCachedHistory = histories.has(targetChatId);
      const openStartedAtMs = nowMs();
      traceChatHistory('open-start', {
        chatId: targetChatId,
        requestId,
        hadCachedHistory,
      });
      armActivationReadThreshold(targetChatId);

      if (hadCachedHistory) {
        cachedOpenController.openCachedChat(targetChatId, requestId, openStartedAtMs);
        return;
      }

      setActiveChatMeta(targetChatId, { fullTabRender: false, deferNonCritical: true });
      renderMessages(targetChatId);

      try {
        await hydrationController.hydrateChatFromServer(targetChatId, requestId, false);
      } catch (error) {
        traceChatHistory('open-failed', {
          chatId: targetChatId,
          requestId,
          durationMs: Math.max(0, Math.round(nowMs() - openStartedAtMs)),
          message: String(error?.message || ''),
        });
        if (requestId === getLastOpenChatRequestId()) {
          appendSystemMessage(error.message || 'Failed to open chat.', targetChatId);
        }
      }
    }

    return {
      loadChatHistory: fetchController.loadChatHistory,
      hydrateChatFromServer: hydrationController.hydrateChatFromServer,
      openChat,
      prefetchChatHistory: fetchController.prefetchChatHistory,
      warmChatHistoryCache: fetchController.warmChatHistoryCache,
      refreshChats: statusController.refreshChats,
      syncVisibleActiveChat: hydrationController.syncVisibleActiveChat,
    };
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
      persistPendingStreamSnapshot,
      clearPendingStreamSnapshot,
      finalizeHydratedPendingState,
      shouldDeferNonCriticalCachedOpen = () => false,
      getRenderedTranscriptSignature = null,
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
      finalizeHydratedPendingState,
      shouldDeferNonCriticalCachedOpen,
      traceChatHistory,
      nowMs,
      appendSystemMessage: mutationController.appendSystemMessage,
      buildChatPreservingUnread: readSyncController.buildChatPreservingUnread,
      upsertChatPreservingUnread: readSyncController.upsertChatPreservingUnread,
      armActivationReadThreshold: readSyncController.armActivationReadThreshold,
      ensureActivationReadThreshold: readSyncController.ensureActivationReadThreshold,
      maybeMarkRead: readSyncController.maybeMarkRead,
      isActiveChat,
      hasLocalPendingWithoutLiveStream: readSyncController.hasLocalPendingWithoutLiveStream,
      getRenderedTranscriptSignature,
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
      getCurrentUnreadCount: readSyncController.getCurrentUnreadCount,
      armActivationReadThreshold: readSyncController.armActivationReadThreshold,
      ensureActivationReadThreshold: readSyncController.ensureActivationReadThreshold,
      refreshChats: historyController.refreshChats,
      syncVisibleActiveChat: historyController.syncVisibleActiveChat,
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