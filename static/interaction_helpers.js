(function initHermesMiniappInteraction(globalScope) {
  function handleComposerSubmitShortcut(event, {
    mobileQuoteMode,
    activeChatId,
    focusMessagesPaneIfActiveChat,
    submitPromptWithUiError,
  }) {
    if (event.isComposing) return;

    // On coarse-pointer/mobile keyboards, Enter should always insert a newline.
    // Telegram/iOS modifier reporting is inconsistent (e.g. shift double-tap/caps-lock),
    // which can accidentally flip shiftKey=false and trigger unwanted sends.
    if (mobileQuoteMode) {
      return;
    }

    if (event.key !== "Enter" || event.shiftKey) return;

    event.preventDefault();
    const chatId = Number(activeChatId);
    if (chatId > 0) {
      focusMessagesPaneIfActiveChat(chatId);
    }
    void submitPromptWithUiError();
  }

  function unwrapLegacyQuoteBlock(text) {
    const lines = String(text || "").split("\n");
    if (!lines.length) return String(text || "");

    const first = lines[0].trim();
    const last = lines[lines.length - 1].trim();
    const looksLikeLegacyFrame = /^╭─\s*Quote\s*─/.test(first) && /^╰─+/.test(last);
    if (!looksLikeLegacyFrame) return String(text || "");

    return lines
      .slice(1, -1)
      .map((line) => line.replace(/^\s*│\s?/, ""))
      .join("\n");
  }

  function normalizeQuoteSelection(rawText) {
    return unwrapLegacyQuoteBlock(rawText)
      .replace(/\r\n?/g, "\n")
      .replace(/[\u2028\u2029]/g, "\n")
      .replace(/\u00a0/g, " ")
      .split("\n")
      .map((line) => line.replace(/\s+$/g, ""))
      .join("\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }

  function splitGraphemes(text) {
    const value = String(text || "");
    if (!value) return [];
    if (typeof Intl !== "undefined" && typeof Intl.Segmenter === "function") {
      try {
        const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
        return Array.from(segmenter.segment(value), (piece) => piece.segment);
      } catch {
        // Fall through to Array.from below.
      }
    }
    return Array.from(value);
  }

  function wrapQuoteLine(line, width = 46) {
    const text = String(line || "");
    if (!text) return [""];

    const safeWidth = Math.max(8, Number(width) || 46);
    const tokens = text.match(/\S+\s*/g) || [text];
    const wrapped = [];
    let current = "";

    const pushCurrent = () => {
      if (!current.length) return;
      wrapped.push(current.trimEnd());
      current = "";
    };

    for (const token of tokens) {
      if (!token) continue;

      const tokenLength = splitGraphemes(token).length;
      if (tokenLength > safeWidth) {
        pushCurrent();
        const glyphs = splitGraphemes(token);
        for (let index = 0; index < glyphs.length; index += safeWidth) {
          wrapped.push(glyphs.slice(index, index + safeWidth).join("").trimEnd());
        }
        continue;
      }

      const candidate = `${current}${token}`;
      if (splitGraphemes(candidate).length <= safeWidth) {
        current = candidate;
        continue;
      }

      pushCurrent();
      current = token.trimStart();
    }

    pushCurrent();
    return wrapped.length ? wrapped : [""];
  }

  function formatQuoteBlock(rawText) {
    const clean = normalizeQuoteSelection(rawText);
    if (!clean) return "";

    const lines = [];
    for (const line of clean.split("\n")) {
      lines.push(line ? `│ ${line}` : "│");
    }

    return `┌ Quote\n${lines.join("\n")}\n└\n\n\n`;
  }

  function getQuoteWrapWidth({ promptInput, windowObject = (typeof window !== "undefined" ? window : null) } = {}) {
    const fallback = 46;
    try {
      if (!promptInput || !windowObject) return fallback;
      const style = windowObject.getComputedStyle(promptInput);
      const fontSize = Number.parseFloat(style.fontSize || "") || 16;
      const inputWidth = promptInput.clientWidth || promptInput.offsetWidth || 0;
      if (!inputWidth) return fallback;

      const usableWidth = Math.max(120, inputWidth - 28);
      const charWidth = Math.max(fontSize * 0.58, 7);
      const estimatedChars = Math.floor(usableWidth / charWidth);
      return Math.max(22, Math.min(fallback, estimatedChars - 2));
    } catch {
      return fallback;
    }
  }

  function isCoarsePointer({ windowObject = (typeof window !== "undefined" ? window : null) } = {}) {
    if (!windowObject) return false;
    try {
      if (windowObject.matchMedia?.("(pointer: coarse)")?.matches) {
        return true;
      }
    } catch {
      // Fallback below.
    }
    return "ontouchstart" in windowObject;
  }

  function clearSelectionQuoteState({ selectionQuoteState, selectionQuoteButton } = {}) {
    if (!selectionQuoteState) return;
    selectionQuoteState.reset();
    if (selectionQuoteButton) {
      selectionQuoteButton.hidden = true;
    }
  }

  function cancelSelectionQuoteTimer(name, { selectionQuoteState } = {}) {
    selectionQuoteState?.cancelTimer?.(name);
  }

  function hasSelectionQuoteTimer(name, { selectionQuoteState } = {}) {
    return Boolean(selectionQuoteState?.timers?.[name]);
  }

  function getActiveSelection({
    windowObject = (typeof window !== "undefined" ? window : null),
    documentObject = (typeof document !== "undefined" ? document : null),
  } = {}) {
    const windowSelection = windowObject?.getSelection?.();
    if (windowSelection) return windowSelection;
    return documentObject?.getSelection?.() || null;
  }

  function scheduleSelectionQuoteClear({
    selectionQuoteState,
    activeSelectionQuoteFn,
    clearSelectionQuoteStateFn,
  } = {}, delayMs = 380) {
    if (!selectionQuoteState || !activeSelectionQuoteFn || !clearSelectionQuoteStateFn) return;
    selectionQuoteState.scheduleTimer("clear", delayMs, () => {
      const picked = activeSelectionQuoteFn();
      if (!picked) {
        clearSelectionQuoteStateFn();
      }
    });
  }

  function scheduleSelectionQuoteSync({
    selectionQuoteState,
    cancelSelectionQuoteSyncFn,
    cancelSelectionQuoteSettleFn,
    syncSelectionQuoteActionFn,
  } = {}, delayMs = 120) {
    if (!selectionQuoteState || !syncSelectionQuoteActionFn) return;
    cancelSelectionQuoteSyncFn?.();
    cancelSelectionQuoteSettleFn?.();
    selectionQuoteState.scheduleTimer("sync", delayMs, () => {
      syncSelectionQuoteActionFn();
    });
  }

  function focusPromptAfterQuoteInsertion({
    promptEl,
    ensureComposerVisible = () => {},
    mobileQuoteMode = false,
    documentObject = (typeof document !== "undefined" ? document : null),
    windowObject = (typeof window !== "undefined" ? window : null),
  } = {}) {
    if (!promptEl || promptEl.disabled) return;

    const focusPrompt = ({ allowForce = false } = {}) => {
      if (!allowForce) {
        if (!promptEl || promptEl.disabled) return false;
        if (documentObject?.querySelector?.('dialog[open]')) return false;
        const activeEl = documentObject?.activeElement;
        if (activeEl && activeEl !== promptEl && activeEl !== documentObject?.body && activeEl !== documentObject?.documentElement) {
          return false;
        }
      }

      ensureComposerVisible({ smooth: false });
      if (mobileQuoteMode) {
        promptEl.focus?.();
      } else {
        try {
          promptEl.focus?.({ preventScroll: true });
        } catch {
          promptEl.focus?.();
        }
      }
      const caret = Math.min(
        Number.isInteger(promptEl.selectionEnd) ? promptEl.selectionEnd : String(promptEl.value || '').length,
        String(promptEl.value || '').length,
      );
      try {
        promptEl.setSelectionRange?.(caret, caret);
      } catch {
        // Some mobile webviews reject setSelectionRange during keyboard transitions.
      }
      ensureComposerVisible({ smooth: false });
      return documentObject?.activeElement === promptEl || !documentObject;
    };

    focusPrompt({ allowForce: true });
    const raf = windowObject?.requestAnimationFrame
      || globalScope.requestAnimationFrame
      || null;
    if (typeof raf === 'function') {
      raf(() => focusPrompt());
    }
    const scheduleTimeout = windowObject?.setTimeout?.bind(windowObject)
      || globalScope.setTimeout
      || null;
    scheduleTimeout?.(() => focusPrompt(), 0);
    scheduleTimeout?.(() => focusPrompt(), 180);
  }

  function applyQuoteIntoPrompt(text, {
    promptEl,
    formatQuoteBlockFn = formatQuoteBlock,
    ensureComposerVisible = () => {},
    mobileQuoteMode = false,
    documentObject = (typeof document !== "undefined" ? document : null),
    windowObject = (typeof window !== "undefined" ? window : null),
  } = {}) {
    if (!promptEl) return;
    const quoteBlock = formatQuoteBlockFn(text);
    if (!quoteBlock) return;

    const maxLen = Number(promptEl.maxLength) > 0 ? Number(promptEl.maxLength) : 6000;
    const current = String(promptEl.value || "");
    const cursorStart = Number.isInteger(promptEl.selectionStart) ? promptEl.selectionStart : current.length;
    const cursorEnd = Number.isInteger(promptEl.selectionEnd) ? promptEl.selectionEnd : current.length;
    const next = `${current.slice(0, cursorStart)}${quoteBlock}${current.slice(cursorEnd)}`;
    promptEl.value = next.slice(0, maxLen);

    const nextCaret = Math.min(cursorStart + quoteBlock.length, promptEl.value.length);
    promptEl.setSelectionRange?.(nextCaret, nextCaret);
    try {
      const eventCtor = promptEl.ownerDocument?.defaultView?.Event
        || (typeof Event === "function" ? Event : null);
      if (eventCtor && typeof promptEl.dispatchEvent === "function") {
        promptEl.dispatchEvent(new eventCtor("input", { bubbles: true }));
      }
    } catch {
      // Non-fatal: draft sync listeners may be unavailable in tests.
    }
    focusPromptAfterQuoteInsertion({
      promptEl,
      ensureComposerVisible,
      mobileQuoteMode,
      documentObject,
      windowObject,
    });
  }

  function resolveSelectionAnchorElement(nodes, { textNodeType = (typeof Node !== "undefined" ? Node.TEXT_NODE : 3) } = {}) {
    for (const node of nodes || []) {
      if (!node) continue;
      if (node.nodeType === textNodeType) {
        if (node.parentElement) return node.parentElement;
        continue;
      }
      if (typeof node.nodeType === "number" && node.nodeType === 1) {
        return node;
      }
      if (node.parentElement) {
        return node.parentElement;
      }
      if (node.host && typeof node.host.nodeType === "number" && node.host.nodeType === 1) {
        return node.host;
      }
      if (typeof node.nodeType !== "number") {
        return node;
      }
    }
    return null;
  }

  function activeSelectionQuote({
    messagesEl,
    windowObject = (typeof window !== "undefined" ? window : null),
    documentObject = (typeof document !== "undefined" ? document : null),
    normalizeQuoteSelectionFn = normalizeQuoteSelection,
    textNodeType = (typeof Node !== "undefined" ? Node.TEXT_NODE : 3),
  } = {}) {
    if (!messagesEl || !windowObject) return null;
    const selection = getActiveSelection({ windowObject, documentObject });
    if (!selection || selection.rangeCount < 1 || selection.isCollapsed) {
      return null;
    }

    const range = selection.getRangeAt(0);
    const anchorElement = resolveSelectionAnchorElement(
      [range.commonAncestorContainer, selection.anchorNode, selection.focusNode],
      { textNodeType },
    );
    if (!anchorElement || !messagesEl.contains(anchorElement)) {
      return null;
    }

    const text = normalizeQuoteSelectionFn(selection.toString());
    if (!text) return null;

    const rect = range.getBoundingClientRect();
    return { text, rect };
  }

  function quotePlacementKey({ text, rect }) {
    return [
      text,
      Math.round(rect.left || 0),
      Math.round(rect.top || 0),
      Math.round(rect.width || 0),
      Math.round(rect.height || 0),
    ].join("|");
  }

  function isSimilarQuotePlacement(firstPick, secondPick, tolerancePx = 6) {
    const firstText = String(firstPick?.text || "");
    const secondText = String(secondPick?.text || "");
    if (!firstText || firstText !== secondText) {
      return false;
    }
    const safeTolerance = Math.max(0, Number(tolerancePx) || 0);
    const firstRect = firstPick?.rect || {};
    const secondRect = secondPick?.rect || {};
    return ["left", "top", "width", "height"].every((key) => {
      const firstValue = Number(firstRect[key] || 0);
      const secondValue = Number(secondRect[key] || 0);
      return Math.abs(firstValue - secondValue) <= safeTolerance;
    });
  }

  function showSelectionQuoteAction({ text, rect }, {
    selectionQuoteButton,
    selectionQuoteState,
    mobileQuoteMode,
    windowObject = (typeof window !== "undefined" ? window : null),
    form,
    messagesEl,
    clearSelectionQuoteState,
  } = {}, { lockPlacement = false } = {}) {
    if (!selectionQuoteButton || !windowObject || !selectionQuoteState || !clearSelectionQuoteState) return;
    if (!text) {
      clearSelectionQuoteState();
      return;
    }

    const placementKey = quotePlacementKey({ text, rect });
    if (mobileQuoteMode && lockPlacement && !selectionQuoteButton.hidden && selectionQuoteState.placementKey === placementKey) {
      selectionQuoteState.setText(text);
      return;
    }

    selectionQuoteState.setText(text);
    const viewportWidth = Number(windowObject.innerWidth || 0);
    const viewportHeight = Number(windowObject.innerHeight || 0);
    const buttonWidth = selectionQuoteButton.offsetWidth || 72;
    const buttonHeight = selectionQuoteButton.offsetHeight || 36;

    let left = rect.left + (rect.width / 2) - (buttonWidth / 2);
    left = Math.max(8, Math.min(left, viewportWidth - buttonWidth - 8));

    let top = rect.top - buttonHeight - 10;
    if (mobileQuoteMode) {
      const messagesRect = messagesEl?.getBoundingClientRect?.() || null;
      const transcriptTop = Number(messagesRect?.top);
      const mobileToolbarUnsafeTop = Math.max(56, Math.round(viewportHeight * 0.18));
      const safeTop = Math.max(
        mobileToolbarUnsafeTop,
        Number.isFinite(transcriptTop) ? transcriptTop + 8 : mobileToolbarUnsafeTop,
      );
      const composerTop = Number(form?.getBoundingClientRect?.().top || viewportHeight);
      const safeBottom = Math.max(safeTop + buttonHeight + 8, Math.min(viewportHeight - buttonHeight - 8, composerTop - buttonHeight - 12));
      const belowSelection = rect.bottom + 12;
      top = belowSelection;
      if (top < safeTop) {
        top = safeTop;
      }
      if (top > safeBottom) {
        top = safeBottom;
      }
    } else if (top < 8) {
      top = Math.min(viewportHeight - buttonHeight - 8, rect.bottom + 10);
    }

    selectionQuoteButton.style.left = `${left}px`;
    selectionQuoteButton.style.top = `${top}px`;
    selectionQuoteButton.hidden = false;
    if (mobileQuoteMode && lockPlacement) {
      selectionQuoteState.setPlacement(placementKey);
    }
  }

  function syncSelectionQuoteAction({
    activeSelectionQuoteFn,
    clearSelectionQuoteState,
    cancelSelectionQuoteClear,
    mobileQuoteMode,
    showSelectionQuoteActionFn,
    selectionQuoteButton,
    selectionQuoteState,
    cancelSelectionQuoteSettle,
    scheduleSelectionQuoteClear,
    scheduleSelectionQuoteSync,
  }) {
    const firstPick = activeSelectionQuoteFn();
    if (!firstPick) {
      clearSelectionQuoteState();
      return;
    }

    cancelSelectionQuoteClear();

    if (!mobileQuoteMode) {
      showSelectionQuoteActionFn(firstPick);
      return;
    }

    const firstKey = quotePlacementKey(firstPick);
    if (!selectionQuoteButton.hidden && selectionQuoteState.placementKey === firstKey) {
      selectionQuoteState.setText(firstPick.text);
      return;
    }

    cancelSelectionQuoteSettle();
    selectionQuoteState.scheduleTimer("settle", 110, () => {
      const settledPick = activeSelectionQuoteFn();
      if (!settledPick) {
        scheduleSelectionQuoteClear(160);
        return;
      }
      const settledKey = quotePlacementKey(settledPick);
      if (settledKey !== firstKey && !isSimilarQuotePlacement(firstPick, settledPick)) {
        scheduleSelectionQuoteSync(140);
        return;
      }
      showSelectionQuoteActionFn(settledPick, { lockPlacement: true });
    });
  }

  function quoteSelectionTextForInsert({ mobileQuoteMode, activeSelectionQuote, selectionQuoteState }) {
    const picked = mobileQuoteMode ? activeSelectionQuote() : null;
    return mobileQuoteMode ? (picked?.text || selectionQuoteState.getText()) : selectionQuoteState.getText();
  }

  function hasMessageSelection(selection, { messagesEl, textNodeType = (typeof Node !== "undefined" ? Node.TEXT_NODE : 3) }) {
    const hasSelection = Boolean(selection && selection.rangeCount >= 1 && !selection.isCollapsed);
    if (!hasSelection || !messagesEl?.contains) return false;
    const rangeNode = selection.getRangeAt?.(0)?.commonAncestorContainer || null;
    const anchorElement = resolveSelectionAnchorElement(
      [rangeNode, selection.anchorNode, selection.focusNode],
      { textNodeType },
    );
    return Boolean(anchorElement && messagesEl.contains(anchorElement));
  }

  function createSelectionQuoteController({
    mobileQuoteMode,
    windowObject,
    documentObject,
    promptEl,
    messagesEl,
    selectionQuoteButton,
    selectionQuoteState,
    activeSelectionQuote,
    cancelSelectionQuoteSync,
    cancelSelectionQuoteSettle,
    cancelSelectionQuoteClear,
    scheduleSelectionQuoteSync,
    scheduleSelectionQuoteClear,
    applyQuoteIntoPrompt,
    clearSelectionQuoteState,
  }) {
    function dismissSelectionQuoteAction({ clearNativeSelection = true } = {}) {
      cancelSelectionQuoteSync();
      cancelSelectionQuoteSettle();
      cancelSelectionQuoteClear();
      if (clearNativeSelection) {
        getActiveSelection({ windowObject, documentObject })?.removeAllRanges?.();
      }
      clearSelectionQuoteState();
    }

    return {
      handleQuoteButtonClick() {
        const textToQuote = quoteSelectionTextForInsert({
          mobileQuoteMode,
          activeSelectionQuote,
          selectionQuoteState,
        });
        if (!textToQuote) return;
        dismissSelectionQuoteAction({ clearNativeSelection: true });
        applyQuoteIntoPrompt(textToQuote);
      },

      handleQuoteButtonPointerDown(event) {
        const pointerType = String(event?.pointerType || "").toLowerCase();
        if (!mobileQuoteMode || !pointerType || pointerType === "mouse") return;
        event?.preventDefault?.();
        event?.stopPropagation?.();
        this.handleQuoteButtonClick();
      },

      handleMessagesMouseUp() {
        if (mobileQuoteMode) return;
        cancelSelectionQuoteClear();
        scheduleSelectionQuoteSync(80);
      },

      handleMessagesTouchStart() {
        if (!mobileQuoteMode) return;
        // Freeze quote action while selection handles are moving.
        cancelSelectionQuoteSync();
        cancelSelectionQuoteSettle();
        cancelSelectionQuoteClear();
        selectionQuoteState.clearPlacement();
        if (selectionQuoteButton) {
          selectionQuoteButton.hidden = true;
        }
      },

      handleMessagesTouchEnd() {
        if (!mobileQuoteMode) return;
        cancelSelectionQuoteClear();
        // Wait for native toolbar/handles to settle before showing popup.
        scheduleSelectionQuoteSync(220);
      },

      handleMessagesTouchCancel() {
        if (!mobileQuoteMode) return;
        cancelSelectionQuoteSync();
        cancelSelectionQuoteSettle();
        scheduleSelectionQuoteClear(220);
      },

      handleDocumentSelectionChange() {
        const active = documentObject.activeElement;
        const selection = getActiveSelection({ windowObject, documentObject });
        const inMessages = hasMessageSelection(selection, { messagesEl });
        const quoteButtonFocused = active === selectionQuoteButton || selectionQuoteButton?.contains?.(active);
        if ((active === promptEl || quoteButtonFocused) && !inMessages) {
          return;
        }

        if (mobileQuoteMode) {
          if (!inMessages) {
            cancelSelectionQuoteSync();
            cancelSelectionQuoteSettle();
            scheduleSelectionQuoteClear(220);
            return;
          }

          // Mobile WebViews can emit repeated selectionchange events while the
          // native selection UI is already settling. If we cancel and re-arm
          // the debounce on every one of those events, the quote popup can be
          // starved forever and never reappear. Only arm the settle cycle once
          // until the pending sync/settle timer finishes.
          const mobileResyncPending = hasSelectionQuoteTimer("sync", { selectionQuoteState })
            || hasSelectionQuoteTimer("settle", { selectionQuoteState });
          if (mobileResyncPending) {
            return;
          }

          cancelSelectionQuoteClear();
          cancelSelectionQuoteSync();
          cancelSelectionQuoteSettle();
          selectionQuoteState.clearPlacement();
          if (selectionQuoteButton) {
            selectionQuoteButton.hidden = true;
          }
          scheduleSelectionQuoteSync(220);
          return;
        }

        if (!inMessages) {
          cancelSelectionQuoteSync();
          clearSelectionQuoteState();
          return;
        }

        // Desktop selection can update live while dragging.
        scheduleSelectionQuoteSync(140);
      },

      handleDocumentPointerDown(event) {
        const target = event?.target;
        if (!target) return;
        if (target === selectionQuoteButton || selectionQuoteButton?.contains?.(target)) return;
        if (messagesEl?.contains?.(target)) return;
        dismissSelectionQuoteAction({ clearNativeSelection: true });
      },

      handleDocumentTouchStart(event) {
        if (!mobileQuoteMode) return;
        const target = event.target;
        if (!target) return;
        if (target === selectionQuoteButton || selectionQuoteButton?.contains?.(target)) return;
        if (messagesEl?.contains?.(target)) {
          const selection = getActiveSelection({ windowObject, documentObject });
          const hasActiveMessageSelection = hasMessageSelection(selection, { messagesEl });
          if (hasActiveMessageSelection) {
            return;
          }
        }
        dismissSelectionQuoteAction({ clearNativeSelection: true });
      },

      handleDocumentPointerEvent(event) {
        const pointerType = String(event?.pointerType || "").toLowerCase();
        if (!pointerType || pointerType === "mouse") return;
        this.handleDocumentTouchStart(event);
      },

      bind() {
        selectionQuoteButton?.addEventListener("click", () => this.handleQuoteButtonClick());
        selectionQuoteButton?.addEventListener("touchstart", (event) => {
          if (!mobileQuoteMode) return;
          // Telegram/iOS selection overlays can swallow the synthetic click that
          // normally follows a tap. Apply the quote on touchstart so the action
          // still fires and the popup clears immediately.
          event?.preventDefault?.();
          event?.stopPropagation?.();
          this.handleQuoteButtonClick();
        }, { passive: false });
        selectionQuoteButton?.addEventListener("pointerdown", (event) => this.handleQuoteButtonPointerDown(event));
        messagesEl.addEventListener("mouseup", () => this.handleMessagesMouseUp());
        messagesEl.addEventListener("touchstart", () => this.handleMessagesTouchStart());
        messagesEl.addEventListener("touchend", () => this.handleMessagesTouchEnd());
        messagesEl.addEventListener("touchcancel", () => this.handleMessagesTouchCancel());
        messagesEl.addEventListener("pointerdown", (event) => {
          if (String(event?.pointerType || "").toLowerCase() === "mouse") return;
          this.handleMessagesTouchStart();
        });
        messagesEl.addEventListener("pointerup", (event) => {
          if (String(event?.pointerType || "").toLowerCase() === "mouse") return;
          this.handleMessagesTouchEnd();
        });
        messagesEl.addEventListener("pointercancel", (event) => {
          if (String(event?.pointerType || "").toLowerCase() === "mouse") return;
          this.handleMessagesTouchCancel();
        });
        documentObject.addEventListener("selectionchange", () => this.handleDocumentSelectionChange());
        documentObject.addEventListener("mousedown", (event) => this.handleDocumentPointerDown(event));
        documentObject.addEventListener("touchstart", (event) => this.handleDocumentTouchStart(event));
        documentObject.addEventListener("pointerdown", (event) => this.handleDocumentPointerEvent(event));
      },
    };
  }

  function createController({
    mobileQuoteMode,
    activeChatId,
    getActiveChatId,
    focusMessagesPaneIfActiveChat,
    submitPromptWithUiError,
    windowObject,
    documentObject,
    promptEl,
    messagesEl,
    selectionQuoteButton,
    selectionQuoteState,
    activeSelectionQuote,
    cancelSelectionQuoteSync,
    cancelSelectionQuoteSettle,
    cancelSelectionQuoteClear,
    scheduleSelectionQuoteSync,
    scheduleSelectionQuoteClear,
    applyQuoteIntoPrompt,
    clearSelectionQuoteState,
  } = {}) {
    let selectionQuoteController = null;
    let selectionQuoteBindingsInstalled = false;

    return {
      handleComposerSubmitShortcut(event) {
        const resolvedActiveChatId = typeof getActiveChatId === "function" ? getActiveChatId() : activeChatId;
        return handleComposerSubmitShortcut(event, {
          mobileQuoteMode,
          activeChatId: resolvedActiveChatId,
          focusMessagesPaneIfActiveChat,
          submitPromptWithUiError,
        });
      },

      getSelectionQuoteController() {
        if (selectionQuoteController) {
          return selectionQuoteController;
        }
        selectionQuoteController = createSelectionQuoteController({
          mobileQuoteMode,
          windowObject,
          documentObject,
          promptEl,
          messagesEl,
          selectionQuoteButton,
          selectionQuoteState,
          activeSelectionQuote,
          cancelSelectionQuoteSync,
          cancelSelectionQuoteSettle,
          cancelSelectionQuoteClear,
          scheduleSelectionQuoteSync,
          scheduleSelectionQuoteClear,
          applyQuoteIntoPrompt,
          clearSelectionQuoteState,
        });
        return selectionQuoteController;
      },

      bindSelectionQuoteBindings() {
        if (selectionQuoteBindingsInstalled) {
          return this.getSelectionQuoteController();
        }
        const controller = this.getSelectionQuoteController();
        controller.bind();
        selectionQuoteBindingsInstalled = true;
        return controller;
      },
    };
  }

  const api = {
    handleComposerSubmitShortcut,
    unwrapLegacyQuoteBlock,
    normalizeQuoteSelection,
    splitGraphemes,
    wrapQuoteLine,
    formatQuoteBlock,
    getQuoteWrapWidth,
    isCoarsePointer,
    clearSelectionQuoteState,
    cancelSelectionQuoteTimer,
    scheduleSelectionQuoteClear,
    scheduleSelectionQuoteSync,
    applyQuoteIntoPrompt,
    activeSelectionQuote,
    quotePlacementKey,
    showSelectionQuoteAction,
    syncSelectionQuoteAction,
    quoteSelectionTextForInsert,
    hasMessageSelection,
    getActiveSelection,
    createSelectionQuoteController,
    createController,
  };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
  globalScope.HermesMiniappInteraction = api;
})(typeof window !== "undefined" ? window : globalThis);
