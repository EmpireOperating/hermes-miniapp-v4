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
      operatorNameEl,
      formEl,
      promptEl,
      sendButton,
      templateEl,
      tg,
      getActiveChatId,
      getRenderedChatId,
      isNearBottomFn,
      chatScrollTop,
      chatStickToBottom,
      unseenStreamChats,
      histories,
      chats,
      pendingChats,
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
      handleGlobalChatActionShortcut,
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
      logBootStage,
      syncBootLatencyChip,
      fetchAuthBootstrapWithRetry,
      desktopTestingEnabled,
      desktopTestingRequested,
      devConfig,
      applyAuthBootstrap,
      hasFreshPendingStreamSnapshot,
      restorePendingStreamSnapshot,
      renderMessages,
      updateComposerState,
      revealShell,
      recordBootMetric,
      summarizeBootMetrics,
      getChatsSize,
      isActiveChatPending,
      refreshChats,
      syncVisibleActiveChat,
      getStreamAbortControllers,
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
      }
      maybeMarkRead(key);
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
      documentObject.addEventListener('keydown', handleGlobalChatActionShortcut);
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
      settingsModal?.addEventListener?.('cancel', (event) => {
        event.preventDefault();
        closeSettingsModal();
      });
    }

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

      if (tg) {
        try {
          tg.ready?.();
          tg.expand?.();
          logBootStage?.('telegram-webapp-ready');
        } catch {
          // Non-fatal: proceed with auth even when client WebApp helpers partially fail.
        }
      }

      syncRenderTraceBadge?.();
      loadDraftsFromStorage?.();
      syncClosingConfirmation?.();
      syncFullscreenControlState?.();
      syncDevAuthUi?.();
      try {
        tg?.onEvent?.('fullscreenChanged', syncFullscreenControlState);
        tg?.onEvent?.('fullscreenFailed', () => appendSystemMessage('Fullscreen request was denied by Telegram client.'));
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
        const localPendingSnapshot = activeChatId > 0 && typeof hasFreshPendingStreamSnapshot === 'function'
          ? Boolean(hasFreshPendingStreamSnapshot(activeChatId))
          : false;
        const restoredPendingSnapshot = activeChatId > 0 && typeof restorePendingStreamSnapshot === 'function' && (serverPendingActiveChat || localPendingSnapshot)
          ? Boolean(restorePendingStreamSnapshot(activeChatId))
          : false;
        if (restoredPendingSnapshot && Number(data?.active_chat_id || 0) > 0) {
          renderMessages(Number(data.active_chat_id), { preserveViewport: true });
        }
      } catch (error) {
        recordBootMetric?.('bootstrapErrorMs');
        authStatusEl.textContent = 'Sign-in error';
        appendSystemMessage(`Could not start the app: ${error.message}`);
      } finally {
        if (mobileBootstrapPath && typeof maybeRefreshForBootstrapVersionMismatch === 'function' && Boolean(getIsAuthenticated())) {
          windowObject?.setTimeout?.(() => {
            void maybeRefreshForBootstrapVersionMismatch().catch?.(() => {});
          }, 0);
        }
        syncDevAuthUi?.();
        updateComposerState?.();
        revealShell?.();
        logBootStage?.('bootstrap-finished', { authenticated: Boolean(getIsAuthenticated()) });
        summarizeBootMetrics?.({
          authenticated: Boolean(getIsAuthenticated()),
          activeChatId: Number(getActiveChatId?.() || 0),
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

    function installPendingCompletionWatchdog() {
      const intervalMs = 8000;
      windowObject.setInterval(() => {
        if (!getIsAuthenticated() || pendingChats.size === 0) return;
        void (async () => {
          try {
            if (await maybeRefreshForBootstrapVersionMismatch?.()) {
              return;
            }
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

    return {
      handleMessagesScroll,
      handleJumpLatest,
      handleJumpLastStart,
      bindAsyncClick,
      installCoreEventBindings,
      installActionButtonBindings,
      installShellModalBindings,
      getMissingBootstrapBindings,
      reportBootstrapMismatch,
      bootstrap,
      installPendingCompletionWatchdog,
    };
  }

  const api = { createController };
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  globalScope.HermesMiniappStartupBindings = api;
})(typeof window !== 'undefined' ? window : globalThis);
