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

  const api = {
    handleComposerSubmitShortcut,
    quoteSelectionTextForInsert,
    hasMessageSelection,
    createSelectionQuoteController,
  };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
  globalScope.HermesMiniappInteraction = api;
})(typeof window !== "undefined" ? window : globalThis);
