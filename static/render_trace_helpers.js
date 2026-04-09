(function initRenderTraceHelpers(global) {
  "use strict";

  function resolveRenderTraceTextHelpers() {
    if (typeof module !== "undefined" && module.exports) {
      try {
        return require("./render_trace_text_helpers.js");
      } catch {
        // Fall back to global export below.
      }
    }
    return global.HermesMiniappRenderTraceText || null;
  }

  function resolveRenderTraceDebugHelpers() {
    if (typeof module !== "undefined" && module.exports) {
      try {
        return require("./render_trace_debug_helpers.js");
      } catch {
        // Fall back to global export below.
      }
    }
    return global.HermesMiniappRenderTraceDebug || null;
  }

  function resolveRenderTraceMessageHelpers() {
    if (typeof module !== "undefined" && module.exports) {
      try {
        return require("./render_trace_message_helpers.js");
      } catch {
        // Fall back to global export below.
      }
    }
    return global.HermesMiniappRenderTraceMessage || null;
  }

  function resolveRenderTraceHistoryHelpers() {
    if (typeof module !== "undefined" && module.exports) {
      try {
        return require("./render_trace_history_helpers.js");
      } catch {
        // Fall back to global export below.
      }
    }
    return global.HermesMiniappRenderTraceHistory || null;
  }

  function parseBooleanFlag(rawValue) {
    return resolveRenderTraceDebugHelpers()?.parseBooleanFlag(rawValue) ?? null;
  }

  function renderBody(container, rawText, options = {}) {
    return resolveRenderTraceTextHelpers()?.renderBody(container, rawText, options);
  }

  function renderToolTraceBody(container, message, options = {}) {
    return resolveRenderTraceMessageHelpers()?.renderToolTraceBody(container, message, options);
  }

  function roleLabelForMessage(message, options = {}) {
    return resolveRenderTraceMessageHelpers()?.roleLabelForMessage(message, options) || "System";
  }

  function messageVariantForRole(role) {
    return resolveRenderTraceMessageHelpers()?.messageVariantForRole(role) || "system";
  }

  function shouldSkipMessageRender(args = {}) {
    return Boolean(resolveRenderTraceMessageHelpers()?.shouldSkipMessageRender(args));
  }

  function applyMessageMeta(node, message, options = {}) {
    return resolveRenderTraceMessageHelpers()?.applyMessageMeta(node, message, options);
  }

  function renderMessageContent(node, message, renderedBody, options = {}) {
    return resolveRenderTraceMessageHelpers()?.renderMessageContent(node, message, renderedBody, options);
  }

  function messageStableKey(message, index = 0) {
    return resolveRenderTraceMessageHelpers()?.messageStableKey(message, index) || '';
  }

  function messageStableKeyForPendingState(message, index = 0, pendingState = false) {
    return resolveRenderTraceMessageHelpers()?.messageStableKeyForPendingState(message, index, pendingState) || '';
  }

  function upsertMessageNode(node, message, options = {}) {
    return Boolean(resolveRenderTraceMessageHelpers()?.upsertMessageNode(node, message, options));
  }

  function createMessageNode(message, options = {}) {
    return resolveRenderTraceMessageHelpers()?.createMessageNode(message, options) || null;
  }

  function appendMessages(fragment, messages, options = {}) {
    return resolveRenderTraceMessageHelpers()?.appendMessages(fragment, messages, options);
  }

  function findMessageNodeByKey(container, selector, messageKey, alternateMessageKey = "") {
    return resolveRenderTraceMessageHelpers()?.findMessageNodeByKey(container, selector, messageKey, alternateMessageKey) || null;
  }

  function findLatestHistoryMessageByRole(history, role, options = {}) {
    return resolveRenderTraceMessageHelpers()?.findLatestHistoryMessageByRole(history, role, options) || null;
  }

  function findLatestAssistantHistoryMessage(history, options = {}) {
    return resolveRenderTraceMessageHelpers()?.findLatestAssistantHistoryMessage(history, options) || null;
  }

  function patchVisiblePendingAssistant({
    chatId,
    activeChatId,
    phase,
    nextBody,
    pendingState = true,
    messagesContainer,
    history,
  } = {}, deps = {}) {
    return Boolean(resolveRenderTraceMessageHelpers()?.patchVisiblePendingAssistant({
      chatId,
      activeChatId,
      phase,
      nextBody,
      pendingState,
      messagesContainer,
      history,
    }, deps));
  }

  function patchVisibleToolTrace({
    chatId,
    activeChatId,
    phase,
    messagesContainer,
    history,
  } = {}, deps = {}) {
    return Boolean(resolveRenderTraceMessageHelpers()?.patchVisibleToolTrace({
      chatId,
      activeChatId,
      phase,
      messagesContainer,
      history,
    }, deps));
  }

  function createMessageRenderController(deps) {
    return resolveRenderTraceMessageHelpers()?.createController(deps) || {
      renderBody,
      renderToolTraceBody,
      roleLabelForMessage,
      messageVariantForRole,
      shouldSkipMessageRender,
      applyMessageMeta,
      renderMessageContent,
      messageStableKey,
      messageStableKeyForPendingState,
      upsertMessageNode,
      createMessageNode,
      appendMessages,
      findMessageNodeByKey(selector, messageKey, alternateMessageKey = "") {
        return findMessageNodeByKey(
          typeof deps?.getMessagesContainer === "function" ? deps.getMessagesContainer() : null,
          selector,
          messageKey,
          alternateMessageKey,
        );
      },
      findLatestHistoryMessageByRole(chatId, role, options = {}) {
        const history = typeof deps?.getHistory === "function" ? deps.getHistory(chatId) : [];
        return findLatestHistoryMessageByRole(Array.isArray(history) ? history : [], role, options);
      },
      findLatestAssistantHistoryMessage(chatId, options = {}) {
        const history = typeof deps?.getHistory === "function" ? deps.getHistory(chatId) : [];
        return findLatestAssistantHistoryMessage(Array.isArray(history) ? history : [], options);
      },
      patchVisiblePendingAssistant(chatId, nextBody, pendingState = true) {
        const history = typeof deps?.getHistory === "function" ? deps.getHistory(chatId) : [];
        return patchVisiblePendingAssistant({
          chatId,
          activeChatId: typeof deps?.getActiveChatId === "function" ? deps.getActiveChatId() : null,
          phase: typeof deps?.getStreamPhase === "function" ? deps.getStreamPhase(chatId) : null,
          nextBody,
          pendingState,
          messagesContainer: typeof deps?.getMessagesContainer === "function" ? deps.getMessagesContainer() : null,
          history: Array.isArray(history) ? history : [],
        }, {
          isPatchPhaseAllowedFn: deps?.isPatchPhaseAllowedFn,
          findLatestAssistantHistoryMessageFn: findLatestAssistantHistoryMessage,
          findMessageNodeByKeyFn: findMessageNodeByKey,
          renderTraceLogFn: deps?.renderTraceLogFn,
          preserveViewportDuringUiMutationFn: deps?.preserveViewportDuringUiMutationFn,
          renderBodyFn: renderBody,
        });
      },
      patchVisibleToolTrace(chatId) {
        const history = typeof deps?.getHistory === "function" ? deps.getHistory(chatId) : [];
        return patchVisibleToolTrace({
          chatId,
          activeChatId: typeof deps?.getActiveChatId === "function" ? deps.getActiveChatId() : null,
          phase: typeof deps?.getStreamPhase === "function" ? deps.getStreamPhase(chatId) : null,
          messagesContainer: typeof deps?.getMessagesContainer === "function" ? deps.getMessagesContainer() : null,
          history: Array.isArray(history) ? history : [],
        }, {
          isPatchPhaseAllowedFn: deps?.isPatchPhaseAllowedFn,
          findLatestHistoryMessageByRoleFn: findLatestHistoryMessageByRole,
          findMessageNodeByKeyFn: findMessageNodeByKey,
          renderTraceLogFn: deps?.renderTraceLogFn,
          preserveViewportDuringUiMutationFn: deps?.preserveViewportDuringUiMutationFn,
          renderToolTraceBodyFn: renderToolTraceBody,
          formatMessageTimeFn: deps?.formatMessageTimeFn,
        });
      },
    };
  }

  function createHistoryRenderController(deps) {
    return resolveRenderTraceHistoryHelpers()?.createHistoryRenderController(deps) || {
      isNearBottom() { return true; },
      shouldVirtualizeHistory() { return false; },
      getEstimatedMessageHeight() { return 108; },
      updateVirtualMetrics() {},
      updateJumpLatestVisibility() {},
      markStreamUpdate() {},
      computeVirtualRange() { return { start: 0, end: 0 }; },
      renderVirtualizedHistory() {},
      renderFullHistory() {},
      tryAppendOnlyRender() { return false; },
      restoreMessageViewport() {},
      finalizeRenderMessages() {},
      renderMessages() {},
    };
  }

  function createController(deps) {
    return resolveRenderTraceDebugHelpers()?.createController(deps) || {
      parseBooleanFlag,
      resolveRenderTraceDebugEnabled() {
        return false;
      },
      syncRenderTraceBadge() {},
      setRenderTraceDebugEnabled() {},
      handleRenderTraceBadgeClick() {},
      renderTraceLog() {},
    };
  }

  const api = {
    parseBooleanFlag,
    renderBody,
    renderToolTraceBody,
    roleLabelForMessage,
    messageVariantForRole,
    shouldSkipMessageRender,
    applyMessageMeta,
    renderMessageContent,
    messageStableKey,
    messageStableKeyForPendingState,
    upsertMessageNode,
    createMessageNode,
    appendMessages,
    findMessageNodeByKey,
    findLatestHistoryMessageByRole,
    findLatestAssistantHistoryMessage,
    patchVisiblePendingAssistant,
    patchVisibleToolTrace,
    createMessageRenderController,
    createHistoryRenderController,
    createController,
  };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
  global.HermesMiniappRenderTrace = api;
})(typeof window !== "undefined" ? window : globalThis);
