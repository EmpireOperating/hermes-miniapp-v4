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

    const MOBILE_COMPOSER_TAP_SLOP_PX = 14;
    let viewportMutationSeq = 0;
    let focusComposerForNewChatRequestId = 0;
    let focusComposerAfterQuoteRequestId = 0;

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
        const promptRect = typeof promptEl.getBoundingClientRect === 'function'
          ? promptEl.getBoundingClientRect()
          : null;
        const formRect = typeof form.getBoundingClientRect === 'function'
          ? form.getBoundingClientRect()
          : null;
        if (!promptRect && !formRect) return;

        const topSafe = viewportTop + 8;
        const bottomSafe = viewportBottom - 10;
        const viewportSafeHeight = Math.max(0, bottomSafe - topSafe);
        const formTop = Number(formRect?.top);
        const formBottom = Number(formRect?.bottom);
        const formHeight = formBottom - formTop;
        const formFitsViewport = Number.isFinite(formHeight) && formHeight <= viewportSafeHeight;
        const rect = formFitsViewport ? (formRect || promptRect) : (promptRect || formRect);
        const rectTop = Number(rect?.top);
        const rectBottom = Number(rect?.bottom);

        if (Number.isFinite(rectBottom) && rectBottom > bottomSafe) {
          const deltaDown = rectBottom - bottomSafe;
          windowObject.scrollBy({ top: deltaDown, left: 0, behavior: 'auto' });
          return;
        }
        if (Number.isFinite(rectTop) && rectTop < topSafe) {
          const deltaUp = rectTop - topSafe;
          windowObject.scrollBy({ top: deltaUp, left: 0, behavior: 'auto' });
        }
      }
    }

    function revealPromptCaret(desiredCaret = null) {
      if (!promptEl) return;
      const value = String(promptEl.value || '');
      const caret = Math.min(
        Math.max(0, Number.isInteger(desiredCaret) ? desiredCaret : value.length),
        value.length,
      );
      try {
        promptEl.setSelectionRange?.(caret, caret);
      } catch {
        // Some mobile webviews reject setSelectionRange during keyboard transitions.
      }

      const scrollHeight = Number(promptEl.scrollHeight);
      const clientHeight = Number(promptEl.clientHeight);
      if (Number.isFinite(scrollHeight) && Number.isFinite(clientHeight) && scrollHeight > clientHeight) {
        const caretAtOrNearEnd = caret >= Math.max(0, value.length - 1);
        if (caretAtOrNearEnd && typeof promptEl.scrollTop === 'number') {
          promptEl.scrollTop = Math.max(0, scrollHeight - clientHeight);
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

    function focusComposerAfterQuoteInsertion(caretPosition = null) {
      if (!promptEl || promptEl.disabled) return;
      if (documentObject.visibilityState !== 'visible') return;

      const requestId = ++focusComposerAfterQuoteRequestId;
      const desiredCaret = Math.min(
        Math.max(0, Number.isInteger(caretPosition) ? caretPosition : String(promptEl.value || '').length),
        String(promptEl.value || '').length,
      );

      const shouldKeepRetryingFocus = () => {
        if (requestId !== focusComposerAfterQuoteRequestId) return false;
        if (!promptEl || promptEl.disabled) return false;
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
        promptEl.focus();
        revealPromptCaret(desiredCaret);
        ensureComposerVisible({ smooth: false });
      };

      focusComposer({ allowForce: true });
      const raf = windowObject.requestAnimationFrame || globalScope.requestAnimationFrame;
      if (typeof raf === 'function') {
        raf(() => focusComposer());
      }
      windowObject.setTimeout(() => focusComposer(), 0);
      windowObject.setTimeout(() => focusComposer(), 90);
      windowObject.setTimeout(() => focusComposer(), 220);
      windowObject.setTimeout(() => focusComposer(), 420);
      windowObject.setTimeout(() => focusComposer(), 700);
      windowObject.setTimeout(() => focusComposer(), 1000);
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
      let explicitComposerRevealRequested = false;
      let pendingPromptTouch = null;

      const getTouchPoint = (event) => {
        const touch = event?.changedTouches?.[0] || event?.touches?.[0] || null;
        if (touch) {
          return {
            clientX: Number(touch.clientX || 0),
            clientY: Number(touch.clientY || 0),
          };
        }
        return {
          clientX: Number(event?.clientX || 0),
          clientY: Number(event?.clientY || 0),
        };
      };

      const cancelPendingPromptTouch = () => {
        pendingPromptTouch = null;
      };

      const clearSyncWindowState = () => {
        keyboardSyncUntil = 0;
        explicitComposerRevealRequested = false;
        stopFocusIntervalSync();
      };

      const isPromptFocused = () => documentObject.activeElement === promptEl;

      const armSyncWindow = (durationMs = 1400) => {
        keyboardSyncUntil = Date.now() + durationMs;
      };

      const isWithinSyncWindow = () => Date.now() <= keyboardSyncUntil;

      const hasExplicitComposerRevealRequest = () => explicitComposerRevealRequested && isWithinSyncWindow();

      const shouldAutoMaintainComposerVisibility = () => {
        if (!isPromptFocused()) return false;
        if (!messagesEl) return true;
        return Boolean(isNearBottomFn?.(messagesEl, 40));
      };

      const shouldMaintainComposerVisibilityDuringSyncWindow = () => {
        if (hasExplicitComposerRevealRequest()) return true;
        return shouldAutoMaintainComposerVisibility();
      };

      const guardedEnsureComposerVisible = () => {
        if (!shouldMaintainComposerVisibilityDuringSyncWindow()) return;
        ensureComposerVisible({ smooth: false });
      };

      const ensurePromptFocusDuringSyncWindow = () => {
        if (!promptEl || promptEl.disabled) return false;
        if (!isWithinSyncWindow()) return false;
        if (documentObject.activeElement === promptEl) return true;
        if (documentObject.querySelector?.('dialog[open]')) return false;

        if (mobileQuoteMode) {
          promptEl.focus();
        } else {
          try {
            promptEl.focus({ preventScroll: true });
          } catch {
            promptEl.focus();
          }
        }

        if (documentObject.activeElement !== promptEl) return false;
        const caret = String(promptEl.value || '').length;
        try {
          promptEl.setSelectionRange?.(caret, caret);
        } catch {
          // Some mobile webviews reject setSelectionRange during keyboard transitions.
        }
        return true;
      };

      const guardedMaintainComposerDuringSyncWindow = () => {
        ensurePromptFocusDuringSyncWindow();
        guardedEnsureComposerVisible();
      };

      const runSyncBurst = () => {
        ensurePromptFocusDuringSyncWindow();
        ensureComposerVisible({ smooth: false });
        const raf = windowObject.requestAnimationFrame || globalScope.requestAnimationFrame;
        if (typeof raf === 'function') {
          raf(() => guardedMaintainComposerDuringSyncWindow());
        }
        windowObject.setTimeout(() => guardedMaintainComposerDuringSyncWindow(), 90);
        windowObject.setTimeout(() => guardedMaintainComposerDuringSyncWindow(), 220);
        windowObject.setTimeout(() => guardedMaintainComposerDuringSyncWindow(), 420);
        windowObject.setTimeout(() => guardedMaintainComposerDuringSyncWindow(), 700);
        windowObject.setTimeout(() => guardedMaintainComposerDuringSyncWindow(), 1000);
      };

      const stopFocusIntervalSync = () => {
        if (!focusSyncIntervalId) return;
        windowObject.clearInterval(focusSyncIntervalId);
        focusSyncIntervalId = null;
      };

      const startFocusIntervalSync = () => {
        if (focusSyncIntervalId) return;
        focusSyncIntervalId = windowObject.setInterval(() => {
          if (!isWithinSyncWindow() || !shouldMaintainComposerVisibilityDuringSyncWindow()) {
            stopFocusIntervalSync();
            return;
          }
          ensurePromptFocusDuringSyncWindow();
          if (!shouldMaintainComposerVisibilityDuringSyncWindow()) {
            return;
          }
          ensureComposerVisible({ smooth: false });
        }, 140);
      };

      const focusComposerFromUserGesture = () => {
        if (!promptEl || promptEl.disabled) return;
        if (documentObject.activeElement === promptEl) return;
        if (mobileQuoteMode) {
          // Mobile/webview focus is more reliable with a plain synchronous focus()
          // while the original tap gesture is still active.
          promptEl.focus();
          return;
        }
        try {
          promptEl.focus({ preventScroll: true });
        } catch {
          promptEl.focus();
        }
      };

      const primeBeforeFocus = ({ skipFocus = false } = {}) => {
        explicitComposerRevealRequested = true;
        armSyncWindow();
        if (!skipFocus) {
          focusComposerFromUserGesture();
        }
        runSyncBurst();
        startFocusIntervalSync();
      };

      const handlePromptTouchStart = (event) => {
        if (!mobileQuoteMode) {
          primeBeforeFocus();
          return;
        }
        cancelPendingPromptTouch();
        if (isPromptFocused()) {
          primeBeforeFocus({ skipFocus: true });
          return;
        }
        if (promptEl.disabled) return;
        const { clientX, clientY } = getTouchPoint(event);
        pendingPromptTouch = {
          startX: clientX,
          startY: clientY,
        };
      };

      const handlePromptTouchMove = (event) => {
        if (!pendingPromptTouch) return;
        const { clientX, clientY } = getTouchPoint(event);
        const deltaX = clientX - pendingPromptTouch.startX;
        const deltaY = clientY - pendingPromptTouch.startY;
        if (Math.hypot(deltaX, deltaY) > MOBILE_COMPOSER_TAP_SLOP_PX) {
          cancelPendingPromptTouch();
        }
      };

      const handlePromptTouchEnd = (event) => {
        if (!mobileQuoteMode) {
          primeBeforeFocus();
          return;
        }
        if (!pendingPromptTouch) return;
        const { clientX, clientY } = getTouchPoint(event);
        const deltaX = clientX - pendingPromptTouch.startX;
        const deltaY = clientY - pendingPromptTouch.startY;
        cancelPendingPromptTouch();
        if (Math.hypot(deltaX, deltaY) > MOBILE_COMPOSER_TAP_SLOP_PX) {
          return;
        }
        primeBeforeFocus();
      };

      promptEl.addEventListener('touchstart', handlePromptTouchStart, { passive: false });
      promptEl.addEventListener('touchmove', handlePromptTouchMove, { passive: true });
      promptEl.addEventListener('touchend', handlePromptTouchEnd, { passive: false });
      promptEl.addEventListener('touchcancel', cancelPendingPromptTouch);
      promptEl.addEventListener('mousedown', primeBeforeFocus);
      promptEl.addEventListener('click', primeBeforeFocus);

      const focusSync = () => {
        armSyncWindow();
        runSyncBurst();
        startFocusIntervalSync();
      };

      promptEl.addEventListener('focus', focusSync);
      promptEl.addEventListener('blur', () => {
        clearSyncWindowState();
      });

      const suspendComposerFocusOnBackground = () => {
        clearSyncWindowState();
        if (!mobileQuoteMode) return;
        if (!isPromptFocused()) return;
        promptEl.blur?.();
      };

      const onDocumentVisibilityChange = () => {
        if (documentObject.visibilityState === 'visible') return;
        suspendComposerFocusOnBackground();
      };

      const onViewportShift = () => {
        syncViewportCssVars();
        if (!isWithinSyncWindow()) return;
        ensurePromptFocusDuringSyncWindow();
        if (!shouldMaintainComposerVisibilityDuringSyncWindow()) return;
        ensureComposerVisible({ smooth: false });
      };

      if (windowObject.visualViewport) {
        windowObject.visualViewport.addEventListener('resize', onViewportShift);
        windowObject.visualViewport.addEventListener('scroll', onViewportShift);
      }

      documentObject.addEventListener?.('visibilitychange', onDocumentVisibilityChange);
      windowObject.addEventListener('resize', onViewportShift);
      windowObject.addEventListener?.('blur', suspendComposerFocusOnBackground);
      windowObject.addEventListener?.('pagehide', suspendComposerFocusOnBackground);
      tg?.onEvent?.('viewportChanged', onViewportShift);
    }

    return {
      ensureComposerVisible,
      runAfterUiMutation,
      preserveViewportDuringUiMutation,
      focusComposerForNewChat,
      focusComposerAfterQuoteInsertion,
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
