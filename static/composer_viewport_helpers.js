(function initHermesMiniappComposerViewport(globalScope) {
  function createController(deps) {
    const {
      windowObject,
      documentObject,
      tg,
      promptEl,
      form,
      messagesEl,
      tabsEl,
      mobileQuoteMode,
      isNearBottomFn,
      getActiveChatId,
      chatScrollTop,
      chatStickToBottom,
      updateJumpLatestVisibility,
    } = deps;

    let viewportMutationSeq = 0;
    let focusComposerForNewChatRequestId = 0;

    function syncViewportCssVars() {
      const rootStyle = documentObject?.documentElement?.style;
      if (!rootStyle?.setProperty) return;
      const viewport = windowObject.visualViewport;
      const viewportHeight = Math.max(0, Number(viewport?.height || windowObject.innerHeight || 0));
      const viewportTop = Math.max(0, Number(viewport?.offsetTop || 0));
      rootStyle.setProperty('--hermes-visual-viewport-height', `${Math.round(viewportHeight)}px`);
      rootStyle.setProperty('--hermes-visual-viewport-top', `${Math.round(viewportTop)}px`);
    }

    function captureMessageViewportSnapshot() {
      if (!messagesEl) return null;
      const scrollTop = Math.max(0, Number(messagesEl.scrollTop) || 0);
      const nodes = messagesEl.querySelectorAll?.('.message') || [];
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
      return { scrollTop, messageKey: '', offsetWithinMessage: 0 };
    }

    function restoreMessageViewportSnapshot(snapshot) {
      if (!messagesEl || !snapshot) return false;
      const messageKey = String(snapshot?.messageKey || '');
      if (messageKey) {
        const anchorNode = messagesEl.querySelector?.(`.message[data-message-key="${messageKey}"]`);
        const anchorTop = Number(anchorNode?.offsetTop);
        if (anchorNode && Number.isFinite(anchorTop)) {
          messagesEl.scrollTop = Math.max(0, anchorTop + (Number(snapshot?.offsetWithinMessage) || 0));
          return true;
        }
      }
      messagesEl.scrollTop = Math.max(0, Number(snapshot?.scrollTop) || 0);
      return true;
    }

    function ensureComposerVisible({ smooth = false } = {}) {
      if (!promptEl || !form) return;

      const behavior = smooth ? 'smooth' : 'auto';
      form.scrollIntoView({ block: 'end', inline: 'nearest', behavior });

      const viewport = windowObject.visualViewport;
      const viewportTop = Number(viewport?.offsetTop || 0);
      const viewportBottom = viewport
        ? Number(viewport.offsetTop + viewport.height)
        : Number(windowObject.innerHeight || 0);

      if (viewportBottom > viewportTop) {
        const rect = promptEl.getBoundingClientRect();
        const topSafe = viewportTop + 8;
        const bottomSafe = viewportBottom - 10;

        if (rect.bottom > bottomSafe) {
          const deltaDown = rect.bottom - bottomSafe;
          windowObject.scrollBy({ top: deltaDown, left: 0, behavior: 'auto' });
        } else if (rect.top < topSafe) {
          const deltaUp = rect.top - topSafe;
          windowObject.scrollBy({ top: deltaUp, left: 0, behavior: 'auto' });
        }
      }
    }

    function runAfterUiMutation(callback) {
      let settled = false;
      let timeoutId = null;
      let rafId = null;

      const finalize = () => {
        if (settled) return;
        settled = true;
        if (timeoutId != null) {
          windowObject.clearTimeout(timeoutId);
        }
        if (rafId != null && typeof globalScope.cancelAnimationFrame === 'function') {
          globalScope.cancelAnimationFrame(rafId);
        }
        callback();
      };

      if (typeof globalScope.requestAnimationFrame === 'function') {
        rafId = globalScope.requestAnimationFrame(finalize);
      }

      timeoutId = windowObject.setTimeout(finalize, documentObject.visibilityState === 'visible' ? 34 : 0);
    }

    function preserveViewportDuringUiMutation(mutator) {
      const key = Number(getActiveChatId?.());
      const hasActiveChat = Number.isInteger(key) && key > 0;
      const previousViewport = captureMessageViewportSnapshot();
      const previousWindowScrollY = Number(windowObject.scrollY || 0);
      const wasNearBottom = Boolean(messagesEl && isNearBottomFn?.(messagesEl, 40));
      const mutationSeq = ++viewportMutationSeq;

      mutator();

      if (!hasActiveChat || !messagesEl || !previousViewport) {
        return;
      }

      runAfterUiMutation(() => {
        if (mutationSeq !== viewportMutationSeq) return;
        if (Number(getActiveChatId?.()) !== key) return;

        const shouldStickBottom = wasNearBottom;
        if (shouldStickBottom) {
          messagesEl.scrollTop = messagesEl.scrollHeight;
          if (mobileQuoteMode) {
            // Mobile webviews can settle layout one more tick later; keep bottom lock stable.
            windowObject.setTimeout(() => {
              if (mutationSeq !== viewportMutationSeq) return;
              if (Number(getActiveChatId?.()) !== key) return;
              messagesEl.scrollTop = messagesEl.scrollHeight;
              chatScrollTop?.set?.(key, messagesEl.scrollTop);
              chatStickToBottom?.set?.(key, true);
              updateJumpLatestVisibility?.();
            }, 0);
          }
          chatScrollTop?.set?.(key, messagesEl.scrollTop);
          chatStickToBottom?.set?.(key, true);
        } else {
          restoreMessageViewportSnapshot(previousViewport);
          chatScrollTop?.set?.(key, messagesEl.scrollTop);
          chatStickToBottom?.set?.(key, false);
        }
        updateJumpLatestVisibility?.();

        if (!mobileQuoteMode && Math.abs((windowObject.scrollY || 0) - previousWindowScrollY) > 1) {
          windowObject.scrollTo({ top: previousWindowScrollY, left: 0, behavior: 'auto' });
        }
      });
    }

    function focusComposerForNewChat(chatId) {
      if (!promptEl || promptEl.disabled) return;
      if (Number(getActiveChatId?.()) !== Number(chatId)) return;
      if (documentObject.visibilityState !== 'visible') return;

      const requestId = ++focusComposerForNewChatRequestId;

      const shouldKeepRetryingFocus = () => {
        if (requestId !== focusComposerForNewChatRequestId) return false;
        if (!promptEl || promptEl.disabled) return false;
        if (Number(getActiveChatId?.()) !== Number(chatId)) return false;
        if (documentObject.visibilityState !== 'visible') return false;
        if (documentObject.querySelector?.('dialog[open]')) return false;

        const activeEl = documentObject.activeElement;
        if (!activeEl) return true;
        if (activeEl === promptEl) return true;
        if (activeEl === documentObject.body || activeEl === documentObject.documentElement) return true;
        return false;
      };

      const focusComposer = ({ allowForce = false } = {}) => {
        if (!allowForce && !shouldKeepRetryingFocus()) return;

        ensureComposerVisible({ smooth: false });
        if (mobileQuoteMode) {
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
        ensureComposerVisible({ smooth: false });
      };

      focusComposer({ allowForce: true });
      const raf = windowObject.requestAnimationFrame || globalScope.requestAnimationFrame;
      if (typeof raf === 'function') {
        raf(() => focusComposer());
      }
      windowObject.setTimeout(() => focusComposer(), 0);
      windowObject.setTimeout(() => focusComposer(), 180);
    }

    function dismissKeyboard() {
      const activeEl = documentObject.activeElement;
      if (activeEl && (activeEl === promptEl || activeEl.tagName === 'TEXTAREA' || activeEl.tagName === 'INPUT')) {
        activeEl.blur();
      }
    }

    function installTapToDismissKeyboard() {
      const dismissTargets = [
        messagesEl,
        tabsEl,
        documentObject.querySelector('.masthead'),
        documentObject.querySelector('.sidebar'),
      ].filter(Boolean);

      dismissTargets.forEach((target) => {
        const skipTouchDismiss = mobileQuoteMode && target === messagesEl;
        if (!skipTouchDismiss) {
          target.addEventListener('touchstart', dismissKeyboard, { passive: true });
        }
        target.addEventListener('click', dismissKeyboard);
      });
    }

    function installKeyboardViewportSync() {
      syncViewportCssVars();
      if (!promptEl) return;

      let focusSyncIntervalId = null;
      let keyboardSyncUntil = 0;

      const isPromptFocused = () => documentObject.activeElement === promptEl;

      const armSyncWindow = (durationMs = 1400) => {
        keyboardSyncUntil = Date.now() + durationMs;
      };

      const isWithinSyncWindow = () => Date.now() <= keyboardSyncUntil;

      const shouldAutoMaintainComposerVisibility = () => {
        if (!isPromptFocused()) return false;
        if (!messagesEl) return true;
        return Boolean(isNearBottomFn?.(messagesEl, 40));
      };

      const guardedEnsureComposerVisible = () => {
        if (!shouldAutoMaintainComposerVisibility()) return;
        ensureComposerVisible({ smooth: false });
      };

      const runSyncBurst = () => {
        ensureComposerVisible({ smooth: false });
        const raf = windowObject.requestAnimationFrame || globalScope.requestAnimationFrame;
        if (typeof raf === 'function') {
          raf(() => guardedEnsureComposerVisible());
        }
        windowObject.setTimeout(() => guardedEnsureComposerVisible(), 90);
        windowObject.setTimeout(() => guardedEnsureComposerVisible(), 220);
        windowObject.setTimeout(() => guardedEnsureComposerVisible(), 420);
        windowObject.setTimeout(() => guardedEnsureComposerVisible(), 700);
        windowObject.setTimeout(() => guardedEnsureComposerVisible(), 1000);
      };

      const stopFocusIntervalSync = () => {
        if (!focusSyncIntervalId) return;
        windowObject.clearInterval(focusSyncIntervalId);
        focusSyncIntervalId = null;
      };

      const startFocusIntervalSync = () => {
        if (focusSyncIntervalId) return;
        focusSyncIntervalId = windowObject.setInterval(() => {
          if (!isPromptFocused() || !isWithinSyncWindow() || !shouldAutoMaintainComposerVisibility()) {
            stopFocusIntervalSync();
            return;
          }
          ensureComposerVisible({ smooth: false });
        }, 140);
      };

      const primeBeforeFocus = () => {
        armSyncWindow();
        runSyncBurst();
        startFocusIntervalSync();
      };

      promptEl.addEventListener('touchstart', primeBeforeFocus, { passive: true });
      promptEl.addEventListener('mousedown', primeBeforeFocus);

      const focusSync = () => {
        armSyncWindow();
        runSyncBurst();
        startFocusIntervalSync();
      };

      promptEl.addEventListener('focus', focusSync);
      promptEl.addEventListener('blur', () => {
        keyboardSyncUntil = 0;
        stopFocusIntervalSync();
      });

      const onViewportShift = () => {
        syncViewportCssVars();
        if (!isPromptFocused()) return;
        if (!isWithinSyncWindow()) return;
        if (!shouldAutoMaintainComposerVisibility()) return;
        ensureComposerVisible({ smooth: false });
      };

      if (windowObject.visualViewport) {
        windowObject.visualViewport.addEventListener('resize', onViewportShift);
        windowObject.visualViewport.addEventListener('scroll', onViewportShift);
      }

      windowObject.addEventListener('resize', onViewportShift);
      tg?.onEvent?.('viewportChanged', onViewportShift);
    }

    return {
      ensureComposerVisible,
      runAfterUiMutation,
      preserveViewportDuringUiMutation,
      focusComposerForNewChat,
      dismissKeyboard,
      installTapToDismissKeyboard,
      installKeyboardViewportSync,
    };
  }

  const api = { createController };
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  globalScope.HermesMiniappComposerViewport = api;
})(typeof window !== 'undefined' ? window : globalThis);
