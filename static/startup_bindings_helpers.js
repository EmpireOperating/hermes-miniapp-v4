(function initHermesMiniappStartupBindings(globalScope) {
  function createController(deps) {
    const {
      windowObject,
      documentObject,
      tabsEl,
      pinnedChatsEl,
      pinnedChatsToggleButton,
      messagesEl,
      jumpLatestButton,
      jumpLastStartButton,
      skinButtons,
      newChatButton,
      renameChatButton,
      pinChatButton,
      removeChatButton,
      fullscreenAppTopButton,
      closeAppTopButton,
      renderTraceBadge,
      settingsButton,
      devSignInButton,
      settingsClose,
      settingsModal,
      authStatusEl,
      getActiveChatId,
      getRenderedChatId,
      isNearBottomFn,
      chatScrollTop,
      chatStickToBottom,
      unseenStreamChats,
      histories,
      shouldVirtualizeHistoryFn,
      scheduleActiveMessageView,
      refreshTabNode,
      maybeMarkRead,
      updateJumpLatestVisibility,
      syncActiveMessageView,
      cancelSelectionQuoteSync,
      cancelSelectionQuoteSettle,
      cancelSelectionQuoteClear,
      clearSelectionQuoteState,
      handleTabClick,
      handlePinnedChatClick,
      togglePinnedChatsCollapsed,
      handleGlobalTabCycle,
      handleGlobalArrowJump,
      handleGlobalComposerFocusShortcut,
      handleGlobalControlEnterDefuse,
      handleGlobalControlMouseDownFocusGuard,
      handleGlobalControlClickFocusCleanup,
      handleFullscreenToggle,
      handleCloseApp,
      handleRenderTraceBadgeClick,
      openSettingsModal,
      closeSettingsModal,
      signInWithDevAuth,
      appendSystemMessage,
      syncDevAuthUi,
      reportUiError,
      getIsAuthenticated,
      saveSkinPreference,
      createChat,
      renameActiveChat,
      toggleActiveChatPin,
      removeActiveChat,
    } = deps;

    function handleMessagesScroll() {
      cancelSelectionQuoteSync();
      cancelSelectionQuoteSettle();
      cancelSelectionQuoteClear();
      clearSelectionQuoteState();

      const key = Number(getActiveChatId());
      if (!key || Number(getRenderedChatId()) !== key) return;

      const atBottom = isNearBottomFn(messagesEl, 40);
      chatScrollTop.set(key, messagesEl.scrollTop);
      chatStickToBottom.set(key, atBottom);
      if (atBottom) {
        unseenStreamChats.delete(key);
        refreshTabNode(key);
        maybeMarkRead(key);
      }
      updateJumpLatestVisibility();

      const historyLength = (histories.get(key) || []).length;
      if (shouldVirtualizeHistoryFn(historyLength)) {
        scheduleActiveMessageView(key);
      }
    }

    function handleJumpLatest() {
      const key = Number(getActiveChatId());
      if (!key) return;

      unseenStreamChats.delete(key);
      refreshTabNode(key);
      syncActiveMessageView(key, { forceBottom: true });
      maybeMarkRead(key, { force: true });
      updateJumpLatestVisibility();
    }

    function handleJumpLastStart() {
      const key = Number(getActiveChatId());
      if (!key) return;

      const renderedMessages = messagesEl.querySelectorAll('.message');
      const lastRenderedMessage = renderedMessages[renderedMessages.length - 1];
      if (!lastRenderedMessage) return;

      messagesEl.scrollTop = Math.max(0, Number(lastRenderedMessage.offsetTop));
      chatScrollTop.set(key, messagesEl.scrollTop);
      chatStickToBottom.set(key, isNearBottomFn(messagesEl, 40));
      updateJumpLatestVisibility();
    }

    function bindAsyncClick(button, action) {
      button?.addEventListener('click', () => {
        void (async () => {
          try {
            await action();
          } catch (error) {
            reportUiError(error);
          }
        })();
      });
    }

    function installCoreEventBindings() {
      tabsEl.addEventListener('click', handleTabClick);
      pinnedChatsEl?.addEventListener('click', handlePinnedChatClick);
      pinnedChatsToggleButton?.addEventListener('click', togglePinnedChatsCollapsed);
      documentObject.addEventListener('keydown', handleGlobalTabCycle);
      documentObject.addEventListener('keydown', handleGlobalArrowJump);
      documentObject.addEventListener('keydown', handleGlobalComposerFocusShortcut);
      documentObject.addEventListener('keydown', handleGlobalControlEnterDefuse, true);
      documentObject.addEventListener('mousedown', handleGlobalControlMouseDownFocusGuard, true);
      documentObject.addEventListener('click', handleGlobalControlClickFocusCleanup, true);
      messagesEl.addEventListener('scroll', handleMessagesScroll);
      jumpLatestButton?.addEventListener('click', handleJumpLatest);
      jumpLastStartButton?.addEventListener('click', handleJumpLastStart);
    }

    function installActionButtonBindings() {
      skinButtons.forEach((button) => {
        bindAsyncClick(button, async () => {
          if (!getIsAuthenticated()) {
            appendSystemMessage('Still signing you in. Try again in a moment.');
            return;
          }
          await saveSkinPreference(button.dataset.skin);
          closeSettingsModal();
        });
      });

      bindAsyncClick(newChatButton, createChat);
      bindAsyncClick(renameChatButton, renameActiveChat);
      bindAsyncClick(pinChatButton, toggleActiveChatPin);
      bindAsyncClick(removeChatButton, removeActiveChat);
    }

    function installShellModalBindings() {
      fullscreenAppTopButton?.addEventListener('click', handleFullscreenToggle);
      closeAppTopButton?.addEventListener('click', handleCloseApp);
      renderTraceBadge?.addEventListener('click', handleRenderTraceBadgeClick);
      settingsButton?.addEventListener('click', openSettingsModal);

      devSignInButton?.addEventListener('click', () => {
        void signInWithDevAuth().catch((error) => {
          authStatusEl.textContent = 'Dev sign-in error';
          appendSystemMessage(`Dev sign-in failed: ${error.message}`);
          syncDevAuthUi();
        });
      });

      settingsClose?.addEventListener('click', closeSettingsModal);
      settingsModal?.addEventListener?.('cancel', (event) => {
        event.preventDefault();
        closeSettingsModal();
      });
    }

    return {
      handleMessagesScroll,
      handleJumpLatest,
      handleJumpLastStart,
      bindAsyncClick,
      installCoreEventBindings,
      installActionButtonBindings,
      installShellModalBindings,
    };
  }

  const api = { createController };
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  globalScope.HermesMiniappStartupBindings = api;
})(typeof window !== 'undefined' ? window : globalThis);
