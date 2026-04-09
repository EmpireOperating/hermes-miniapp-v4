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

  function applyQuoteIntoPrompt(text, {
    promptEl,
    formatQuoteBlockFn = formatQuoteBlock,
    ensureComposerVisible = () => {},
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
    promptEl.focus?.();
    promptEl.setSelectionRange?.(nextCaret, nextCaret);
    ensureComposerVisible({ smooth: false });
  }

  function activeSelectionQuote({
    messagesEl,
    windowObject = (typeof window !== "undefined" ? window : null),
    normalizeQuoteSelectionFn = normalizeQuoteSelection,
    textNodeType = (typeof Node !== "undefined" ? Node.TEXT_NODE : 3),
  } = {}) {
    if (!messagesEl || !windowObject) return null;
    const selection = windowObject.getSelection?.();
    if (!selection || selection.rangeCount < 1 || selection.isCollapsed) {
      return null;
    }

    const range = selection.getRangeAt(0);
    const anchorNode = range.commonAncestorContainer;
    const anchorElement = anchorNode?.nodeType === textNodeType ? anchorNode.parentElement : anchorNode;
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

  function showSelectionQuoteAction({ text, rect }, {
    selectionQuoteButton,
    selectionQuoteState,
    mobileQuoteMode,
    windowObject = (typeof window !== "undefined" ? window : null),
    form,
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
      const mobileToolbarUnsafeTop = Math.max(56, Math.round(viewportHeight * 0.18));
      const composerTop = Number(form?.getBoundingClientRect?.().top || viewportHeight);
      const safeBottom = Math.max(mobileToolbarUnsafeTop + buttonHeight + 8, Math.min(viewportHeight - buttonHeight - 8, composerTop - buttonHeight - 12));
      const belowSelection = rect.bottom + 12;
      top = belowSelection;
      if (top < mobileToolbarUnsafeTop) {
        top = mobileToolbarUnsafeTop;
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
      if (settledKey !== firstKey) {
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

  function hasMessageSelection(selection, { messagesEl }) {
    const hasSelection = Boolean(selection && selection.rangeCount >= 1 && !selection.isCollapsed);
    return Boolean(hasSelection && messagesEl?.contains(selection.anchorNode || null));
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
    return {
      handleQuoteButtonClick() {
        const textToQuote = quoteSelectionTextForInsert({
          mobileQuoteMode,
          activeSelectionQuote,
          selectionQuoteState,
        });
        if (!textToQuote) return;
        cancelSelectionQuoteSync();
        cancelSelectionQuoteSettle();
        cancelSelectionQuoteClear();
        applyQuoteIntoPrompt(textToQuote);
        windowObject.getSelection?.()?.removeAllRanges?.();
        clearSelectionQuoteState();
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
        if (active === promptEl) {
          return;
        }

        const selection = documentObject.getSelection?.();
        const inMessages = hasMessageSelection(selection, { messagesEl });

        if (mobileQuoteMode) {
          if (!inMessages) {
            cancelSelectionQuoteSync();
            cancelSelectionQuoteSettle();
            scheduleSelectionQuoteClear(220);
            return;
          }

          // On mobile, hide while selection changes and only reveal after touchend settle.
          cancelSelectionQuoteSync();
          cancelSelectionQuoteSettle();
          selectionQuoteState.clearPlacement();
          if (selectionQuoteButton) {
            selectionQuoteButton.hidden = true;
          }
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

      handleDocumentTouchStart(event) {
        if (!mobileQuoteMode) return;
        const target = event.target;
        if (!target) return;
        if (messagesEl.contains(target)) return;
        if (target === promptEl || promptEl?.contains?.(target)) return;
        cancelSelectionQuoteSync();
        cancelSelectionQuoteSettle();
        scheduleSelectionQuoteClear(220);
      },

      bind() {
        selectionQuoteButton?.addEventListener("click", () => this.handleQuoteButtonClick());
        messagesEl.addEventListener("mouseup", () => this.handleMessagesMouseUp());
        messagesEl.addEventListener("touchstart", () => this.handleMessagesTouchStart());
        messagesEl.addEventListener("touchend", () => this.handleMessagesTouchEnd());
        messagesEl.addEventListener("touchcancel", () => this.handleMessagesTouchCancel());
        documentObject.addEventListener("selectionchange", () => this.handleDocumentSelectionChange());
        documentObject.addEventListener("touchstart", (event) => this.handleDocumentTouchStart(event));
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
    createSelectionQuoteController,
    createController,
  };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
  globalScope.HermesMiniappInteraction = api;
})(typeof window !== "undefined" ? window : globalThis);
