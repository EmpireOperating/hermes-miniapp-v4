(function initHermesMiniappStartupBindings(globalScope) {
  function getCurrentSelection({ windowObject, documentObject }) {
    const windowSelection = windowObject?.getSelection?.();
    if (windowSelection) return windowSelection;
    return documentObject?.getSelection?.() || null;
  }

  function createTranscriptBindingsController(deps) {
    const {
      windowObject,
      documentObject,
      tabsEl,
      pinnedChatsEl,
      pinnedChatsToggleButton,
      messagesEl,
      jumpLatestButton,
      jumpLastStartButton,
      getActiveChatId,
      getRenderedChatId,
      isNearBottomFn,
      chatScrollTop,
      chatStickToBottom,
      histories,
      shouldVirtualizeHistoryFn,
      scheduleActiveMessageView,
      refreshTabNode,
      syncActiveViewportReadState,
      updateJumpLatestVisibility,
      syncActiveMessageView,
      cancelSelectionQuoteSync,
      cancelSelectionQuoteSettle,
      cancelSelectionQuoteClear,
      clearSelectionQuoteState,
      hasMessageSelectionFn,
      scheduleSelectionQuoteSync,
      scheduleSelectionQuoteClear,
      mobileQuoteMode = false,
      noteMobileCarouselInteraction,
      handleTabClick,
      handlePinnedChatClick,
      togglePinnedChatsCollapsed,
      handleGlobalTabCycle,
      handleGlobalArrowJump,
      handleGlobalComposerFocusShortcut,
      handleGlobalChatActionShortcut,
      handleGlobalShortcutsHelpShortcut,
      handleGlobalControlEnterDefuse,
      handleGlobalControlMouseDownFocusGuard,
      handleGlobalControlClickFocusCleanup,
    } = deps;

    function handleMessagesScroll() {
      const selection = getCurrentSelection({ windowObject, documentObject });
      const hasActiveMessageSelection = Boolean(hasMessageSelectionFn?.(selection));
      cancelSelectionQuoteSync();
      cancelSelectionQuoteSettle();
      cancelSelectionQuoteClear();
      if (hasActiveMessageSelection) {
        scheduleSelectionQuoteSync?.(mobileQuoteMode ? 220 : 120);
      } else if (mobileQuoteMode) {
        // Mobile WebViews can briefly report an empty/collapsed selection while
        // the page scrolls under native drag handles. Clearing immediately here
        // makes the Quote affordance disappear mid-adjustment; defer the clear so
        // selectionchange/touchend can restore the popup if the selection returns.
        scheduleSelectionQuoteClear?.(220);
      } else {
        clearSelectionQuoteState();
      }

      const key = Number(getActiveChatId());
      if (!key || Number(getRenderedChatId()) !== key) return;

      const atBottom = isNearBottomFn(messagesEl, 40);
      chatScrollTop.set(key, messagesEl.scrollTop);
      chatStickToBottom.set(key, atBottom);
      syncActiveViewportReadState(key, {
        atBottom,
        onViewportBottom: refreshTabNode,
      });
      updateJumpLatestVisibility();

      const historyLength = (histories.get(key) || []).length;
      if (shouldVirtualizeHistoryFn(historyLength)) {
        scheduleActiveMessageView(key);
      }
    }

    function handleJumpLatest() {
      const key = Number(getActiveChatId());
      if (!key) return;

      syncActiveViewportReadState(key, {
        atBottom: true,
        forceMarkRead: true,
        onViewportBottom: refreshTabNode,
      });
      syncActiveMessageView(key, { forceBottom: true });
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

    function installCoreEventBindings() {
      tabsEl.addEventListener('click', handleTabClick);
      tabsEl.addEventListener('scroll', noteMobileCarouselInteraction, { passive: true });
      tabsEl.addEventListener('touchstart', noteMobileCarouselInteraction, { passive: true });
      tabsEl.addEventListener('pointerdown', noteMobileCarouselInteraction, { passive: true });
      pinnedChatsEl?.addEventListener('click', handlePinnedChatClick);
      pinnedChatsToggleButton?.addEventListener('click', togglePinnedChatsCollapsed);
      documentObject.addEventListener('keydown', handleGlobalTabCycle);
      documentObject.addEventListener('keydown', handleGlobalArrowJump);
      documentObject.addEventListener('keydown', handleGlobalComposerFocusShortcut);
      documentObject.addEventListener('keydown', handleGlobalChatActionShortcut);
      documentObject.addEventListener('keydown', handleGlobalShortcutsHelpShortcut);
      documentObject.addEventListener('keydown', handleGlobalControlEnterDefuse, true);
      documentObject.addEventListener('mousedown', handleGlobalControlMouseDownFocusGuard, true);
      documentObject.addEventListener('click', handleGlobalControlClickFocusCleanup, true);
      messagesEl.addEventListener('scroll', handleMessagesScroll);
      jumpLatestButton?.addEventListener('click', handleJumpLatest);
      jumpLastStartButton?.addEventListener('click', handleJumpLastStart);
    }

    return {
      handleMessagesScroll,
      handleJumpLatest,
      handleJumpLastStart,
      installCoreEventBindings,
    };
  }

  function createActionBindingsController(deps) {
    const {
      skinButtons,
      telegramUnreadNotificationsToggle,
      newChatButton,
      renameChatButton,
      pinChatButton,
      removeChatButton,
      getIsAuthenticated,
      getTelegramUnreadNotificationsEnabled,
      appendSystemMessage,
      saveSkinPreference,
      saveTelegramUnreadNotificationsPreference,
      closeSettingsModal,
      createChat,
      renameActiveChat,
      toggleActiveChatPin,
      removeActiveChat,
      reportUiError,
    } = deps;

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

      telegramUnreadNotificationsToggle?.addEventListener('change', () => {
        void (async () => {
          const previousValue = Boolean(getTelegramUnreadNotificationsEnabled?.());
          const nextValue = Boolean(telegramUnreadNotificationsToggle.checked);
          if (!getIsAuthenticated()) {
            telegramUnreadNotificationsToggle.checked = previousValue;
            appendSystemMessage('Still signing you in. Try again in a moment.');
            return;
          }
          try {
            await saveTelegramUnreadNotificationsPreference?.(nextValue);
          } catch (error) {
            telegramUnreadNotificationsToggle.checked = previousValue;
            reportUiError(error);
          }
        })();
      });

      bindAsyncClick(newChatButton, createChat);
      bindAsyncClick(renameChatButton, renameActiveChat);
      bindAsyncClick(pinChatButton, toggleActiveChatPin);
      bindAsyncClick(removeChatButton, removeActiveChat);
    }

    return {
      bindAsyncClick,
      installActionButtonBindings,
    };
  }

  function createStartupBootstrapController(deps) {
    const {
      windowObject,
      documentObject,
      messagesEl,
      authStatusEl,
      operatorNameEl,
      tabsEl,
      formEl,
      promptEl,
      sendButton,
      templateEl,
      tg,
      appendSystemMessage,
      syncDevAuthUi,
      getIsAuthenticated,
      syncRenderTraceBadge,
      loadDraftsFromStorage,
      syncClosingConfirmation,
      syncFullscreenControlState,
      setInitData,
      getInitData,
      getRenderTraceDebugEnabled,
      renderTraceLog,
      maybeRefreshForBootstrapVersionMismatch,
      isMobileBootstrapPath = () => false,
      skipTelegramWebappSetup = false,
      logBootStage,
      syncBootLatencyChip,
      fetchAuthBootstrapWithRetry,
      desktopTestingEnabled,
      desktopTestingRequested,
      devConfig,
      applyAuthBootstrap,
      signInWithDevAuth,
      hasFreshPendingStreamSnapshot,
      restorePendingStreamSnapshot,
      restoreActiveBootstrapPendingState,
      renderMessages,
      updateComposerState,
      syncUnreadNotificationPresence,
      revealShell,
      recordBootMetric,
      summarizeBootMetrics,
      getChatsSize,
      isActiveChatPending,
    } = deps;

    function getMissingBootstrapBindings() {
      const requiredBindings = [
        ['status chip', authStatusEl, '#auth-status'],
        ['operator name', operatorNameEl, '#operator-name'],
        ['chat tabs', tabsEl, '#chat-tabs'],
        ['message log', messagesEl, '#messages'],
        ['composer form', formEl, '#chat-form'],
        ['composer input', promptEl, '#prompt'],
        ['send button', sendButton, '#send-button'],
        ['message template', templateEl, '#message-template'],
      ];
      return requiredBindings
        .filter(([, node]) => !node)
        .map(([label, , selector]) => `${label} (${selector})`);
    }

    function reportBootstrapMismatch(reason, details = []) {
      const suffix = Array.isArray(details) && details.length ? ` Missing: ${details.join(', ')}.` : '';
      const message = `${reason}.${suffix} Reload the mini app to refresh assets.`;
      if (authStatusEl) {
        authStatusEl.textContent = 'Client bootstrap mismatch';
        authStatusEl.title = message;
      }
      if (messagesEl && templateEl) {
        appendSystemMessage(message);
        return;
      }
      windowObject?.console?.error?.('[miniapp/bootstrap]', message);
    }

    async function bootstrap() {
      logBootStage?.('bootstrap-start', { hasTelegram: Boolean(tg) });
      if (authStatusEl) {
        authStatusEl.textContent = tg ? 'Opening Hermes…' : 'Waiting for Telegram…';
      }
      syncBootLatencyChip?.('bootstrap-start');

      if (tg && !skipTelegramWebappSetup) {
        try {
          tg.ready?.();
          tg.disableVerticalSwipes?.();
          tg.expand?.();
          logBootStage?.('telegram-webapp-ready');
        } catch {
          // Non-fatal: proceed with auth even when client WebApp helpers partially fail.
        }
      } else if (tg && skipTelegramWebappSetup) {
        logBootStage?.('telegram-webapp-skipped-embedded-preview');
      }

      syncRenderTraceBadge?.();
      loadDraftsFromStorage?.();
      syncClosingConfirmation?.();
      syncFullscreenControlState?.();
      syncDevAuthUi?.();
      try {
        if (!skipTelegramWebappSetup) {
          tg?.onEvent?.('fullscreenChanged', syncFullscreenControlState);
          tg?.onEvent?.('fullscreenFailed', () => appendSystemMessage('Fullscreen request was denied by Telegram client.'));
        }
      } catch {
        // Optional event hooks vary across Telegram clients.
      }
      setInitData?.(tg?.initData || '');
      renderTraceLog?.('debug-enabled', {
        enabled: Boolean(getRenderTraceDebugEnabled?.()),
        toggleHint: 'Open Settings and tap Render Trace to toggle logging',
      });

      const missingBindings = getMissingBootstrapBindings();
      if (missingBindings.length) {
        reportBootstrapMismatch('Required startup bindings are missing', missingBindings);
        syncDevAuthUi?.();
        updateComposerState?.();
        revealShell?.();
        return;
      }

      const mobileBootstrapPath = Boolean(isMobileBootstrapPath?.());
      if (!mobileBootstrapPath) {
        logBootStage?.('version-check-start');
        if (await maybeRefreshForBootstrapVersionMismatch?.()) {
          logBootStage?.('version-check-finished', { refreshed: true });
          revealShell?.();
          return;
        }
        logBootStage?.('version-check-finished', { refreshed: false });
      } else {
        logBootStage?.('version-check-skipped-mobile');
      }

      try {
        logBootStage?.('auth-request-dispatched', {
          hasTelegramInitData: Boolean(getInitData?.()),
        });
        const { response, data } = await fetchAuthBootstrapWithRetry();
        logBootStage?.('auth-response-received', {
          status: Number(response?.status || 0),
          ok: Boolean(response?.ok && data?.ok),
        });

        if (!response.ok || !data?.ok) {
          if (desktopTestingEnabled) {
            const autoSignedIn = await signInWithDevAuth({ interactive: false });
            if (autoSignedIn) {
              return;
            }
            authStatusEl.textContent = 'Desktop testing ready';
            appendSystemMessage(data?.error || 'Use /app#dev-auth to open Dev sign-in outside Telegram.');
            return;
          }
          if (desktopTestingRequested && !Boolean(devConfig?.devAuthEnabled)) {
            authStatusEl.textContent = 'Debug sign-in unavailable';
            appendSystemMessage('Dev auth is currently disabled. Enable the bypass flag, then reload /app#dev-auth.');
            return;
          }
          authStatusEl.textContent = 'Sign-in failed';
          appendSystemMessage(data?.error || (tg ? 'Sign-in failed.' : 'Open this mini app from Telegram.'));
          return;
        }

        applyAuthBootstrap(data, { preferredUsername: tg?.initDataUnsafe?.user?.username || '' });
        logBootStage?.('auth-bootstrap-applied', {
          activeChatId: Number(data?.active_chat_id || 0),
          chatCount: Array.isArray(data?.chats) ? data.chats.length : 0,
        });
        const activeChatId = Number(data?.active_chat_id || 0);
        const serverPendingActiveChat = activeChatId > 0 && Boolean(data?.chats?.find?.((chat) => Number(chat?.id) === activeChatId)?.pending);
        const pendingRestoreState = activeChatId > 0 && typeof restoreActiveBootstrapPendingState === 'function'
          ? restoreActiveBootstrapPendingState(activeChatId, {
            serverPending: serverPendingActiveChat,
            onRestored: (chatId) => {
              renderMessages(Number(chatId), { preserveViewport: true });
            },
          })
          : (() => {
            const localPendingSnapshot = activeChatId > 0 && typeof hasFreshPendingStreamSnapshot === 'function'
              ? Boolean(hasFreshPendingStreamSnapshot(activeChatId))
              : false;
            const restoredPendingSnapshot = activeChatId > 0 && typeof restorePendingStreamSnapshot === 'function' && (serverPendingActiveChat || localPendingSnapshot)
              ? Boolean(restorePendingStreamSnapshot(activeChatId))
              : false;
            return {
              localPendingSnapshot,
              restoredPendingSnapshot,
            };
          })();
        const restoredPendingSnapshot = Boolean(pendingRestoreState?.restoredPendingSnapshot);
        if (restoredPendingSnapshot && Number(data?.active_chat_id || 0) > 0 && typeof restoreActiveBootstrapPendingState !== 'function') {
          renderMessages(Number(data.active_chat_id), { preserveViewport: true });
        }
        if (activeChatId > 0 && documentObject.visibilityState === 'visible') {
          await syncUnreadNotificationPresence?.({ visible: true, chatId: activeChatId });
        }
      } catch (error) {
        recordBootMetric?.('bootstrapErrorMs');
        const alreadyAuthenticated = Boolean(getIsAuthenticated?.());
        if (alreadyAuthenticated) {
          logBootStage?.('post-auth-bootstrap-sync-failed', {
            message: String(error?.message || error || ''),
          });
          appendSystemMessage(`Signed in, but startup sync hit an error: ${error.message}`);
        } else {
          authStatusEl.textContent = 'Sign-in error';
          appendSystemMessage(`Could not start the app: ${error.message}`);
        }
      } finally {
        // Telegram mobile/webview sessions can linger for a long time while the backend rolls.
        // Auto-reloading after auth makes the mini app feel like it is "randomly refreshing"
        // during normal use, so keep mobile boots stable and let the next fresh open pick up
        // the new bootstrap version naturally.
        syncDevAuthUi?.();
        updateComposerState?.();
        revealShell?.();
        logBootStage?.('bootstrap-finished', { authenticated: Boolean(getIsAuthenticated()) });
        summarizeBootMetrics?.({
          authenticated: Boolean(getIsAuthenticated()),
          activeChatId: Number(deps.getActiveChatId?.() || 0),
          chatCount: Number(getChatsSize?.() || 0),
          pendingActiveChat: Boolean(isActiveChatPending?.()),
          mobileBootstrapPath,
          hasTelegram: Boolean(tg),
          hasTelegramInitData: Boolean(getInitData?.()),
          telegramUserId: Number(tg?.initDataUnsafe?.user?.id || 0) || null,
          telegramUsername: String(tg?.initDataUnsafe?.user?.username || '').trim(),
          preAuthVersionCheckBlockedAuth: !mobileBootstrapPath,
        });
      }
    }

    return {
      getMissingBootstrapBindings,
      reportBootstrapMismatch,
      bootstrap,
    };
  }

  function createShellModalController(deps) {
    const {
      fullscreenAppTopButton,
      closeAppTopButton,
      renderTraceBadge,
      settingsButton,
      keyboardShortcutsTopButton,
      keyboardShortcutsButton,
      devSignInButton,
      settingsClose,
      keyboardShortcutsClose,
      settingsModal,
      keyboardShortcutsModal,
      handleFullscreenToggle,
      handleCloseApp,
      handleRenderTraceBadgeClick,
      openSettingsModal,
      closeSettingsModal,
      openKeyboardShortcutsModal,
      closeKeyboardShortcutsModal,
      signInWithDevAuth,
      authStatusEl,
      appendSystemMessage,
      syncDevAuthUi,
    } = deps;

    function installShellModalBindings() {
      fullscreenAppTopButton?.addEventListener('click', handleFullscreenToggle);
      closeAppTopButton?.addEventListener('click', handleCloseApp);
      renderTraceBadge?.addEventListener('click', handleRenderTraceBadgeClick);
      settingsButton?.addEventListener('click', openSettingsModal);
      keyboardShortcutsTopButton?.addEventListener('click', openKeyboardShortcutsModal);
      keyboardShortcutsButton?.addEventListener('click', openKeyboardShortcutsModal);
      devSignInButton?.addEventListener('click', () => {
        void (async () => {
          try {
            await signInWithDevAuth();
          } catch (error) {
            authStatusEl.textContent = 'Dev sign-in error';
            appendSystemMessage(`Dev sign-in failed: ${error?.message || String(error)}`);
            syncDevAuthUi();
          }
        })();
      });

      settingsClose?.addEventListener('click', closeSettingsModal);
      keyboardShortcutsClose?.addEventListener('click', closeKeyboardShortcutsModal);
      settingsModal?.addEventListener?.('cancel', (event) => {
        event.preventDefault();
        closeSettingsModal();
      });
      keyboardShortcutsModal?.addEventListener?.('cancel', (event) => {
        event.preventDefault();
        closeKeyboardShortcutsModal();
      });
    }

    return { installShellModalBindings };
  }

  function createPendingWatchdogController(deps) {
    const {
      windowObject,
      documentObject,
      pendingChats,
      getIsAuthenticated,
      getActiveChatId,
      refreshChats,
      syncVisibleActiveChat,
      getStreamAbortControllers,
    } = deps;

    function installPendingCompletionWatchdog() {
      const intervalMs = 8000;
      windowObject.setInterval(() => {
        if (!getIsAuthenticated() || pendingChats.size === 0) return;
        void (async () => {
          try {
            await refreshChats();
            if (Number(getActiveChatId()) > 0 && pendingChats.has(Number(getActiveChatId()))) {
              await syncVisibleActiveChat({
                hidden: documentObject.visibilityState !== 'visible',
                streamAbortControllers: getStreamAbortControllers(),
              });
            }
          } catch {
            // Best-effort watchdog: healthy streams still finalize through normal SSE handling.
          }
        })();
      }, intervalMs);
    }

    return { installPendingCompletionWatchdog };
  }

  function createController(deps) {
    const transcriptBindingsController = createTranscriptBindingsController({
      windowObject: deps.windowObject,
      documentObject: deps.documentObject,
      tabsEl: deps.tabsEl,
      pinnedChatsEl: deps.pinnedChatsEl,
      pinnedChatsToggleButton: deps.pinnedChatsToggleButton,
      messagesEl: deps.messagesEl,
      jumpLatestButton: deps.jumpLatestButton,
      jumpLastStartButton: deps.jumpLastStartButton,
      getActiveChatId: deps.getActiveChatId,
      getRenderedChatId: deps.getRenderedChatId,
      isNearBottomFn: deps.isNearBottomFn,
      chatScrollTop: deps.chatScrollTop,
      chatStickToBottom: deps.chatStickToBottom,
      histories: deps.histories,
      shouldVirtualizeHistoryFn: deps.shouldVirtualizeHistoryFn,
      scheduleActiveMessageView: deps.scheduleActiveMessageView,
      refreshTabNode: deps.refreshTabNode,
      syncActiveViewportReadState: deps.syncActiveViewportReadState,
      updateJumpLatestVisibility: deps.updateJumpLatestVisibility,
      syncActiveMessageView: deps.syncActiveMessageView,
      cancelSelectionQuoteSync: deps.cancelSelectionQuoteSync,
      cancelSelectionQuoteSettle: deps.cancelSelectionQuoteSettle,
      cancelSelectionQuoteClear: deps.cancelSelectionQuoteClear,
      clearSelectionQuoteState: deps.clearSelectionQuoteState,
      hasMessageSelectionFn: deps.hasMessageSelectionFn,
      scheduleSelectionQuoteSync: deps.scheduleSelectionQuoteSync,
      scheduleSelectionQuoteClear: deps.scheduleSelectionQuoteClear,
      mobileQuoteMode: deps.mobileQuoteMode,
      noteMobileCarouselInteraction: deps.noteMobileCarouselInteraction,
      handleTabClick: deps.handleTabClick,
      handlePinnedChatClick: deps.handlePinnedChatClick,
      togglePinnedChatsCollapsed: deps.togglePinnedChatsCollapsed,
      handleGlobalTabCycle: deps.handleGlobalTabCycle,
      handleGlobalArrowJump: deps.handleGlobalArrowJump,
      handleGlobalComposerFocusShortcut: deps.handleGlobalComposerFocusShortcut,
      handleGlobalChatActionShortcut: deps.handleGlobalChatActionShortcut,
      handleGlobalShortcutsHelpShortcut: deps.handleGlobalShortcutsHelpShortcut,
      handleGlobalControlEnterDefuse: deps.handleGlobalControlEnterDefuse,
      handleGlobalControlMouseDownFocusGuard: deps.handleGlobalControlMouseDownFocusGuard,
      handleGlobalControlClickFocusCleanup: deps.handleGlobalControlClickFocusCleanup,
    });
    const actionBindingsController = createActionBindingsController({
      skinButtons: deps.skinButtons,
      telegramUnreadNotificationsToggle: deps.telegramUnreadNotificationsToggle,
      newChatButton: deps.newChatButton,
      renameChatButton: deps.renameChatButton,
      pinChatButton: deps.pinChatButton,
      removeChatButton: deps.removeChatButton,
      getIsAuthenticated: deps.getIsAuthenticated,
      getTelegramUnreadNotificationsEnabled: deps.getTelegramUnreadNotificationsEnabled,
      appendSystemMessage: deps.appendSystemMessage,
      saveSkinPreference: deps.saveSkinPreference,
      saveTelegramUnreadNotificationsPreference: deps.saveTelegramUnreadNotificationsPreference,
      closeSettingsModal: deps.closeSettingsModal,
      createChat: deps.createChat,
      renameActiveChat: deps.renameActiveChat,
      toggleActiveChatPin: deps.toggleActiveChatPin,
      removeActiveChat: deps.removeActiveChat,
      reportUiError: deps.reportUiError,
    });
    const startupBootstrapController = createStartupBootstrapController({
      windowObject: deps.windowObject,
      documentObject: deps.documentObject,
      messagesEl: deps.messagesEl,
      authStatusEl: deps.authStatusEl,
      operatorNameEl: deps.operatorNameEl,
      tabsEl: deps.tabsEl,
      formEl: deps.formEl,
      promptEl: deps.promptEl,
      sendButton: deps.sendButton,
      templateEl: deps.templateEl,
      tg: deps.tg,
      appendSystemMessage: deps.appendSystemMessage,
      syncDevAuthUi: deps.syncDevAuthUi,
      getIsAuthenticated: deps.getIsAuthenticated,
      syncRenderTraceBadge: deps.syncRenderTraceBadge,
      loadDraftsFromStorage: deps.loadDraftsFromStorage,
      syncClosingConfirmation: deps.syncClosingConfirmation,
      syncFullscreenControlState: deps.syncFullscreenControlState,
      setInitData: deps.setInitData,
      getInitData: deps.getInitData,
      getRenderTraceDebugEnabled: deps.getRenderTraceDebugEnabled,
      renderTraceLog: deps.renderTraceLog,
      maybeRefreshForBootstrapVersionMismatch: deps.maybeRefreshForBootstrapVersionMismatch,
      isMobileBootstrapPath: deps.isMobileBootstrapPath,
      skipTelegramWebappSetup: deps.skipTelegramWebappSetup,
      logBootStage: deps.logBootStage,
      syncBootLatencyChip: deps.syncBootLatencyChip,
      fetchAuthBootstrapWithRetry: deps.fetchAuthBootstrapWithRetry,
      desktopTestingEnabled: deps.desktopTestingEnabled,
      desktopTestingRequested: deps.desktopTestingRequested,
      devConfig: deps.devConfig,
      applyAuthBootstrap: deps.applyAuthBootstrap,
      signInWithDevAuth: deps.signInWithDevAuth,
      hasFreshPendingStreamSnapshot: deps.hasFreshPendingStreamSnapshot,
      restorePendingStreamSnapshot: deps.restorePendingStreamSnapshot,
      restoreActiveBootstrapPendingState: deps.restoreActiveBootstrapPendingState,
      renderMessages: deps.renderMessages,
      updateComposerState: deps.updateComposerState,
      syncUnreadNotificationPresence: deps.syncUnreadNotificationPresence,
      revealShell: deps.revealShell,
      recordBootMetric: deps.recordBootMetric,
      summarizeBootMetrics: deps.summarizeBootMetrics,
      getChatsSize: deps.getChatsSize,
      isActiveChatPending: deps.isActiveChatPending,
      getActiveChatId: deps.getActiveChatId,
    });
    const shellModalController = createShellModalController({
      fullscreenAppTopButton: deps.fullscreenAppTopButton,
      closeAppTopButton: deps.closeAppTopButton,
      renderTraceBadge: deps.renderTraceBadge,
      settingsButton: deps.settingsButton,
      keyboardShortcutsTopButton: deps.keyboardShortcutsTopButton,
      keyboardShortcutsButton: deps.keyboardShortcutsButton,
      devSignInButton: deps.devSignInButton,
      settingsClose: deps.settingsClose,
      keyboardShortcutsClose: deps.keyboardShortcutsClose,
      settingsModal: deps.settingsModal,
      keyboardShortcutsModal: deps.keyboardShortcutsModal,
      handleFullscreenToggle: deps.handleFullscreenToggle,
      handleCloseApp: deps.handleCloseApp,
      handleRenderTraceBadgeClick: deps.handleRenderTraceBadgeClick,
      openSettingsModal: deps.openSettingsModal,
      closeSettingsModal: deps.closeSettingsModal,
      openKeyboardShortcutsModal: deps.openKeyboardShortcutsModal,
      closeKeyboardShortcutsModal: deps.closeKeyboardShortcutsModal,
      signInWithDevAuth: deps.signInWithDevAuth,
      authStatusEl: deps.authStatusEl,
      appendSystemMessage: deps.appendSystemMessage,
      syncDevAuthUi: deps.syncDevAuthUi,
    });
    const pendingWatchdogController = createPendingWatchdogController({
      windowObject: deps.windowObject,
      documentObject: deps.documentObject,
      pendingChats: deps.pendingChats,
      getIsAuthenticated: deps.getIsAuthenticated,
      getActiveChatId: deps.getActiveChatId,
      refreshChats: deps.refreshChats,
      syncVisibleActiveChat: deps.syncVisibleActiveChat,
      getStreamAbortControllers: deps.getStreamAbortControllers,
    });

    return {
      handleMessagesScroll: transcriptBindingsController.handleMessagesScroll,
      handleJumpLatest: transcriptBindingsController.handleJumpLatest,
      handleJumpLastStart: transcriptBindingsController.handleJumpLastStart,
      bindAsyncClick: actionBindingsController.bindAsyncClick,
      installCoreEventBindings: transcriptBindingsController.installCoreEventBindings,
      installActionButtonBindings: actionBindingsController.installActionButtonBindings,
      installShellModalBindings: shellModalController.installShellModalBindings,
      getMissingBootstrapBindings: startupBootstrapController.getMissingBootstrapBindings,
      reportBootstrapMismatch: startupBootstrapController.reportBootstrapMismatch,
      bootstrap: startupBootstrapController.bootstrap,
      installPendingCompletionWatchdog: pendingWatchdogController.installPendingCompletionWatchdog,
    };
  }

  const api = {
    createTranscriptBindingsController,
    createActionBindingsController,
    createStartupBootstrapController,
    createShellModalController,
    createPendingWatchdogController,
    createController,
  };
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  globalScope.HermesMiniappStartupBindings = api;
})(typeof window !== 'undefined' ? window : globalThis);
