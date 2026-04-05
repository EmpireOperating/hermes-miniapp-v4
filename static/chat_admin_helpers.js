(function initHermesMiniappChatAdmin(globalScope) {
  const CHAT_TITLE_ALLOWED_TAGS = new Set(['none', 'feat', 'bug']);

  function createController(deps) {
    const {
      windowObject,
      settingsModal,
      chatTitleModal,
      chatTitleForm,
      chatTitleHint,
      chatTitleInput,
      chatTitleCancel,
      chatTitleConfirm,
      chatTitleTagLabel,
      chatTitleTagRow,
      chatTitleTagButtons,
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
      chatLabel,
      getActiveChatId,
      openChat,
      onLatencyByChatMutated,
      chatTabContextMenu,
    } = deps;

    let chatTitleSelectedTag = 'none';
    let tabContextTargetChatId = null;

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
      chatTitleInput.value = fallbackDefault || defaultTitle;
      setChatTitleSelectedTag(showTagToggles ? parsedCurrent.tag : 'none');

      return new Promise((resolve) => {
        let done = false;

        const cleanup = () => {
          chatTitleForm.removeEventListener('submit', onSubmit);
          chatTitleCancel.removeEventListener('click', onCancel);
          chatTitleModal.removeEventListener('cancel', onCancel);
          chatTitleModal.removeEventListener('close', onClose);
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

        const onCancel = (event) => {
          event?.preventDefault?.();
          finish(null);
          if (chatTitleModal.open) chatTitleModal.close();
        };

        const onClose = () => finish(null);

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

        chatTitleForm.addEventListener('submit', onSubmit);
        chatTitleCancel.addEventListener('click', onCancel);
        chatTitleModal.addEventListener('cancel', onCancel);
        chatTitleModal.addEventListener('close', onClose);
        chatTitleTagButtons.forEach((button) => {
          button.addEventListener('click', onTagSelect);
          button.addEventListener('mousedown', onTagMouseDown);
          button.addEventListener('touchstart', onTagTouchStart, { passive: false });
        });

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
    }

    async function renameActiveChat() {
      const activeChatId = Number(getActiveChatId());
      if (!activeChatId) return;
      const currentTitle = chatLabel(activeChatId);
      const nextTitle = await askForChatTitle({ mode: 'rename', currentTitle, defaultTitle: currentTitle });
      if (!nextTitle) return;
      const cleaned = nextTitle.trim() || currentTitle;
      const data = await apiPost('/api/chats/rename', { chat_id: activeChatId, title: cleaned });
      upsertChat(data.chat);
      setActiveChatMeta(activeChatId);
      renderTabs();
      renderPinnedChats();
    }

    function ensureSilentCloseTabAllowed(chatId) {
      if (pendingChats.has(Number(chatId))) {
        throw new Error('Wait for Hermes to finish before closing this chat.');
      }
    }

    function isChatForkBlocked(chatId) {
      const key = Number(chatId);
      if (!key) return false;
      return pendingChats.has(key) || Boolean(chats.get(key)?.pending);
    }

    function syncChatTabContextMenuState(chatId) {
      if (!chatTabContextFork) return;
      const blocked = isChatForkBlocked(chatId);
      chatTabContextFork.disabled = blocked;
      chatTabContextFork.setAttribute('aria-disabled', blocked ? 'true' : 'false');
      chatTabContextFork.title = blocked ? 'Wait for Hermes to finish before forking this chat.' : 'Fork chat';
    }

    function ensureForkChatAllowed(chatId) {
      if (isChatForkBlocked(chatId)) {
        throw new Error('Wait for Hermes to finish before forking this chat.');
      }
    }

    async function removeActiveChat() {
      const activeChatId = Number(getActiveChatId());
      if (!activeChatId) return;
      ensureSilentCloseTabAllowed(activeChatId);
      const removedChatSnapshot = chats.get(activeChatId) || pinnedChats.get(activeChatId) || null;
      const removedWasPinned = Boolean(removedChatSnapshot?.is_pinned);
      const data = await apiPost('/api/chats/remove', { chat_id: activeChatId, allow_empty: true });
      syncChats(data.chats || []);
      syncPinnedChats(data.pinned_chats || []);
      if (removedWasPinned && !pinnedChats.has(activeChatId) && removedChatSnapshot) {
        pinnedChats.set(activeChatId, { ...removedChatSnapshot, is_pinned: true });
      }
      const removedChatId = Number(data.removed_chat_id || 0);
      histories.delete(removedChatId);
      clearChatStreamState({
        chatId: removedChatId,
        pendingChats,
        streamPhaseByChat,
        unseenStreamChats,
      });
      latencyByChat.delete(removedChatId);
      onLatencyByChatMutated?.(latencyByChat);

      const nextActiveChatId = Number(data.active_chat_id || 0);
      if (!nextActiveChatId || !data.active_chat) {
        setNoActiveChatMeta();
        renderPinnedChats();
        return;
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
        renderTabs();
        renderPinnedChats();
      }
      await openChat(targetChatId);
    }

    async function forkChatFrom(chatId) {
      const sourceChatId = Number(chatId);
      if (!sourceChatId) return;
      ensureForkChatAllowed(sourceChatId);

      const sourceTitleRaw = String(chatLabel(sourceChatId) || `Chat ${sourceChatId}`).trim();
      const parsed = parseTaggedChatTitle(sourceTitleRaw);
      const sourceTitle = String(parsed.title || sourceTitleRaw || `Chat ${sourceChatId}`).trim();
      const forkBaseTitle = `${sourceTitle} (fork)`;
      const forkTitle = formatTaggedChatTitle(forkBaseTitle, parsed.tag);

      const data = await apiPost('/api/chats/fork', { chat_id: sourceChatId, title: forkTitle });
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
    }

    function closeChatTabContextMenu() {
      tabContextTargetChatId = null;
      if (!chatTabContextMenu) return;
      chatTabContextMenu.hidden = true;
    }

    function openChatTabContextMenu(chatId, clientX, clientY) {
      if (!chatTabContextMenu) return;
      tabContextTargetChatId = Number(chatId) || null;
      if (!tabContextTargetChatId) {
        closeChatTabContextMenu();
        return;
      }
      syncChatTabContextMenuState(tabContextTargetChatId);
      if (chatTabContextFork?.disabled) {
        closeChatTabContextMenu();
        return;
      }

      const viewportWidth = Number(windowObject?.innerWidth || 0);
      const viewportHeight = Number(windowObject?.innerHeight || 0);
      const menuWidth = 172;
      const menuHeight = 44;
      const left = Math.max(8, Math.min(Number(clientX || 0), Math.max(8, viewportWidth - menuWidth - 8)));
      const top = Math.max(8, Math.min(Number(clientY || 0), Math.max(8, viewportHeight - menuHeight - 8)));

      chatTabContextMenu.style.left = `${left}px`;
      chatTabContextMenu.style.top = `${top}px`;
      chatTabContextMenu.hidden = false;
    }

    function handleTabOverflowTriggerClick(event) {
      const trigger = event?.target?.closest?.('[data-chat-tab-menu-trigger]');
      if (!trigger) return;

      const tab = trigger.closest('.chat-tab');
      const chatId = Number(tab?.dataset?.chatId || 0);
      if (!chatId || chatId !== Number(getActiveChatId())) {
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

    function handleGlobalChatContextMenuDismiss(event) {
      if (chatTabContextMenu?.hidden) return;
      const target = event?.target || null;
      if (target && chatTabContextMenu?.contains?.(target)) return;
      closeChatTabContextMenu();
    }

    async function handleTabContextForkClick(event) {
      event?.preventDefault?.();
      const chatId = Number(tabContextTargetChatId || 0);
      closeChatTabContextMenu();
      if (!chatId) return;
      await forkChatFrom(chatId);
    }

    async function toggleActiveChatPin() {
      const targetChatId = Number(getActiveChatId());
      if (!targetChatId) return;
      const chat = chats.get(targetChatId);
      const isPinned = Boolean(chat?.is_pinned);
      const endpoint = isPinned ? '/api/chats/unpin' : '/api/chats/pin';
      const data = await apiPost(endpoint, { chat_id: targetChatId });
      upsertChat(data.chat);
      syncPinnedChats(data.pinned_chats || []);
      renderTabs();
      renderPinnedChats();
      syncPinChatButton();
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

    return {
      parseTaggedChatTitle,
      formatTaggedChatTitle,
      setChatTitleSelectedTag,
      askForChatTitle,
      createChat,
      renameActiveChat,
      ensureSilentCloseTabAllowed,
      removeActiveChat,
      openPinnedChat,
      forkChatFrom,
      closeChatTabContextMenu,
      openChatTabContextMenu,
      handleTabOverflowTriggerClick,
      handleGlobalChatContextMenuDismiss,
      handleTabContextForkClick,
      toggleActiveChatPin,
      openSettingsModal,
      closeSettingsModal,
    };
  }

  const api = { createController };
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  globalScope.HermesMiniappChatAdmin = api;
})(typeof window !== 'undefined' ? window : globalThis);
