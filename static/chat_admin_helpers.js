(function initHermesMiniappChatAdmin(globalScope) {
  const CHAT_TITLE_ALLOWED_TAGS = new Set(['none', 'feat', 'bug']);

  function createController(deps) {
    const {
      windowObject,
      tabActionsMenuEnabled = false,
      settingsModal,
      keyboardShortcutsModal,
      chatTitleModal,
      chatTitleForm,
      chatTitleHint,
      chatTitleInput,
      chatTitleCancel,
      chatTitleConfirm,
      chatTitleTagLabel,
      chatTitleTagRow,
      chatTitleTagButtons,
      chatTabContextRename,
      chatTabContextPin,
      chatTabContextClose,
      chatTabContextFork,
      apiPost,
      chats,
      pinnedChats,
      histories,
      pendingChats,
      latencyByChat,
      streamPhaseByChat,
      unseenStreamChats,
      clearChatStreamState,
      upsertChat,
      syncChats,
      syncPinnedChats,
      setActiveChatMeta,
      setNoActiveChatMeta,
      renderMessages,
      renderTabs,
      renderPinnedChats,
      syncPinChatButton,
      moveChatToEnd,
      getOrderedChatIds,
      chatLabel,
      getActiveChatId,
      openChat,
      invalidateOpenChatRequests = null,
      onLatencyByChatMutated,
      buildChatPreservingUnread,
      chatTabContextMenu,
      pinnedChatContextMenu,
      pinnedChatContextRemove,
      focusComposerForNewChat,
    } = deps;

    let chatTitleSelectedTag = 'none';
    let tabContextTargetChatId = null;
    let pinnedContextTargetChatId = null;

    function parseTaggedChatTitle(rawTitle) {
      const title = String(rawTitle || '').trim();
      const taggedMatch = title.match(/^\[(feat|bug)\]\s*(.*)$/i);
      if (!taggedMatch) {
        return { tag: 'none', title };
      }
      const [, tagRaw, rest] = taggedMatch;
      return { tag: String(tagRaw || '').toLowerCase(), title: String(rest || '').trim() };
    }

    function formatTaggedChatTitle(title, tag) {
      const cleanedTitle = String(title || '').trim();
      if (!cleanedTitle) return '';
      const normalizedTag = CHAT_TITLE_ALLOWED_TAGS.has(tag) ? tag : 'none';
      if (normalizedTag === 'none') return cleanedTitle;
      return `[${normalizedTag}]${cleanedTitle}`;
    }

    function setChatTitleSelectedTag(nextTag) {
      chatTitleSelectedTag = CHAT_TITLE_ALLOWED_TAGS.has(nextTag) ? nextTag : 'none';
      if (!Array.isArray(chatTitleTagButtons) || !chatTitleTagButtons.length) return;
      chatTitleTagButtons.forEach((button) => {
        const buttonTag = String(button?.dataset?.chatTitleTag || 'none').toLowerCase();
        const isActive = buttonTag === chatTitleSelectedTag;
        button.classList?.toggle?.('is-active', isActive);
        button.setAttribute?.('aria-pressed', isActive ? 'true' : 'false');
      });
    }

    function rotateChatTitleSelectedTag(step) {
      if (!Array.isArray(chatTitleTagButtons) || !chatTitleTagButtons.length) return;
      const orderedTags = chatTitleTagButtons
        .map((button) => String(button?.dataset?.chatTitleTag || 'none').toLowerCase())
        .filter((tag, index, tags) => CHAT_TITLE_ALLOWED_TAGS.has(tag) && tags.indexOf(tag) === index);
      if (!orderedTags.length) return;
      const currentIndex = orderedTags.indexOf(chatTitleSelectedTag);
      const safeIndex = currentIndex >= 0 ? currentIndex : 0;
      const nextIndex = (safeIndex + step + orderedTags.length) % orderedTags.length;
      setChatTitleSelectedTag(orderedTags[nextIndex]);
    }

    async function askForChatTitle({ mode, currentTitle = '', defaultTitle = 'New chat' }) {
      const parsedCurrent = parseTaggedChatTitle(currentTitle);
      const fallbackDefault = mode === 'rename' ? parsedCurrent.title || defaultTitle : defaultTitle;
      const promptFn = windowObject?.prompt?.bind(windowObject);

      if (!chatTitleModal || !chatTitleForm || !chatTitleInput || !chatTitleHint || !chatTitleConfirm || !chatTitleCancel || !chatTitleModal.showModal) {
        const fallback = promptFn?.(mode === 'rename' ? 'Rename chat' : 'New chat name', fallbackDefault || defaultTitle);
        if (fallback == null) return null;
        const cleaned = String(fallback).trim();
        if (!cleaned) return null;

        const fallbackTagInput = promptFn?.('Tag (none/feat/bug)', parsedCurrent.tag || 'none');
        if (fallbackTagInput == null) return null;
        const requestedTag = String(fallbackTagInput || 'none').trim().toLowerCase();
        const normalizedTag = CHAT_TITLE_ALLOWED_TAGS.has(requestedTag) ? requestedTag : 'none';
        setChatTitleSelectedTag(normalizedTag);
        return formatTaggedChatTitle(cleaned, normalizedTag);
      }

      const showTagToggles = Boolean(chatTitleTagRow) && Array.isArray(chatTitleTagButtons) && chatTitleTagButtons.length > 0;
      if (chatTitleTagLabel) {
        chatTitleTagLabel.hidden = !showTagToggles;
      }
      if (chatTitleTagRow) {
        chatTitleTagRow.hidden = !showTagToggles;
      }

      chatTitleHint.textContent = mode === 'rename' ? 'Update this chat title.' : 'Create a title for this chat.';
      chatTitleConfirm.textContent = mode === 'rename' ? 'Rename' : 'Create';
      if ('value' in chatTitleConfirm) {
        chatTitleConfirm.value = 'confirm';
      }
      if ('returnValue' in chatTitleModal) {
        chatTitleModal.returnValue = '';
      }
      chatTitleInput.value = fallbackDefault || defaultTitle;
      setChatTitleSelectedTag(showTagToggles ? parsedCurrent.tag : 'none');

      return new Promise((resolve) => {
        let done = false;
        let confirmIntent = false;

        const cleanup = () => {
          chatTitleForm.removeEventListener('submit', onSubmit);
          chatTitleConfirm.removeEventListener?.('click', onConfirmClick);
          chatTitleConfirm.removeEventListener?.('mouseup', onConfirmIntent);
          chatTitleConfirm.removeEventListener?.('touchend', onConfirmIntent);
          chatTitleCancel.removeEventListener('click', onCancel);
          chatTitleModal.removeEventListener('cancel', onCancel);
          chatTitleModal.removeEventListener('close', onClose);
          chatTitleInput.removeEventListener?.('keydown', onTagRotationKeyDown);
          chatTitleTagButtons.forEach((button) => {
            button.removeEventListener('click', onTagSelect);
            button.removeEventListener('mousedown', onTagMouseDown);
            button.removeEventListener('touchstart', onTagTouchStart);
          });
        };

        const finish = (value) => {
          if (done) return;
          done = true;
          cleanup();
          resolve(value);
        };

        const onSubmit = (event) => {
          event.preventDefault();
          const value = chatTitleInput.value.trim();
          if (!value) {
            chatTitleInput.focus();
            return;
          }
          const formatted = showTagToggles ? formatTaggedChatTitle(value, chatTitleSelectedTag) : value;
          finish(formatted);
          if (chatTitleModal.open) chatTitleModal.close();
        };

        const onConfirmClick = (event) => {
          event?.preventDefault?.();
          onSubmit(event);
        };

        const onConfirmIntent = () => {
          confirmIntent = true;
        };

        const onCancel = (event) => {
          event?.preventDefault?.();
          confirmIntent = false;
          finish(null);
          if (chatTitleModal.open) chatTitleModal.close();
        };

        const onClose = () => {
          if (done) return;
          const returnValue = String(chatTitleModal?.returnValue || '').trim().toLowerCase();
          const shouldSubmit = returnValue === 'confirm' || confirmIntent;
          confirmIntent = false;
          if (shouldSubmit && chatTitleInput.value.trim()) {
            onSubmit({ preventDefault() {} });
            return;
          }
          finish(null);
        };

        const applyTagSelection = (event) => {
          const requestedTag = String(event?.currentTarget?.dataset?.chatTitleTag || 'none').toLowerCase();
          setChatTitleSelectedTag(requestedTag);
          // Keep focus in the title input so mobile keyboards stay open
          // when toggling tags.
          chatTitleInput.focus?.();
        };

        const onTagMouseDown = (event) => {
          // Prevent focus transfer on mouse input so desktop/webview keyboards
          // keep title-input focus while still allowing click to fire.
          event?.preventDefault?.();
          chatTitleInput.focus?.();
        };

        const onTagTouchStart = (event) => {
          // In mobile webviews, preventDefault on touchstart can suppress click.
          // Apply selection here so taps still switch tags even when click never fires.
          event?.preventDefault?.();
          applyTagSelection(event);
        };

        const onTagSelect = (event) => {
          event.preventDefault();
          applyTagSelection(event);
        };

        const onTagRotationKeyDown = (event) => {
          if (!showTagToggles) return;
          if (!event?.altKey || event?.ctrlKey || event?.metaKey) return;
          if (event?.key === 'ArrowRight') {
            event.preventDefault?.();
            rotateChatTitleSelectedTag(1);
            chatTitleInput.focus?.();
            return;
          }
          if (event?.key === 'ArrowLeft') {
            event.preventDefault?.();
            rotateChatTitleSelectedTag(-1);
            chatTitleInput.focus?.();
          }
        };

        chatTitleForm.addEventListener('submit', onSubmit);
        chatTitleConfirm.addEventListener?.('click', onConfirmClick);
        chatTitleConfirm.addEventListener?.('mouseup', onConfirmIntent);
        chatTitleConfirm.addEventListener?.('touchend', onConfirmIntent);
        chatTitleCancel.addEventListener('click', onCancel);
        chatTitleModal.addEventListener('cancel', onCancel);
        chatTitleModal.addEventListener('close', onClose);
        chatTitleInput.addEventListener?.('keydown', onTagRotationKeyDown);
        chatTitleTagButtons.forEach((button) => button.addEventListener('click', onTagSelect));
        chatTitleTagButtons.forEach((button) => button.addEventListener('mousedown', onTagMouseDown));
        chatTitleTagButtons.forEach((button) => button.addEventListener('touchstart', onTagTouchStart, { passive: false }));

        const focusChatTitleInput = () => {
          // Mobile browsers are more reliable at raising the software keyboard
          // with plain focus() than focus({ preventScroll: true }).
          chatTitleInput.focus();
          chatTitleInput.select?.();
        };

        chatTitleModal.showModal();
        // Focus synchronously so mobile browsers keep user-gesture context and reliably open keyboard.
        focusChatTitleInput();
        // Keep a deferred retry for browsers that need one paint after showModal().
        windowObject?.setTimeout?.(focusChatTitleInput, 0);
      });
    }

    async function createChat() {
      const title = await askForChatTitle({ mode: 'create', defaultTitle: 'New chat' });
      if (!title) return;
      const cleaned = title.trim() || 'New chat';
      const data = await apiPost('/api/chats', { title: cleaned });
      upsertChat(data.chat);
      histories.set(Number(data.chat.id), data.history || []);
      setActiveChatMeta(data.chat.id);
      renderMessages(data.chat.id);
      focusComposerForNewChat?.(data.chat.id);
    }

    function getChatRecord(chatId) {
      const key = Number(chatId);
      return chats.get(key) || pinnedChats.get(key) || null;
    }

    async function renameChatById(chatId) {
      const targetChatId = Number(chatId);
      if (!targetChatId) return;
      const currentTitle = chatLabel(targetChatId);
      const nextTitle = await askForChatTitle({ mode: 'rename', currentTitle, defaultTitle: currentTitle });
      if (!nextTitle) return;
      const cleaned = nextTitle.trim() || currentTitle;
      const localChat = getChatRecord(targetChatId);
      const localSnapshot = localChat && typeof localChat === 'object'
        ? { ...localChat }
        : null;

      const applyRenamedChat = (chatRecord) => {
        if (!chatRecord || typeof chatRecord !== 'object') return;
        upsertChat(chatRecord);
        if (targetChatId === Number(getActiveChatId())) {
          setActiveChatMeta(targetChatId);
        } else {
          renderTabs();
        }
        renderPinnedChats();
      };

      const prepareRenamedChat = (title, incomingChat = null) => {
        const latestLocalChat = getChatRecord(targetChatId);
        const baseChat = latestLocalChat && typeof latestLocalChat === 'object'
          ? { ...latestLocalChat }
          : localSnapshot && typeof localSnapshot === 'object'
            ? { ...localSnapshot }
            : null;
        const sourceChat = incomingChat && typeof incomingChat === 'object'
          ? { ...(baseChat || {}), ...incomingChat }
          : baseChat;
        if (!sourceChat || typeof sourceChat !== 'object') return null;
        sourceChat.title = title;
        sourceChat.unread_count = Math.max(
          0,
          Number(baseChat?.unread_count || 0),
          Number(incomingChat?.unread_count || 0),
        );
        if (sourceChat.newest_unread_message_id == null && baseChat?.newest_unread_message_id != null) {
          sourceChat.newest_unread_message_id = baseChat.newest_unread_message_id;
        }
        if (typeof buildChatPreservingUnread === 'function') {
          return buildChatPreservingUnread(sourceChat, { preserveActivationUnread: true });
        }
        return sourceChat;
      };

      let optimisticRenameApplied = false;
      if (localSnapshot) {
        try {
          applyRenamedChat(prepareRenamedChat(cleaned));
          optimisticRenameApplied = true;
        } catch (error) {
          windowObject?.console?.warn?.(
            '[chat-rename] optimistic local rename failed before request; falling back to server-confirmed rename',
            error,
          );
        }
      }

      try {
        const data = await apiPost('/api/chats/rename', { chat_id: targetChatId, title: cleaned });
        const nextChat = data?.chat && typeof data.chat === 'object'
          ? { ...data.chat }
          : null;
        applyRenamedChat(prepareRenamedChat(cleaned, nextChat));
      } catch (error) {
        if (optimisticRenameApplied && localSnapshot) {
          applyRenamedChat(prepareRenamedChat(currentTitle));
        }
        throw error;
      }
    }

    async function renameActiveChat() {
      const activeChatId = Number(getActiveChatId());
      if (!activeChatId) return;
      await renameChatById(activeChatId);
    }

    function ensureSilentCloseTabAllowed(chatId) {
      if (pendingChats.has(Number(chatId))) {
        throw new Error('Wait for Hermes to finish before closing this chat.');
      }
    }

    function syncContextActionButton(button, { disabled = false, title = '', chatId = null } = {}) {
      if (!button) return;
      button.disabled = Boolean(disabled);
      button.setAttribute('aria-disabled', disabled ? 'true' : 'false');
      button.title = title || '';
      if (button.dataset) {
        if (Number(chatId) > 0) {
          button.dataset.chatId = String(Number(chatId));
        } else {
          delete button.dataset.chatId;
        }
      }
    }

    function syncChatTabContextMenuState(chatId) {
      const targetChatId = Number(chatId);
      if (!tabActionsMenuEnabled || !targetChatId) {
        syncContextActionButton(chatTabContextRename, { disabled: true, chatId: null });
        syncContextActionButton(chatTabContextPin, { disabled: true, chatId: null });
        syncContextActionButton(chatTabContextClose, { disabled: true, chatId: null });
        syncContextActionButton(chatTabContextFork, { disabled: true, chatId: null });
        return;
      }

      const chat = getChatRecord(targetChatId);
      const isPinned = Boolean(chat?.is_pinned);
      const closeBlocked = pendingChats.has(targetChatId) || Boolean(chat?.pending);
      syncContextActionButton(chatTabContextRename, { disabled: false, title: 'Rename chat', chatId: targetChatId });
      if (chatTabContextPin) {
        chatTabContextPin.textContent = isPinned ? 'Unpin chat' : 'Pin chat';
      }
      syncContextActionButton(chatTabContextPin, { disabled: false, title: isPinned ? 'Unpin chat' : 'Pin chat', chatId: targetChatId });
      syncContextActionButton(chatTabContextClose, {
        disabled: closeBlocked,
        title: closeBlocked ? 'Wait for Hermes to finish before closing this chat.' : 'Close chat',
        chatId: targetChatId,
      });
      syncContextActionButton(chatTabContextFork, {
        disabled: false,
        title: 'Branch chat',
        chatId: targetChatId,
      });
    }

    function syncPinnedChatContextMenuState(chatId) {
      const targetChatId = Number(chatId);
      if (!tabActionsMenuEnabled || !targetChatId) {
        syncContextActionButton(pinnedChatContextRemove, { disabled: true });
        return;
      }
      const chat = getChatRecord(targetChatId);
      const removeBlocked = pendingChats.has(targetChatId) || Boolean(chat?.pending);
      syncContextActionButton(pinnedChatContextRemove, {
        disabled: removeBlocked,
        title: removeBlocked ? 'Wait for Hermes to finish before removing this chat.' : 'Remove chat',
      });
    }

    function getNextBranchTitle(sourceTitle) {
      const cleanedSourceTitle = String(sourceTitle || '').trim() || 'branch';
      const lineageMatch = cleanedSourceTitle.match(/^(.*?) #(\d+)$/);
      const lineageBase = String(lineageMatch?.[1] || cleanedSourceTitle).trim() || 'branch';
      let maxSuffix = cleanedSourceTitle === lineageBase ? 1 : 0;
      const lineagePattern = new RegExp(`^${lineageBase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?: #(\\d+))?$`);
      const inspectChat = (chat) => {
        const rawTitle = String(chat?.title || '').trim();
        if (!rawTitle) return;
        const parsed = parseTaggedChatTitle(rawTitle);
        const title = String(parsed?.title || rawTitle).trim();
        const match = title.match(lineagePattern);
        if (!match) return;
        const suffix = match[1] ? Number.parseInt(match[1], 10) : 1;
        if (Number.isFinite(suffix)) {
          maxSuffix = Math.max(maxSuffix, suffix);
        }
      };
      chats.forEach(inspectChat);
      pinnedChats.forEach(inspectChat);
      return maxSuffix <= 0 ? lineageBase : `${lineageBase} #${maxSuffix + 1}`;
    }

    function snapshotMap(mapRef) {
      return new Map(mapRef instanceof Map ? mapRef : []);
    }

    function restoreMap(targetMap, snapshot) {
      if (!(targetMap instanceof Map)) return;
      targetMap.clear();
      snapshot.forEach((value, key) => {
        targetMap.set(key, value);
      });
    }

    function snapshotSet(setRef) {
      return new Set(setRef instanceof Set ? setRef : []);
    }

    function restoreSet(targetSet, snapshot) {
      if (!(targetSet instanceof Set)) return;
      targetSet.clear();
      snapshot.forEach((value) => {
        targetSet.add(value);
      });
    }

    function getOptimisticNextActiveChatId(closingChatId) {
      const closingId = Number(closingChatId) || 0;
      const fallbackIds = [...chats.keys()]
        .map((chatId) => Number(chatId))
        .filter((chatId) => chatId > 0 && chatId !== closingId)
        .sort((a, b) => a - b);

      const orderedIds = typeof getOrderedChatIds === 'function'
        ? getOrderedChatIds()
            .map((chatId) => Number(chatId))
            .filter((chatId) => chatId > 0)
        : [];
      const visibleOrderedIds = orderedIds.filter((chatId) => chatId === closingId || chats.has(chatId));
      const closingIndex = visibleOrderedIds.indexOf(closingId);
      if (closingIndex >= 0) {
        const rightNeighborId = visibleOrderedIds[closingIndex + 1] || 0;
        if (rightNeighborId > 0 && rightNeighborId !== closingId && chats.has(rightNeighborId)) {
          return rightNeighborId;
        }
        const leftNeighborId = visibleOrderedIds[closingIndex - 1] || 0;
        if (leftNeighborId > 0 && leftNeighborId !== closingId && chats.has(leftNeighborId)) {
          return leftNeighborId;
        }
      }

      return fallbackIds[0] || 0;
    }

    async function removeChatById(chatId) {
      const targetChatId = Number(chatId);
      if (!targetChatId) return;
      if (targetChatId === Number(getActiveChatId())) {
        return removeActiveChat();
      }

      ensureSilentCloseTabAllowed(targetChatId);
      const data = await apiPost('/api/chats/remove', {
        chat_id: targetChatId,
        allow_empty: true,
        include_full_state: true,
      });
      syncChats(data.chats || []);
      syncPinnedChats(data.pinned_chats || []);
      histories.delete(targetChatId);
      clearChatStreamState({
        chatId: targetChatId,
        pendingChats,
        streamPhaseByChat,
        unseenStreamChats,
      });
      latencyByChat.delete(targetChatId);
      onLatencyByChatMutated?.(latencyByChat);
      renderTabs();
      renderPinnedChats();
      const activeChatId = Number(getActiveChatId());
      if (activeChatId > 0 && activeChatId === Number(data.active_chat_id || 0) && chats.has(activeChatId)) {
        syncPinChatButton?.();
      }
    }

    async function removePinnedChatById(chatId) {
      const targetChatId = Number(chatId);
      if (!targetChatId) return;

      const targetIsOpen = chats.has(targetChatId);
      const targetIsPinned = Boolean(getChatRecord(targetChatId)?.is_pinned) || pinnedChats.has(targetChatId);
      if (targetIsPinned) {
        const data = await apiPost('/api/chats/unpin', { chat_id: targetChatId });
        if (targetIsOpen && data?.chat) {
          upsertChat(data.chat);
        }
        syncPinnedChats(data?.pinned_chats || []);
        renderTabs();
        renderPinnedChats();
        if (targetChatId === Number(getActiveChatId())) {
          syncPinChatButton?.();
        }
      }

      await removeChatById(targetChatId);
    }

    async function removeActiveChat() {
      const activeChatId = Number(getActiveChatId());
      if (!activeChatId) return;
      ensureSilentCloseTabAllowed(activeChatId);
      const optimisticNextChatId = getOptimisticNextActiveChatId(activeChatId);
      const optimisticSnapshot = {
        chats: snapshotMap(chats),
        pinnedChats: snapshotMap(pinnedChats),
        histories: snapshotMap(histories),
        pendingChats: snapshotSet(pendingChats),
        latencyByChat: snapshotMap(latencyByChat),
        streamPhaseByChat: snapshotMap(streamPhaseByChat),
        unseenStreamChats: snapshotSet(unseenStreamChats),
      };

      chats.delete(activeChatId);
      histories.delete(activeChatId);
      clearChatStreamState({
        chatId: activeChatId,
        pendingChats,
        streamPhaseByChat,
        unseenStreamChats,
      });
      latencyByChat.delete(activeChatId);
      onLatencyByChatMutated?.(latencyByChat);

      let optimisticHydratePromise = null;
      if (optimisticNextChatId > 0) {
        setActiveChatMeta(optimisticNextChatId, { fullTabRender: false, deferNonCritical: true });
        renderTabs();
        renderPinnedChats();
        if (histories.has(optimisticNextChatId)) {
          renderMessages(optimisticNextChatId);
        } else {
          optimisticHydratePromise = Promise.resolve(openChat(optimisticNextChatId, {
            suppressColdOpenRender: true,
            suppressFailureSystemMessage: true,
          }));
        }
      } else {
        setNoActiveChatMeta();
      }

      let data;
      try {
        data = await apiPost('/api/chats/remove', {
          chat_id: activeChatId,
          allow_empty: true,
          include_full_state: false,
          ...(optimisticNextChatId > 0 ? { preferred_chat_id: optimisticNextChatId } : {}),
        });
      } catch (error) {
        if (optimisticHydratePromise) {
          invalidateOpenChatRequests?.();
        }
        restoreMap(chats, optimisticSnapshot.chats);
        restoreMap(pinnedChats, optimisticSnapshot.pinnedChats);
        restoreMap(histories, optimisticSnapshot.histories);
        restoreSet(pendingChats, optimisticSnapshot.pendingChats);
        restoreMap(latencyByChat, optimisticSnapshot.latencyByChat);
        restoreMap(streamPhaseByChat, optimisticSnapshot.streamPhaseByChat);
        restoreSet(unseenStreamChats, optimisticSnapshot.unseenStreamChats);
        onLatencyByChatMutated?.(latencyByChat);
        setActiveChatMeta(activeChatId);
        renderPinnedChats();
        renderMessages(activeChatId);
        throw error;
      }

      const hasFullState = Array.isArray(data.chats) || Array.isArray(data.pinned_chats);
      if (Array.isArray(data.chats)) {
        syncChats(data.chats || []);
      }
      if (Array.isArray(data.pinned_chats)) {
        syncPinnedChats(data.pinned_chats || []);
      }
      const removedChatId = Number(data.removed_chat_id || 0);
      histories.delete(removedChatId);
      if (removedChatId > 0 && removedChatId !== activeChatId) {
        clearChatStreamState({
          chatId: removedChatId,
          pendingChats,
          streamPhaseByChat,
          unseenStreamChats,
        });
        latencyByChat.delete(removedChatId);
        onLatencyByChatMutated?.(latencyByChat);
      }

      const nextActiveChatId = Number(data.active_chat_id || 0);
      if (!nextActiveChatId) {
        if (optimisticHydratePromise) {
          invalidateOpenChatRequests?.();
        }
        renderPinnedChats();
        return;
      }

      if (!data.active_chat || !Array.isArray(data.history)) {
        renderPinnedChats();
        if (nextActiveChatId !== Number(getActiveChatId())) {
          await openChat(nextActiveChatId);
        } else if (!histories.has(nextActiveChatId)) {
          if (optimisticHydratePromise) {
            await optimisticHydratePromise;
          }
          if (!histories.has(nextActiveChatId)) {
            await openChat(nextActiveChatId);
          }
        }
        return;
      }

      if (optimisticHydratePromise && nextActiveChatId !== optimisticNextChatId) {
        invalidateOpenChatRequests?.();
      }

      histories.set(nextActiveChatId, data.history || []);
      upsertChat(data.active_chat);
      setActiveChatMeta(nextActiveChatId);
      renderPinnedChats();
      renderMessages(nextActiveChatId);
    }

    async function openPinnedChat(chatId) {
      const targetChatId = Number(chatId);
      if (!targetChatId) return;
      if (!chats.has(targetChatId)) {
        const reopenData = await apiPost('/api/chats/reopen', { chat_id: targetChatId });
        syncChats(reopenData.chats || []);
        syncPinnedChats(reopenData.pinned_chats || []);
        upsertChat(reopenData.chat);
        moveChatToEnd?.(targetChatId);
        renderTabs();
        renderPinnedChats();
        if (Array.isArray(reopenData.history) && reopenData.chat) {
          histories.set(targetChatId, reopenData.history || []);
          setActiveChatMeta(targetChatId, { fullTabRender: false, deferNonCritical: true });
          renderMessages(targetChatId);
          return;
        }
      }
      await openChat(targetChatId);
    }

    async function forkChatFrom(chatId) {
      const sourceChatId = Number(chatId);
      if (!sourceChatId) return;

      const sourceTitleRaw = String(chatLabel(sourceChatId) || `Chat ${sourceChatId}`).trim();
      const parsed = parseTaggedChatTitle(sourceTitleRaw);
      const sourceTitle = String(parsed.title || sourceTitleRaw || `Chat ${sourceChatId}`).trim();
      const branchBaseTitle = getNextBranchTitle(sourceTitle);
      const forkTitle = formatTaggedChatTitle(branchBaseTitle, parsed.tag);

      const data = await apiPost('/api/chats/branch', { chat_id: sourceChatId, title: forkTitle });
      syncChats(data.chats || []);
      syncPinnedChats(data.pinned_chats || []);
      upsertChat(data.chat);

      const nextActiveChatId = Number(data.active_chat_id || data.chat?.id || 0);
      if (!nextActiveChatId) return;
      histories.set(nextActiveChatId, data.history || []);
      setActiveChatMeta(nextActiveChatId);
      renderTabs();
      renderPinnedChats();
      renderMessages(nextActiveChatId);
      focusComposerForNewChat?.(nextActiveChatId);
    }

    function closeChatTabContextMenu() {
      tabContextTargetChatId = null;
      if (!chatTabContextMenu) return;
      chatTabContextMenu.hidden = true;
    }

    function closePinnedChatContextMenu() {
      pinnedContextTargetChatId = null;
      if (!pinnedChatContextMenu) return;
      pinnedChatContextMenu.hidden = true;
    }

    function openChatTabContextMenu(chatId, clientX, clientY) {
      if (!chatTabContextMenu || !tabActionsMenuEnabled) return;
      tabContextTargetChatId = Number(chatId) || null;
      if (!tabContextTargetChatId) {
        closeChatTabContextMenu();
        return;
      }
      syncChatTabContextMenuState(tabContextTargetChatId);

      const viewportWidth = Number(windowObject?.innerWidth || 0);
      const viewportHeight = Number(windowObject?.innerHeight || 0);
      const menuWidth = 172;
      const menuHeight = 196;
      const left = Math.max(8, Math.min(Number(clientX || 0), Math.max(8, viewportWidth - menuWidth - 8)));
      const top = Math.max(8, Math.min(Number(clientY || 0), Math.max(8, viewportHeight - menuHeight - 8)));

      chatTabContextMenu.style.left = `${left}px`;
      chatTabContextMenu.style.top = `${top}px`;
      chatTabContextMenu.hidden = false;
    }

    function handleTabOverflowTriggerClick(event) {
      if (!tabActionsMenuEnabled) return;
      const trigger = event?.target?.closest?.('[data-chat-tab-menu-trigger]');
      if (!trigger) return;

      const tab = trigger.closest('.chat-tab');
      const chatId = Number(tab?.dataset?.chatId || 0);
      if (!chatId) {
        closeChatTabContextMenu();
        return;
      }

      event.preventDefault();
      event.stopPropagation();

      const existingTargetId = Number(tabContextTargetChatId || 0);
      const isAlreadyOpenForSameChat = !chatTabContextMenu?.hidden && existingTargetId === chatId;
      if (isAlreadyOpenForSameChat) {
        closeChatTabContextMenu();
        return;
      }

      const rect = trigger.getBoundingClientRect();
      openChatTabContextMenu(chatId, rect.right - 6, rect.bottom + 6);
    }

    function openPinnedChatContextMenu(chatId, clientX, clientY) {
      if (!pinnedChatContextMenu || !tabActionsMenuEnabled) return;
      pinnedContextTargetChatId = Number(chatId) || null;
      if (!pinnedContextTargetChatId) {
        closePinnedChatContextMenu();
        return;
      }
      syncPinnedChatContextMenuState(pinnedContextTargetChatId);

      const viewportWidth = Number(windowObject?.innerWidth || 0);
      const viewportHeight = Number(windowObject?.innerHeight || 0);
      const menuWidth = 172;
      const menuHeight = 68;
      const left = Math.max(8, Math.min(Number(clientX || 0), Math.max(8, viewportWidth - menuWidth - 8)));
      const top = Math.max(8, Math.min(Number(clientY || 0), Math.max(8, viewportHeight - menuHeight - 8)));

      pinnedChatContextMenu.style.left = `${left}px`;
      pinnedChatContextMenu.style.top = `${top}px`;
      pinnedChatContextMenu.hidden = false;
    }

    function handlePinnedOverflowTriggerClick(event) {
      if (!tabActionsMenuEnabled) return;
      const trigger = event?.target?.closest?.('[data-pinned-chat-menu-trigger]');
      if (!trigger) return;

      const item = trigger.closest('.pinned-chat-item');
      const chatId = Number(item?.dataset?.chatId || 0);
      if (!chatId) {
        closePinnedChatContextMenu();
        return;
      }

      event.preventDefault();
      event.stopPropagation();

      const existingTargetId = Number(pinnedContextTargetChatId || 0);
      const isAlreadyOpenForSameChat = !pinnedChatContextMenu?.hidden && existingTargetId === chatId;
      if (isAlreadyOpenForSameChat) {
        closePinnedChatContextMenu();
        return;
      }

      const rect = trigger.getBoundingClientRect();
      openPinnedChatContextMenu(chatId, rect.right - 6, rect.bottom + 6);
    }

    function handleGlobalChatContextMenuDismiss(event) {
      const target = event?.target || null;
      if (target && (chatTabContextMenu?.contains?.(target) || pinnedChatContextMenu?.contains?.(target))) return;
      closeChatTabContextMenu();
      closePinnedChatContextMenu();
    }

    function resolveContextActionChatId(event, fallbackChatId) {
      const fallback = Number(fallbackChatId || 0);
      const currentTargetId = Number(event?.currentTarget?.dataset?.chatId || 0);
      const targetId = Number(event?.target?.dataset?.chatId || 0);
      return currentTargetId || targetId || fallback;
    }

    async function handleTabContextRenameClick(event) {
      event?.preventDefault?.();
      const chatId = resolveContextActionChatId(event, tabContextTargetChatId);
      closeChatTabContextMenu();
      if (!chatId) return;
      await renameChatById(chatId);
    }

    async function handleTabContextPinClick(event) {
      event?.preventDefault?.();
      const chatId = resolveContextActionChatId(event, tabContextTargetChatId);
      closeChatTabContextMenu();
      if (!chatId) return;
      await toggleChatPin(chatId);
    }

    async function handleTabContextCloseClick(event) {
      event?.preventDefault?.();
      const chatId = resolveContextActionChatId(event, tabContextTargetChatId);
      closeChatTabContextMenu();
      if (!chatId) return;
      await removeChatById(chatId);
    }

    async function handleTabContextForkClick(event) {
      event?.preventDefault?.();
      const chatId = resolveContextActionChatId(event, tabContextTargetChatId);
      closeChatTabContextMenu();
      if (!chatId) return;
      await forkChatFrom(chatId);
    }

    async function handlePinnedContextRemoveClick(event) {
      event?.preventDefault?.();
      const chatId = Number(pinnedContextTargetChatId || 0);
      closePinnedChatContextMenu();
      if (!chatId) return;
      await removePinnedChatById(chatId);
    }

    async function toggleChatPin(chatId) {
      const targetChatId = Number(chatId);
      if (!targetChatId) return;
      const chat = getChatRecord(targetChatId);
      const isPinned = Boolean(chat?.is_pinned);
      const endpoint = isPinned ? '/api/chats/unpin' : '/api/chats/pin';
      const data = await apiPost(endpoint, { chat_id: targetChatId });
      upsertChat(data.chat);
      syncPinnedChats(data.pinned_chats || []);
      renderTabs();
      renderPinnedChats();
      if (targetChatId === Number(getActiveChatId())) {
        syncPinChatButton();
      }
    }

    async function toggleActiveChatPin() {
      const targetChatId = Number(getActiveChatId());
      if (!targetChatId) return;
      await toggleChatPin(targetChatId);
    }

    function openSettingsModal() {
      if (!settingsModal) return;
      if (settingsModal.showModal) {
        settingsModal.showModal();
        return;
      }
      settingsModal.setAttribute('open', 'open');
    }

    function closeSettingsModal() {
      if (!settingsModal) return;
      if (settingsModal.close) {
        settingsModal.close();
        return;
      }
      settingsModal.removeAttribute('open');
    }

    function openKeyboardShortcutsModal() {
      if (!keyboardShortcutsModal) return;

      if (settingsModal?.open) {
        closeSettingsModal();
      }

      const showModal = () => {
        if (keyboardShortcutsModal.showModal) {
          keyboardShortcutsModal.showModal();
          return;
        }
        keyboardShortcutsModal.setAttribute('open', 'open');
      };

      if (windowObject?.requestAnimationFrame) {
        windowObject.requestAnimationFrame(showModal);
        return;
      }
      showModal();
    }

    function closeKeyboardShortcutsModal() {
      if (!keyboardShortcutsModal) return;
      if (keyboardShortcutsModal.close) {
        keyboardShortcutsModal.close();
        return;
      }
      keyboardShortcutsModal.removeAttribute('open');
    }

    return {
      parseTaggedChatTitle,
      formatTaggedChatTitle,
      setChatTitleSelectedTag,
      askForChatTitle,
      createChat,
      renameActiveChat,
      renameChatById,
      ensureSilentCloseTabAllowed,
      removeActiveChat,
      removeChatById,
      removePinnedChatById,
      openPinnedChat,
      getNextBranchTitle,
      forkChatFrom,
      closeChatTabContextMenu,
      openChatTabContextMenu,
      closePinnedChatContextMenu,
      openPinnedChatContextMenu,
      handleTabOverflowTriggerClick,
      handlePinnedOverflowTriggerClick,
      handleGlobalChatContextMenuDismiss,
      handleTabContextRenameClick,
      handleTabContextPinClick,
      handleTabContextCloseClick,
      handleTabContextForkClick,
      handlePinnedContextRemoveClick,
      toggleActiveChatPin,
      toggleChatPin,
      openSettingsModal,
      closeSettingsModal,
      openKeyboardShortcutsModal,
      closeKeyboardShortcutsModal,
    };
  }

  const api = { createController };
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  globalScope.HermesMiniappChatAdmin = api;
})(typeof window !== 'undefined' ? window : globalThis);
