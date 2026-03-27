(function initHermesMiniappMessageActions(globalScope) {
  function createMessageCopyState({ minHandledIntervalMs = 350 } = {}) {
    return {
      minHandledIntervalMs,
      handledAtByButton: new WeakMap(),
      resetTimerByButton: new WeakMap(),

      wasHandledRecently(button, now = Date.now()) {
        const lastHandledAt = Number(this.handledAtByButton.get(button) || 0);
        return now - lastHandledAt < this.minHandledIntervalMs;
      },

      markHandled(button, now = Date.now()) {
        this.handledAtByButton.set(button, Number(now) || Date.now());
      },

      cancelReset(button) {
        const timerId = this.resetTimerByButton.get(button);
        if (!timerId) return;
        globalScope.clearTimeout(timerId);
        this.resetTimerByButton.delete(button);
      },

      scheduleReset(button, delayMs, callback) {
        this.cancelReset(button);
        const safeDelay = Math.max(0, Number(delayMs) || 0);
        const timerId = globalScope.setTimeout(() => {
          this.resetTimerByButton.delete(button);
          callback();
        }, safeDelay);
        this.resetTimerByButton.set(button, timerId);
      },
    };
  }

  function copyTextFromMessageButton(copyButton, { normalizeText } = {}) {
    const messageNode = copyButton?.closest?.(".message");
    const bodyNode = messageNode?.querySelector?.(".message__body");
    const rawText = bodyNode?.innerText || bodyNode?.textContent || "";
    if (typeof normalizeText === "function") {
      return normalizeText(rawText);
    }
    return String(rawText || "").trim();
  }

  function setCopyButtonFeedback(copyButton, copied) {
    if (!copyButton) return;
    copyButton.classList.remove("is-copied", "is-error");
    copyButton.textContent = copied ? "✓" : "!";
    copyButton.setAttribute("aria-label", copied ? "Copied" : "Copy failed");
    copyButton.title = copied ? "Copied" : "Copy failed";
    copyButton.classList.add(copied ? "is-copied" : "is-error");
  }

  function resetCopyButtonFeedback(copyButton) {
    if (!copyButton) return;
    copyButton.classList.remove("is-copied", "is-error");
    copyButton.textContent = "⧉";
    copyButton.setAttribute("aria-label", "Copy message");
    copyButton.title = "Copy message";
  }

  async function handleMessageCopy(event, {
    messagesEl,
    messageCopyState,
    normalizeText,
    copyTextToClipboard,
  }) {
    const copyButton = event?.target?.closest?.(".message__copy");
    if (!copyButton || !messagesEl?.contains?.(copyButton)) return;

    event.preventDefault();
    event.stopPropagation();

    const now = Date.now();
    if (messageCopyState.wasHandledRecently(copyButton, now)) {
      return;
    }
    messageCopyState.markHandled(copyButton, now);

    const copyText = copyTextFromMessageButton(copyButton, { normalizeText });
    const copied = await copyTextToClipboard(copyText);

    setCopyButtonFeedback(copyButton, copied);
    messageCopyState.scheduleReset(copyButton, copied ? 1200 : 1600, () => {
      resetCopyButtonFeedback(copyButton);
    });
  }

  function bindMessageCopyHandler({
    messagesEl,
    messageCopyState,
    normalizeText,
    copyTextToClipboard,
  }) {
    if (!messagesEl) return () => {};
    if (typeof copyTextToClipboard !== "function") {
      throw new Error("bindMessageCopyHandler requires copyTextToClipboard");
    }

    const state = messageCopyState || createMessageCopyState();
    const handler = (event) => {
      void handleMessageCopy(event, {
        messagesEl,
        messageCopyState: state,
        normalizeText,
        copyTextToClipboard,
      });
    };

    messagesEl.addEventListener("click", handler);
    return () => {
      messagesEl.removeEventListener("click", handler);
    };
  }

  const api = {
    createMessageCopyState,
    copyTextFromMessageButton,
    setCopyButtonFeedback,
    resetCopyButtonFeedback,
    handleMessageCopy,
    bindMessageCopyHandler,
  };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
  globalScope.HermesMiniappMessageActions = api;
})(typeof window !== "undefined" ? window : globalThis);
