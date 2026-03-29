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
      toolStreamEl,
      mobileQuoteMode,
      isNearBottomFn,
      getActiveChatId,
      chatScrollTop,
      chatStickToBottom,
      updateJumpLatestVisibility,
    } = deps;

    let viewportMutationSeq = 0;

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
      const previousScrollTop = messagesEl ? messagesEl.scrollTop : null;
      const previousWindowScrollY = Number(windowObject.scrollY || 0);
      const wasNearBottom = Boolean(messagesEl && isNearBottomFn?.(messagesEl, 40));
      const mutationSeq = ++viewportMutationSeq;

      mutator();

      if (!hasActiveChat || !messagesEl || previousScrollTop == null) {
        return;
      }

      runAfterUiMutation(() => {
        if (mutationSeq !== viewportMutationSeq) return;
        if (Number(getActiveChatId?.()) !== key) return;

        const shouldStickBottom = Boolean(chatStickToBottom?.get?.(key));
        if (shouldStickBottom || wasNearBottom) {
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
          messagesEl.scrollTop = Math.max(0, Number(previousScrollTop) || 0);
          chatScrollTop?.set?.(key, messagesEl.scrollTop);
          chatStickToBottom?.set?.(key, false);
        }
        updateJumpLatestVisibility?.();

        if (!mobileQuoteMode && Math.abs((windowObject.scrollY || 0) - previousWindowScrollY) > 1) {
          windowObject.scrollTo({ top: previousWindowScrollY, left: 0, behavior: 'auto' });
        }
      });
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
        toolStreamEl,
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
      if (!promptEl) return;

      let focusSyncIntervalId = null;
      let keyboardSyncUntil = 0;

      const isPromptFocused = () => documentObject.activeElement === promptEl;

      const armSyncWindow = (durationMs = 1400) => {
        keyboardSyncUntil = Date.now() + durationMs;
      };

      const isWithinSyncWindow = () => Date.now() <= keyboardSyncUntil;

      const runSyncBurst = () => {
        ensureComposerVisible({ smooth: false });
        const raf = windowObject.requestAnimationFrame || globalScope.requestAnimationFrame;
        if (typeof raf === 'function') {
          raf(() => ensureComposerVisible({ smooth: false }));
        }
        windowObject.setTimeout(() => ensureComposerVisible({ smooth: false }), 90);
        windowObject.setTimeout(() => ensureComposerVisible({ smooth: false }), 220);
        windowObject.setTimeout(() => ensureComposerVisible({ smooth: false }), 420);
        windowObject.setTimeout(() => ensureComposerVisible({ smooth: false }), 700);
        windowObject.setTimeout(() => ensureComposerVisible({ smooth: false }), 1000);
      };

      const stopFocusIntervalSync = () => {
        if (!focusSyncIntervalId) return;
        windowObject.clearInterval(focusSyncIntervalId);
        focusSyncIntervalId = null;
      };

      const startFocusIntervalSync = () => {
        if (focusSyncIntervalId) return;
        focusSyncIntervalId = windowObject.setInterval(() => {
          if (!isPromptFocused() || !isWithinSyncWindow()) {
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
        if (!isPromptFocused()) return;
        if (!isWithinSyncWindow()) return;
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
