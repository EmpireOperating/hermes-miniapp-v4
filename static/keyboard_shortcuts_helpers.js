(function initHermesMiniappKeyboardShortcuts(globalScope) {
  const CONTROL_FOCUS_SELECTOR = "button, [role='button'], .chat-tab, .pinned-chat-item__open, [data-pinned-chat-menu-trigger]";

  function getOrderedChatIds(chatsMap) {
    return [...chatsMap.values()]
      .map((chat) => Number(chat?.id || 0))
      .filter((id) => Number.isInteger(id) && id > 0)
      .sort((a, b) => a - b);
  }

  function isTextEntryElement(element) {
    if (typeof Element === "undefined") return false;
    if (!element || !(element instanceof Element)) return false;
    const tag = String(element.tagName || "").toLowerCase();
    if (tag === "textarea" || tag === "input" || tag === "select") return true;
    return Boolean(element.closest("[contenteditable='true']"));
  }

  function isDesktopViewport(windowObject) {
    try {
      if (windowObject.matchMedia?.("(min-width: 861px)")?.matches) {
        return true;
      }
    } catch {
      // Fallback below.
    }
    return Number(windowObject.innerWidth || 0) >= 861;
  }

  function hasOpenDialog(documentObject) {
    try {
      return Boolean(documentObject?.querySelector?.('dialog[open]'));
    } catch {
      return false;
    }
  }

  function handleTabClick(event, { activeChatId, openChat }) {
    if (event?.target?.closest?.("[data-chat-tab-menu-trigger]")) return;
    const tab = event.target.closest(".chat-tab");
    if (!tab) return;
    const chatId = Number(tab.dataset.chatId);
    if (!chatId || chatId === Number(activeChatId)) return;
    void openChat(chatId);
  }

  function handlePinnedChatClick(event, { activeChatId, chats, openPinnedChat }) {
    if (event?.target?.closest?.("[data-pinned-chat-menu-trigger]")) return;
    const item = event.target.closest(".pinned-chat-item");
    if (!item) return;
    const chatId = Number(item.dataset.chatId);
    if (!chatId) return;
    if (chatId === Number(activeChatId) && chats.has(chatId)) return;
    void openPinnedChat(chatId);
  }

  function ensureTabFullyVisible({
    tabsEl,
    tabNode,
    visibilityBufferPx = 14,
    behavior = "auto",
  } = {}) {
    if (!tabsEl || !tabNode) return false;
    if (typeof tabsEl.getBoundingClientRect !== "function" || typeof tabNode.getBoundingClientRect !== "function") {
      return false;
    }

    const tabsRect = tabsEl.getBoundingClientRect();
    const tabRect = tabNode.getBoundingClientRect();
    const buffer = Math.max(0, Number(visibilityBufferPx) || 0);
    const leftOverflow = (Number(tabsRect.left) + buffer) - Number(tabRect.left);
    const rightOverflow = Number(tabRect.right) - (Number(tabsRect.right) - buffer);

    let delta = 0;
    if (leftOverflow > 0) {
      delta = -leftOverflow;
    } else if (rightOverflow > 0) {
      delta = rightOverflow;
    }

    if (Math.abs(delta) < 1) return false;

    const currentScrollLeft = Number(tabsEl.scrollLeft || 0);
    const scrollWidth = Number(tabsEl.scrollWidth || 0);
    const clientWidth = Number(tabsEl.clientWidth || 0);
    const maxScrollLeft = scrollWidth > 0 && clientWidth >= 0
      ? Math.max(0, scrollWidth - clientWidth)
      : null;
    const unclampedScrollLeft = currentScrollLeft + delta;
    const nextScrollLeft = maxScrollLeft == null
      ? Math.max(0, unclampedScrollLeft)
      : Math.min(maxScrollLeft, Math.max(0, unclampedScrollLeft));

    if (typeof tabsEl.scrollTo === "function") {
      tabsEl.scrollTo({ left: nextScrollLeft, behavior });
    } else {
      tabsEl.scrollLeft = nextScrollLeft;
    }
    return true;
  }

  function handleGlobalTabCycle(event, {
    mobileQuoteMode,
    isDesktopViewportFn,
    settingsModal,
    documentObject,
    isTextEntryElementFn,
    activeChatId,
    promptEl,
    chats,
    tabsEl = null,
    tabNodes = null,
    getOrderedChatIdsFromState = null,
    getNextChatTabId,
    openChat,
    ensureTabVisibilityFn = ensureTabFullyVisible,
  }) {
    if (event.defaultPrevented) return;
    if (event.isComposing) return;
    if (event.metaKey) return;
    if (mobileQuoteMode || !isDesktopViewportFn()) return;
    if (settingsModal?.open || hasOpenDialog(documentObject)) return;

    const isArrowLeft = event.key === "ArrowLeft";
    const isArrowRight = event.key === "ArrowRight";
    if (!isArrowLeft && !isArrowRight) return;

    const target = event.target;
    const isTextEntryTarget = isTextEntryElementFn(target);
    const isComposerTarget = Boolean(promptEl && target === promptEl);
    const isComposerCycleShortcut = isComposerTarget && event.ctrlKey && event.altKey && !event.shiftKey;

    if (isTextEntryTarget && !isComposerCycleShortcut) return;
    if (!isTextEntryTarget && (event.altKey || event.ctrlKey)) return;

    const current = Number(activeChatId);
    if (!current) return;

    const orderedChatIds = typeof getOrderedChatIdsFromState === "function"
      ? getOrderedChatIdsFromState()
      : getOrderedChatIds(chats);

    const nextChatId = getNextChatTabId({
      orderedChatIds,
      activeChatId: current,
      reverse: isArrowLeft,
    });
    if (!nextChatId || nextChatId === current) return;

    const revealNextTab = () => ensureTabVisibilityFn({
      tabsEl,
      tabNode: tabNodes?.get?.(Number(nextChatId)) || null,
      visibilityBufferPx: 14,
      behavior: "auto",
    });

    event.preventDefault();
    revealNextTab();
    const openResult = openChat(nextChatId);
    if (openResult && typeof openResult.finally === "function") {
      openResult.finally(revealNextTab);
    }
  }

  function scrollMessagesByArrow(messagesEl, direction) {
    if (!messagesEl) return;
    const viewportHeight = Number(messagesEl.clientHeight || 0);
    const baseStep = Math.max(56, Math.floor(viewportHeight * 0.18));
    const delta = direction === "down" ? baseStep : -baseStep;
    messagesEl.scrollTop = Math.max(0, Number(messagesEl.scrollTop || 0) + delta);
  }

  function handleGlobalArrowJump(event, {
    mobileQuoteMode,
    isDesktopViewportFn,
    settingsModal,
    documentObject,
    isTextEntryElementFn,
    jumpLatestButton,
    jumpLastStartButton,
    handleJumpLatest,
    handleJumpLastStart,
    scrollMessages,
  }) {
    if (event.defaultPrevented) return;
    if (event.isComposing) return;
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    if (mobileQuoteMode || !isDesktopViewportFn()) return;
    if (settingsModal?.open || hasOpenDialog(documentObject)) return;

    const target = event.target;
    if (isTextEntryElementFn(target)) return;

    if (event.shiftKey) {
      if (event.key === "ArrowDown") {
        if (jumpLatestButton?.hidden) return;
        event.preventDefault();
        handleJumpLatest();
        return;
      }

      if (event.key === "ArrowUp") {
        if (jumpLastStartButton?.hidden) return;
        event.preventDefault();
        handleJumpLastStart();
      }
      return;
    }

    if (event.key === "ArrowDown") {
      event.preventDefault();
      scrollMessages("down");
      return;
    }

    if (event.key === "ArrowUp") {
      event.preventDefault();
      scrollMessages("up");
    }
  }

  function handleGlobalComposerFocusShortcut(event, {
    mobileQuoteMode,
    isDesktopViewportFn,
    settingsModal,
    isTextEntryElementFn,
    activeChatId,
    messagesEl,
    promptEl,
    documentObject,
  }) {
    if (event.defaultPrevented) return;
    if (event.isComposing) return;
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    if (mobileQuoteMode || !isDesktopViewportFn()) return;
    if (settingsModal?.open || hasOpenDialog(documentObject)) return;
    if (event.key !== "Enter" || event.shiftKey) return;

    const target = event.target;
    if (isTextEntryElementFn(target)) return;
    if (Number(activeChatId) <= 0) return;

    const activeElement = documentObject.activeElement;
    const focusedInMessages = activeElement === messagesEl || messagesEl?.contains?.(activeElement);
    if (!focusedInMessages) return;

    event.preventDefault();
    try {
      promptEl.focus({ preventScroll: true });
    } catch {
      promptEl.focus();
    }
  }

  function handleGlobalChatActionShortcut(event, {
    mobileQuoteMode,
    isDesktopViewportFn,
    documentObject,
    isTextEntryElementFn,
    activeChatId,
    createChat,
    removeActiveChat,
  }) {
    if (event.defaultPrevented) return;
    if (event.isComposing) return;
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    if (event.repeat) return;
    if (mobileQuoteMode || !isDesktopViewportFn()) return;
    if (hasOpenDialog(documentObject)) return;

    const target = event.target;
    if (isTextEntryElementFn(target)) return;

    const isEscape = event.key === "Escape" || event.code === "Escape";
    const isBackquote = event.code === "Backquote" || event.key === "`";
    if (!isEscape && !isBackquote) return;

    if (isEscape && Number(activeChatId) <= 0) return;

    event.preventDefault();
    if (isEscape) {
      void removeActiveChat();
      return;
    }
    void createChat();
  }

  function handleGlobalShortcutsHelpShortcut(event, {
    mobileQuoteMode,
    isDesktopViewportFn,
    documentObject,
    isTextEntryElementFn,
    openKeyboardShortcutsModal,
  }) {
    if (event.defaultPrevented) return;
    if (event.isComposing) return;
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    if (event.repeat) return;
    if (mobileQuoteMode || !isDesktopViewportFn()) return;
    if (hasOpenDialog(documentObject)) return;

    const target = event.target;
    if (isTextEntryElementFn(target)) return;

    const isQuestionMark = event.key === "?" || (event.key === "/" && event.shiftKey);
    if (!isQuestionMark) return;

    event.preventDefault();
    openKeyboardShortcutsModal?.();
  }

  function shouldReleaseControlFocusAfterClick(target, {
    isTextEntryElementFn,
    settingsModal,
    controlFocusSelector = CONTROL_FOCUS_SELECTOR,
  }) {
    if (typeof Element === "undefined") return false;
    if (!target || !(target instanceof Element)) return false;
    if (isTextEntryElementFn(target)) return false;

    if (settingsModal?.open && settingsModal.contains(target)) {
      return false;
    }

    const control = target.closest(controlFocusSelector);
    return Boolean(control);
  }

  function releaseStickyControlFocus({
    mobileQuoteMode,
    isDesktopViewportFn,
    documentObject,
    promptEl,
    messagesEl,
    activeChatId,
    settingsModal,
    focusMessagesPaneIfActiveChat,
    controlFocusSelector = CONTROL_FOCUS_SELECTOR,
  }) {
    if (mobileQuoteMode || !isDesktopViewportFn()) return;

    const activeElement = documentObject.activeElement;
    const focusedWithinOpenDialog = (typeof Element !== "undefined" && activeElement instanceof Element)
      ? Boolean(activeElement.closest?.('dialog[open], [aria-modal="true"]'))
      : false;
    if (focusedWithinOpenDialog) {
      // Don't steal focus from modal inputs (e.g. chat rename title), otherwise
      // mobile browsers may close the software keyboard and refuse to reopen it.
      return;
    }

    if (typeof HTMLElement !== "undefined" && activeElement instanceof HTMLElement) {
      const activeControl = activeElement.closest?.(controlFocusSelector);
      if (activeControl && activeElement !== promptEl && activeElement !== messagesEl) {
        activeElement.blur();
      }
    }

    const chatId = Number(activeChatId);
    if (chatId > 0 && !settingsModal?.open) {
      focusMessagesPaneIfActiveChat(chatId);
    }
  }

  function handleGlobalControlClickFocusCleanup(event, {
    shouldReleaseControlFocusAfterClickFn,
    releaseStickyControlFocusFn,
    windowObject,
  }) {
    if (!shouldReleaseControlFocusAfterClickFn(event.target)) return;
    windowObject.setTimeout(() => {
      releaseStickyControlFocusFn();
    }, 0);
  }

  function handleGlobalControlMouseDownFocusGuard(event, {
    mobileQuoteMode,
    isDesktopViewportFn,
    shouldReleaseControlFocusAfterClickFn,
  }) {
    if (mobileQuoteMode || !isDesktopViewportFn()) return;
    if (!shouldReleaseControlFocusAfterClickFn(event.target)) return;
    event.preventDefault();
  }

  function handleGlobalControlEnterDefuse(event, {
    mobileQuoteMode,
    isDesktopViewportFn,
    isTextEntryElementFn,
    settingsModal,
    documentObject,
    promptEl,
    messagesEl,
    releaseStickyControlFocusFn,
    controlFocusSelector = CONTROL_FOCUS_SELECTOR,
  }) {
    if (event.defaultPrevented) return;
    if (event.isComposing) return;
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    if (mobileQuoteMode || !isDesktopViewportFn()) return;
    if (event.key !== "Enter") return;

    const target = event.target;
    if (isTextEntryElementFn(target)) return;
    if (
      typeof Element !== "undefined"
      && settingsModal?.open
      && target instanceof Element
      && settingsModal.contains(target)
    ) return;

    const activeElement = documentObject.activeElement;
    const focusedControl = (typeof Element !== "undefined" && target instanceof Element)
      ? target.closest(controlFocusSelector)
      : activeElement?.closest?.(controlFocusSelector);

    if (!focusedControl) return;
    if (focusedControl === promptEl || focusedControl === messagesEl) return;

    event.preventDefault();
    event.stopPropagation();
    releaseStickyControlFocusFn();
  }

  function createController(deps) {
    const {
      windowObject,
      documentObject,
      messagesEl,
      promptEl,
      settingsModal,
      tabsEl,
      tabNodes,
      jumpLatestButton,
      jumpLastStartButton,
      chats,
      getOrderedChatIds,
      getActiveChatId,
      getMobileQuoteMode,
      openChat,
      openPinnedChat,
      getNextChatTabId,
      handleJumpLatest,
      handleJumpLastStart,
      focusMessagesPaneIfActiveChat,
      createChat,
      removeActiveChat,
      openKeyboardShortcutsModal,
    } = deps;

    function getOrderedChatIdsFromState() {
      if (typeof getOrderedChatIds === 'function') {
        return getOrderedChatIds();
      }
      return globalScope.HermesMiniappKeyboardShortcuts.getOrderedChatIds(chats);
    }

    function isDesktopViewportFromState() {
      return isDesktopViewport(windowObject);
    }

    function handleTabClickFromState(event) {
      return handleTabClick(event, {
        activeChatId: getActiveChatId(),
        openChat,
      });
    }

    function handlePinnedChatClickFromState(event) {
      return handlePinnedChatClick(event, {
        activeChatId: getActiveChatId(),
        chats,
        openPinnedChat,
      });
    }

    function handleGlobalTabCycleFromState(event) {
      return handleGlobalTabCycle(event, {
        mobileQuoteMode: getMobileQuoteMode(),
        isDesktopViewportFn: isDesktopViewportFromState,
        settingsModal,
        documentObject,
        isTextEntryElementFn: isTextEntryElement,
        activeChatId: getActiveChatId(),
        promptEl,
        chats,
        tabsEl,
        tabNodes,
        getOrderedChatIdsFromState,
        getNextChatTabId,
        openChat,
      });
    }

    function scrollMessagesByArrowFromState(direction) {
      return scrollMessagesByArrow(messagesEl, direction);
    }

    function handleGlobalArrowJumpFromState(event) {
      return handleGlobalArrowJump(event, {
        mobileQuoteMode: getMobileQuoteMode(),
        isDesktopViewportFn: isDesktopViewportFromState,
        settingsModal,
        documentObject,
        isTextEntryElementFn: isTextEntryElement,
        jumpLatestButton,
        jumpLastStartButton,
        handleJumpLatest,
        handleJumpLastStart,
        scrollMessages: scrollMessagesByArrowFromState,
      });
    }

    function handleGlobalComposerFocusShortcutFromState(event) {
      return handleGlobalComposerFocusShortcut(event, {
        mobileQuoteMode: getMobileQuoteMode(),
        isDesktopViewportFn: isDesktopViewportFromState,
        settingsModal,
        isTextEntryElementFn: isTextEntryElement,
        activeChatId: getActiveChatId(),
        messagesEl,
        promptEl,
        documentObject,
      });
    }

    function handleGlobalChatActionShortcutFromState(event) {
      return handleGlobalChatActionShortcut(event, {
        mobileQuoteMode: getMobileQuoteMode(),
        isDesktopViewportFn: isDesktopViewportFromState,
        documentObject,
        isTextEntryElementFn: isTextEntryElement,
        activeChatId: getActiveChatId(),
        createChat,
        removeActiveChat,
      });
    }

    function handleGlobalShortcutsHelpShortcutFromState(event) {
      return handleGlobalShortcutsHelpShortcut(event, {
        mobileQuoteMode: getMobileQuoteMode(),
        isDesktopViewportFn: isDesktopViewportFromState,
        documentObject,
        isTextEntryElementFn: isTextEntryElement,
        openKeyboardShortcutsModal,
      });
    }

    function shouldReleaseControlFocusAfterClickFromState(target) {
      return shouldReleaseControlFocusAfterClick(target, {
        isTextEntryElementFn: isTextEntryElement,
        settingsModal,
      });
    }

    function releaseStickyControlFocusFromState() {
      return releaseStickyControlFocus({
        mobileQuoteMode: getMobileQuoteMode(),
        isDesktopViewportFn: isDesktopViewportFromState,
        documentObject,
        promptEl,
        messagesEl,
        activeChatId: getActiveChatId(),
        settingsModal,
        focusMessagesPaneIfActiveChat,
      });
    }

    function handleGlobalControlClickFocusCleanupFromState(event) {
      return handleGlobalControlClickFocusCleanup(event, {
        shouldReleaseControlFocusAfterClickFn: shouldReleaseControlFocusAfterClickFromState,
        releaseStickyControlFocusFn: releaseStickyControlFocusFromState,
        windowObject,
      });
    }

    function handleGlobalControlMouseDownFocusGuardFromState(event) {
      return handleGlobalControlMouseDownFocusGuard(event, {
        mobileQuoteMode: getMobileQuoteMode(),
        isDesktopViewportFn: isDesktopViewportFromState,
        shouldReleaseControlFocusAfterClickFn: shouldReleaseControlFocusAfterClickFromState,
      });
    }

    function handleGlobalControlEnterDefuseFromState(event) {
      return handleGlobalControlEnterDefuse(event, {
        mobileQuoteMode: getMobileQuoteMode(),
        isDesktopViewportFn: isDesktopViewportFromState,
        isTextEntryElementFn: isTextEntryElement,
        settingsModal,
        documentObject,
        promptEl,
        messagesEl,
        releaseStickyControlFocusFn: releaseStickyControlFocusFromState,
      });
    }

    return {
      getOrderedChatIds: getOrderedChatIdsFromState,
      isTextEntryElement,
      isDesktopViewport: isDesktopViewportFromState,
      handleTabClick: handleTabClickFromState,
      handlePinnedChatClick: handlePinnedChatClickFromState,
      handleGlobalTabCycle: handleGlobalTabCycleFromState,
      scrollMessagesByArrow: scrollMessagesByArrowFromState,
      handleGlobalArrowJump: handleGlobalArrowJumpFromState,
      handleGlobalComposerFocusShortcut: handleGlobalComposerFocusShortcutFromState,
      handleGlobalChatActionShortcut: handleGlobalChatActionShortcutFromState,
      handleGlobalShortcutsHelpShortcut: handleGlobalShortcutsHelpShortcutFromState,
      shouldReleaseControlFocusAfterClick: shouldReleaseControlFocusAfterClickFromState,
      releaseStickyControlFocus: releaseStickyControlFocusFromState,
      handleGlobalControlClickFocusCleanup: handleGlobalControlClickFocusCleanupFromState,
      handleGlobalControlMouseDownFocusGuard: handleGlobalControlMouseDownFocusGuardFromState,
      handleGlobalControlEnterDefuse: handleGlobalControlEnterDefuseFromState,
    };
  }

  const api = {
    CONTROL_FOCUS_SELECTOR,
    createController,
    getOrderedChatIds,
    isTextEntryElement,
    isDesktopViewport,
    handleTabClick,
    handlePinnedChatClick,
    ensureTabFullyVisible,
    handleGlobalTabCycle,
    scrollMessagesByArrow,
    handleGlobalArrowJump,
    handleGlobalComposerFocusShortcut,
    handleGlobalChatActionShortcut,
    handleGlobalShortcutsHelpShortcut,
    shouldReleaseControlFocusAfterClick,
    releaseStickyControlFocus,
    handleGlobalControlClickFocusCleanup,
    handleGlobalControlMouseDownFocusGuard,
    handleGlobalControlEnterDefuse,
  };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
  globalScope.HermesMiniappKeyboardShortcuts = api;
})(typeof window !== "undefined" ? window : globalThis);
