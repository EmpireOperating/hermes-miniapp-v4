(function initHermesMiniappShellUI(globalScope) {
  function createController(deps) {
    const {
      tg,
      pendingChats,
      fullscreenAppTopButton,
      devAuthControls,
      devModeBadge,
      devConfig,
      desktopTestingRequested = false,
      appendSystemMessage,
      scheduleTimeout,
      windowObject = globalScope,
      documentObject = globalScope?.document,
      promptEl = null,
      getActiveChatId = () => 0,
      ensureComposerVisible,
      getMobileQuoteMode = () => false,
    } = deps;


    function setElementHidden(element, hidden) {
      if (!element) return;
      if (hidden) {
        element.setAttribute('hidden', 'hidden');
        return;
      }
      element.removeAttribute('hidden');
    }

    function syncDebugOnlyPillVisibility() {
      const showDevAuthPill = Boolean(devConfig?.devAuthEnabled && desktopTestingRequested);
      const showDebugPills = Boolean(devConfig?.requestDebug && desktopTestingRequested);
      setElementHidden(devAuthControls, !showDevAuthPill);
      setElementHidden(devModeBadge, !showDebugPills);
    }

    function syncClosingConfirmation() {
      if (!tg?.isVersionAtLeast?.('6.2')) return;
      try {
        if (pendingChats.size > 0) {
          tg.enableClosingConfirmation?.();
          return;
        }
        tg.disableClosingConfirmation?.();
      } catch {
        // Best effort only; some Telegram clients expose partial WebApp APIs.
      }
    }

    function syncTelegramChromeForSkin(skin) {
      if (!tg) return;
      const palette = {
        terminal: { header: '#0f1218', background: '#0b0d12' },
        oracle: { header: '#140f1b', background: '#09070c' },
        obsidian: { header: '#0d1216', background: '#080d10' },
      };
      const picked = palette[skin] || palette.terminal;
      try {
        tg.setHeaderColor?.(picked.header);
        tg.setBackgroundColor?.(picked.background);
      } catch {
        // Best effort only; desktop clients vary.
      }
    }

    function syncFullscreenControlState() {
      if (!fullscreenAppTopButton) return;
      const isFullscreen = Boolean(tg?.isFullscreen);
      fullscreenAppTopButton.textContent = isFullscreen ? '🗗' : '⛶';
      fullscreenAppTopButton.title = isFullscreen ? 'Exit fullscreen' : 'Enter fullscreen';
    }

    function handleFullscreenToggle() {
      try {
        if (!tg?.requestFullscreen) {
          appendSystemMessage('Fullscreen is not supported by this Telegram client.');
          return;
        }

        const isFullscreen = Boolean(tg?.isFullscreen);
        if (isFullscreen && tg?.exitFullscreen) {
          tg.exitFullscreen();
        } else {
          tg.requestFullscreen();
        }

        scheduleTimeout(syncFullscreenControlState, 120);
      } catch {
        appendSystemMessage('Fullscreen toggle failed on this Telegram client.');
      }
    }

    let focusComposerForNewChatRequestId = 0;

    function focusComposerForNewChat(chatId) {
      if (!promptEl || promptEl.disabled) return;
      if (Number(getActiveChatId?.()) !== Number(chatId)) return;
      if (documentObject?.visibilityState !== 'visible') return;

      const requestId = ++focusComposerForNewChatRequestId;

      const shouldKeepRetryingFocus = () => {
        if (requestId !== focusComposerForNewChatRequestId) return false;
        if (!promptEl || promptEl.disabled) return false;
        if (Number(getActiveChatId?.()) !== Number(chatId)) return false;
        if (documentObject?.visibilityState !== 'visible') return false;
        if (documentObject?.querySelector?.('dialog[open]')) return false;

        const activeEl = documentObject?.activeElement;
        if (!activeEl) return true;
        if (activeEl === promptEl) return true;
        if (activeEl === documentObject?.body || activeEl === documentObject?.documentElement) return true;
        return false;
      };

      const focusComposer = ({ allowForce = false } = {}) => {
        if (!allowForce && !shouldKeepRetryingFocus()) return;

        ensureComposerVisible?.({ smooth: false });
        if (getMobileQuoteMode?.()) {
          promptEl.focus();
        } else {
          try {
            promptEl.focus({ preventScroll: true });
          } catch {
            promptEl.focus();
          }
        }
        const caret = String(promptEl.value || '').length;
        try {
          promptEl.setSelectionRange?.(caret, caret);
        } catch {
          // Some mobile webviews reject setSelectionRange during keyboard transitions.
        }
        ensureComposerVisible?.({ smooth: false });
      };

      focusComposer({ allowForce: true });
      const raf = windowObject?.requestAnimationFrame || globalScope?.requestAnimationFrame;
      if (typeof raf === 'function') {
        raf(() => focusComposer());
      }
      scheduleTimeout?.(() => focusComposer(), 0);
      scheduleTimeout?.(() => focusComposer(), 180);
    }

    async function confirmAction(message) {
      if (tg?.showPopup) {
        return new Promise((resolve) => {
          tg.showPopup(
            {
              title: 'Confirm',
              message,
              buttons: [
                { id: 'cancel', type: 'cancel' },
                { id: 'ok', type: 'destructive', text: 'Close' },
              ],
            },
            (buttonId) => resolve(buttonId === 'ok'),
          );
        });
      }
      return Boolean(windowObject?.confirm?.(message));
    }

    function handleCloseApp() {
      try {
        if (!tg?.close) {
          appendSystemMessage('Close action is not available on this Telegram client.');
          return;
        }
        tg.close();
      } catch {
        appendSystemMessage('Close action is not available on this Telegram client.');
      }
    }

    return {
      setElementHidden,
      syncDebugOnlyPillVisibility,
      syncClosingConfirmation,
      syncTelegramChromeForSkin,
      syncFullscreenControlState,
      handleFullscreenToggle,
      focusComposerForNewChat,
      confirmAction,
      handleCloseApp,
    };

  }

  const api = { createController };
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  globalScope.HermesMiniappShellUI = api;
})(typeof window !== 'undefined' ? window : globalThis);
