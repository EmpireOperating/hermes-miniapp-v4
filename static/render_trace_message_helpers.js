(function initRenderTraceMessageHelpers(global) {
  "use strict";

  function renderToolTraceBody(container, message, {
    cleanDisplayTextFn,
    documentObject = (typeof document !== "undefined" ? document : null),
    windowObject = (typeof window !== "undefined" ? window : null),
  } = {}) {
    if (!container || typeof cleanDisplayTextFn !== "function" || !documentObject) return;

    function findChildByClassName(node, className) {
      if (!node) return null;
      if (typeof node.querySelector === "function") {
        const match = node.querySelector(`.${className}`);
        if (match) return match;
      }
      const children = Array.isArray(node.children) ? node.children : [];
      for (const child of children) {
        if (String(child?.className || "") === className) {
          return child;
        }
      }
      return null;
    }

    function isNearElementBottom(element, threshold = 40) {
      if (!element) return true;
      const scrollHeight = Number(element.scrollHeight);
      const clientHeight = Number(element.clientHeight);
      const scrollTop = Number(element.scrollTop);
      if (!Number.isFinite(scrollHeight) || !Number.isFinite(clientHeight) || !Number.isFinite(scrollTop)) {
        return true;
      }
      return (scrollHeight - clientHeight - scrollTop) <= threshold;
    }

    const previousDetails = findChildByClassName(container, "tool-trace");
    const previousList = findChildByClassName(previousDetails, "tool-trace__lines");
    const previousDetailsOpen = Boolean(previousDetails?.open);
    const previousListScrollTop = Number(previousList?.scrollTop);
    const previousListShouldStickBottom = isNearElementBottom(previousList, 40);

    container.innerHTML = "";
    const text = cleanDisplayTextFn(message?.body || "");
    const lines = text ? text.split("\n").map((line) => line.trim()).filter(Boolean) : [];
    if (!lines.length && !message?.pending) {
      return;
    }

    function findNearestScrollContainer(node) {
      let current = node && typeof node.parentNode !== "undefined" ? node.parentNode : null;
      while (current) {
        if (typeof current.scrollTop === "number") {
          return current;
        }
        current = current.parentNode || null;
      }
      return null;
    }

    function captureViewportSnapshot() {
      return {
        scroller: findNearestScrollContainer(container),
        scrollTop: Number(findNearestScrollContainer(container)?.scrollTop || 0),
        windowScrollY: Number(windowObject?.scrollY || 0),
      };
    }

    function restoreViewportSnapshot(snapshot) {
      if (!snapshot) return;
      const apply = () => {
        if (snapshot.scroller && typeof snapshot.scroller.scrollTop === "number") {
          snapshot.scroller.scrollTop = snapshot.scrollTop;
        }
        if (windowObject && typeof windowObject.scrollTo === "function") {
          windowObject.scrollTo(0, snapshot.windowScrollY);
        }
      };
      if (windowObject && typeof windowObject.requestAnimationFrame === "function") {
        windowObject.requestAnimationFrame(apply);
        return;
      }
      apply();
    }

    const details = documentObject.createElement("details");
    details.className = "tool-trace";
    const collapsed = typeof message?.collapsed === "boolean" ? message.collapsed : !message?.pending;
    const shouldPreserveLiveDetailsOpenState = Boolean(previousDetails && message?.pending);
    const effectiveCollapsed = shouldPreserveLiveDetailsOpenState ? !previousDetailsOpen : collapsed;
    if (message && typeof message === "object") {
      message.collapsed = effectiveCollapsed;
    }
    details.open = !effectiveCollapsed;

    const summary = documentObject.createElement("summary");
    const lineCount = lines.length;
    const toolCallCount = Number(message?.tool_call_count);
    const hasToolCallCount = Number.isFinite(toolCallCount) && toolCallCount > 0;
    const summaryCount = hasToolCallCount ? toolCallCount : lineCount;
    const liveSuffix = message?.pending ? " · live" : "";
    summary.textContent = `Tool activity (${summaryCount})${liveSuffix}`;
    details.appendChild(summary);

    const list = documentObject.createElement("div");
    list.className = "tool-trace__lines";
    if (lines.length) {
      for (const line of lines) {
        const row = documentObject.createElement("div");
        row.className = "tool-trace__line";
        row.textContent = line;
        list.appendChild(row);
      }
    } else {
      const empty = documentObject.createElement("div");
      empty.className = "tool-trace__line tool-trace__line--muted";
      empty.textContent = "Waiting for tool activity…";
      list.appendChild(empty);
    }
    details.appendChild(list);

    let pendingViewportSnapshot = null;
    const capturePendingViewportSnapshot = () => {
      pendingViewportSnapshot = captureViewportSnapshot();
    };
    summary.addEventListener("click", capturePendingViewportSnapshot);
    summary.addEventListener("keydown", (event) => {
      const key = String(event?.key || "");
      if (key === "Enter" || key === " ") {
        capturePendingViewportSnapshot();
      }
    });

    details.addEventListener("toggle", () => {
      message.collapsed = !details.open;
      restoreViewportSnapshot(pendingViewportSnapshot);
      pendingViewportSnapshot = null;
    });

    container.appendChild(details);

    if (details.open && previousDetailsOpen && Number.isFinite(previousListScrollTop)) {
      if (previousListShouldStickBottom) {
        list.scrollTop = Number(list.scrollHeight) || previousListScrollTop;
      } else {
        list.scrollTop = Math.max(0, previousListScrollTop);
      }
    }
  }

  function roleLabelForMessage(message, {
    operatorDisplayName = "Operator",
  } = {}) {
    const role = String(message?.role || "").toLowerCase();
    if (role === "operator" || role === "user") {
      return operatorDisplayName || "Operator";
    }
    if (role === "hermes" || role === "assistant") {
      return "Hermes";
    }
    if (role === "tool") {
      return "Tool";
    }
    return "System";
  }

  function messageVariantForRole(role) {
    if (role === "operator" || role === "user") return "operator";
    if (role === "hermes" || role === "assistant") return "assistant";
    if (role === "tool") return "tool";
    return "system";
  }

  function shouldSkipMessageRender({ role, renderedBody, pending, attachments = [] }) {
    return !renderedBody && !pending && role !== "tool" && (!Array.isArray(attachments) || !attachments.length);
  }

  function applyMessageMeta(node, message, {
    role,
    variant,
    roleLabelForMessageFn,
    formatMessageTimeFn,
  } = {}) {
    if (!node || typeof roleLabelForMessageFn !== "function" || typeof formatMessageTimeFn !== "function") return;
    node.classList.add(`message--${variant}`);
    if (message?.pending) {
      node.classList.add("message--pending");
    }
    node.dataset.role = role;
    node.querySelector(".message__role").textContent = roleLabelForMessageFn(message);
    node.querySelector(".message__time").textContent = formatMessageTimeFn(message?.created_at);
  }

  function renderMessageContent(node, message, renderedBody, {
    renderToolTraceBodyFn,
    renderBodyFn,
  } = {}) {
    if (!node || typeof renderToolTraceBodyFn !== "function" || typeof renderBodyFn !== "function") return;
    const bodyNode = node.querySelector(".message__body");
    if (String(message?.role || "").toLowerCase() === "tool") {
      renderToolTraceBodyFn(bodyNode, message);
      return;
    }
    renderBodyFn(bodyNode, renderedBody, {
      fileRefs: message?.file_refs || null,
      attachments: Array.isArray(message?.attachments) ? message.attachments : [],
    });
  }

  function messageStableKey(message, index = 0) {
    const messageId = Number(message?.id || 0);
    if (Number.isFinite(messageId) && messageId > 0) {
      return `id:${messageId}`;
    }

    const role = String(message?.role || "").toLowerCase();
    const pending = Boolean(message?.pending) ? "pending" : "sent";
    const createdAt = String(message?.created_at || "");
    return `local:${role}:${pending}:${createdAt}:${index}`;
  }

  function messageStableKeyForPendingState(message, index = 0, pendingState = false) {
    const messageId = Number(message?.id || 0);
    if (Number.isFinite(messageId) && messageId > 0) {
      return `id:${messageId}`;
    }

    const role = String(message?.role || "").toLowerCase();
    const pending = Boolean(pendingState) ? "pending" : "sent";
    const createdAt = String(message?.created_at || "");
    return `local:${role}:${pending}:${createdAt}:${index}`;
  }

  function upsertMessageNode(node, message, {
    cleanDisplayTextFn,
    shouldSkipMessageRenderFn,
    messageVariantForRoleFn,
    applyMessageMetaFn,
    renderMessageContentFn,
  } = {}) {
    if (
      !node
      || typeof cleanDisplayTextFn !== "function"
      || typeof shouldSkipMessageRenderFn !== "function"
      || typeof messageVariantForRoleFn !== "function"
      || typeof applyMessageMetaFn !== "function"
      || typeof renderMessageContentFn !== "function"
    ) {
      return false;
    }

    const role = String(message?.role || "").toLowerCase();
    const renderedBody = cleanDisplayTextFn(message?.body || (message?.pending ? "…" : ""));
    const attachments = Array.isArray(message?.attachments) ? message.attachments : [];
    if (shouldSkipMessageRenderFn({ role, renderedBody, pending: Boolean(message?.pending), attachments })) {
      return false;
    }

    const variant = messageVariantForRoleFn(role);
    node.className = "message";
    applyMessageMetaFn(node, message, { role, variant });
    renderMessageContentFn(node, message, renderedBody, {
      role,
      variant,
    });
    return true;
  }

  function createMessageNode(message, {
    index = 0,
    templateElement,
    upsertMessageNodeFn,
    messageStableKeyFn = messageStableKey,
  } = {}) {
    if (
      !templateElement
      || !templateElement.content
      || !templateElement.content.firstElementChild
      || typeof upsertMessageNodeFn !== "function"
      || typeof messageStableKeyFn !== "function"
    ) {
      return null;
    }

    const node = templateElement.content.firstElementChild.cloneNode(true);
    if (!upsertMessageNodeFn(node, message)) {
      return null;
    }

    node.dataset.messageKey = messageStableKeyFn(message, index);
    if (Number.isFinite(Number(message?.id)) && Number(message.id) > 0) {
      node.dataset.messageId = String(Number(message.id));
    } else {
      delete node.dataset.messageId;
    }
    return node;
  }

  function appendMessages(fragment, messages, {
    startIndex = 0,
    createMessageNodeFn,
  } = {}) {
    if (!fragment || !Array.isArray(messages) || typeof createMessageNodeFn !== "function") return;
    messages.forEach((message, offset) => {
      const node = createMessageNodeFn(message, { index: startIndex + offset });
      if (node) {
        fragment.appendChild(node);
      }
    });
  }

  function findMessageNodeByKey(container, selector, messageKey, alternateMessageKey = "") {
    if (!container || typeof container.querySelectorAll !== "function") return null;
    const nodes = container.querySelectorAll(selector);
    const target = String(messageKey || "");
    const alternate = String(alternateMessageKey || "");
    for (let index = nodes.length - 1; index >= 0; index -= 1) {
      const candidate = nodes[index];
      const candidateKey = String(candidate?.dataset?.messageKey || "");
      if (candidateKey === target) {
        return candidate;
      }
      if (alternate && candidateKey === alternate) {
        return candidate;
      }
    }
    return null;
  }

  function findLatestHistoryMessageByRole(history, role, {
    pendingOnly = null,
    messageStableKeyFn = messageStableKey,
    messageStableKeyForPendingStateFn = messageStableKeyForPendingState,
  } = {}) {
    if (!Array.isArray(history) || typeof messageStableKeyFn !== "function" || typeof messageStableKeyForPendingStateFn !== "function") {
      return null;
    }

    const targetRole = String(role || "").toLowerCase();
    for (let index = history.length - 1; index >= 0; index -= 1) {
      const item = history[index];
      if (String(item?.role || "").toLowerCase() !== targetRole) continue;
      if (pendingOnly !== null && Boolean(item?.pending) !== Boolean(pendingOnly)) continue;
      return {
        message: item,
        index,
        key: messageStableKeyFn(item, index),
        alternatePendingKey: messageStableKeyForPendingStateFn(item, index, !Boolean(item?.pending)),
      };
    }
    return null;
  }

  function findLatestAssistantHistoryMessage(history, {
    pendingOnly = null,
    messageStableKeyFn = messageStableKey,
    messageStableKeyForPendingStateFn = messageStableKeyForPendingState,
  } = {}) {
    if (!Array.isArray(history) || typeof messageStableKeyFn !== "function" || typeof messageStableKeyForPendingStateFn !== "function") {
      return null;
    }

    for (let index = history.length - 1; index >= 0; index -= 1) {
      const item = history[index];
      const role = String(item?.role || "").toLowerCase();
      if (role !== "assistant" && role !== "hermes") continue;
      if (pendingOnly !== null && Boolean(item?.pending) !== Boolean(pendingOnly)) continue;
      return {
        message: item,
        index,
        key: messageStableKeyFn(item, index),
        alternatePendingKey: messageStableKeyForPendingStateFn(item, index, !Boolean(item?.pending)),
      };
    }
    return null;
  }

  function patchVisiblePendingAssistant({
    chatId,
    activeChatId,
    phase,
    nextBody,
    pendingState = true,
    messagesContainer,
    history,
  } = {}, {
    isPatchPhaseAllowedFn,
    findLatestAssistantHistoryMessageFn,
    findMessageNodeByKeyFn,
    renderTraceLogFn,
    preserveViewportDuringUiMutationFn,
    renderBodyFn,
  } = {}) {
    const normalizedChatId = Number(chatId);
    if (normalizedChatId !== Number(activeChatId)) return false;

    if (typeof isPatchPhaseAllowedFn !== "function" || !isPatchPhaseAllowedFn(phase)) {
      if (typeof renderTraceLogFn === "function") {
        renderTraceLogFn("stream-assistant-phase-mismatch", { chatId: normalizedChatId, phase });
      }
      return false;
    }

    if (
      typeof findLatestAssistantHistoryMessageFn !== "function"
      || typeof findMessageNodeByKeyFn !== "function"
      || typeof renderBodyFn !== "function"
      || typeof preserveViewportDuringUiMutationFn !== "function"
    ) {
      return false;
    }

    const assistantTarget = findLatestAssistantHistoryMessageFn(history, { pendingOnly: null });
    if (!assistantTarget) {
      if (typeof renderTraceLogFn === "function") {
        renderTraceLogFn("stream-assistant-target-missing", { chatId: normalizedChatId, phase });
      }
      return false;
    }

    const node = findMessageNodeByKeyFn(
      messagesContainer,
      ".message--assistant",
      assistantTarget.key,
      assistantTarget.alternatePendingKey,
    );
    if (!node) {
      if (typeof renderTraceLogFn === "function") {
        renderTraceLogFn("stream-assistant-node-missing", {
          chatId: normalizedChatId,
          phase,
          targetKey: assistantTarget.key,
          alternateKey: assistantTarget.alternatePendingKey,
        });
      }
      return false;
    }

    const patchedNodeKey = String(node?.dataset?.messageKey || "");
    if (patchedNodeKey !== assistantTarget.key && patchedNodeKey !== assistantTarget.alternatePendingKey) {
      if (typeof renderTraceLogFn === "function") {
        renderTraceLogFn("stream-assistant-key-mismatch", {
          chatId: normalizedChatId,
          phase,
          targetKey: assistantTarget.key,
          alternateKey: assistantTarget.alternatePendingKey,
          patchedNodeKey,
        });
      }
      return false;
    }

    const bodyNode = node.querySelector(".message__body");
    if (!bodyNode) return false;

    const assistantFileRefs = Array.isArray(assistantTarget?.message?.file_refs)
      ? assistantTarget.message.file_refs
      : null;

    preserveViewportDuringUiMutationFn(() => {
      renderBodyFn(bodyNode, nextBody || (pendingState ? "…" : ""), { fileRefs: assistantFileRefs });
      node.classList.toggle("message--pending", Boolean(pendingState));
    });
    return true;
  }

  function patchVisibleToolTrace({
    chatId,
    activeChatId,
    phase,
    messagesContainer,
    history,
  } = {}, {
    isPatchPhaseAllowedFn,
    findLatestHistoryMessageByRoleFn,
    findMessageNodeByKeyFn,
    renderTraceLogFn,
    preserveViewportDuringUiMutationFn,
    renderToolTraceBodyFn,
    formatMessageTimeFn,
  } = {}) {
    const normalizedChatId = Number(chatId);
    if (normalizedChatId !== Number(activeChatId)) return false;

    if (typeof isPatchPhaseAllowedFn !== "function" || !isPatchPhaseAllowedFn(phase)) {
      if (typeof renderTraceLogFn === "function") {
        renderTraceLogFn("stream-tool-phase-mismatch", { chatId: normalizedChatId, phase });
      }
      return false;
    }

    if (
      typeof findLatestHistoryMessageByRoleFn !== "function"
      || typeof findMessageNodeByKeyFn !== "function"
      || typeof preserveViewportDuringUiMutationFn !== "function"
      || typeof renderToolTraceBodyFn !== "function"
      || typeof formatMessageTimeFn !== "function"
    ) {
      return false;
    }

    const latestToolTarget = findLatestHistoryMessageByRoleFn(history, "tool", { pendingOnly: null });
    if (!latestToolTarget) {
      return true;
    }

    const node = findMessageNodeByKeyFn(
      messagesContainer,
      ".message--tool",
      latestToolTarget.key,
      latestToolTarget.alternatePendingKey,
    );
    if (!node) {
      if (typeof renderTraceLogFn === "function") {
        renderTraceLogFn("stream-tool-node-missing", {
          chatId: normalizedChatId,
          phase,
          targetKey: latestToolTarget.key,
          alternateKey: latestToolTarget.alternatePendingKey,
        });
      }
      return false;
    }

    const patchedNodeKey = String(node?.dataset?.messageKey || "");
    if (patchedNodeKey !== latestToolTarget.key && patchedNodeKey !== latestToolTarget.alternatePendingKey) {
      if (typeof renderTraceLogFn === "function") {
        renderTraceLogFn("stream-tool-key-mismatch", {
          chatId: normalizedChatId,
          phase,
          targetKey: latestToolTarget.key,
          alternateKey: latestToolTarget.alternatePendingKey,
          patchedNodeKey,
        });
      }
      return false;
    }

    const bodyNode = node.querySelector(".message__body");
    const timeNode = node.querySelector(".message__time");
    if (!bodyNode || !timeNode) return false;

    preserveViewportDuringUiMutationFn(() => {
      renderToolTraceBodyFn(bodyNode, latestToolTarget.message);
      timeNode.textContent = formatMessageTimeFn(latestToolTarget.message?.created_at);
      node.classList.toggle("message--pending", Boolean(latestToolTarget.message?.pending));
    });
    return true;
  }

  function createController({
    cleanDisplayTextFn,
    escapeHtmlFn,
    buildAttachmentUrlFn,
    getAllowedRoots,
    documentObject = (typeof document !== "undefined" ? document : null),
    windowObject = (typeof window !== "undefined" ? window : null),
    getOperatorDisplayName,
    formatMessageTimeFn,
    templateElement,
    getHistory,
    getMessagesContainer,
    getActiveChatId,
    getStreamPhase,
    isPatchPhaseAllowedFn,
    renderTraceLogFn,
    preserveViewportDuringUiMutationFn,
  } = {}) {
    function renderBodyForMessage(container, rawText, { fileRefs = null, attachments = [] } = {}) {
      return global.HermesMiniappRenderTraceText?.renderBody(container, rawText, {
        cleanDisplayTextFn,
        escapeHtmlFn,
        buildAttachmentUrlFn,
        fileRefs,
        attachments,
        allowedRoots: typeof getAllowedRoots === "function" ? getAllowedRoots() : [],
      });
    }

    function renderToolTraceBodyForMessage(container, message) {
      return renderToolTraceBody(container, message, {
        cleanDisplayTextFn,
        documentObject,
        windowObject,
      });
    }

    function roleLabelForRenderedMessage(message) {
      return roleLabelForMessage(message, {
        operatorDisplayName: typeof getOperatorDisplayName === "function"
          ? getOperatorDisplayName()
          : "Operator",
      });
    }

    function applyMessageMetaForNode(node, message, { role, variant } = {}) {
      return applyMessageMeta(node, message, {
        role,
        variant,
        roleLabelForMessageFn: roleLabelForRenderedMessage,
        formatMessageTimeFn,
      });
    }

    function renderMessageContentForNode(node, message, renderedBody) {
      return renderMessageContent(node, message, renderedBody, {
        renderToolTraceBodyFn: renderToolTraceBodyForMessage,
        renderBodyFn: renderBodyForMessage,
      });
    }

    function upsertMessageNodeForRender(node, message) {
      return upsertMessageNode(node, message, {
        cleanDisplayTextFn,
        shouldSkipMessageRenderFn: shouldSkipMessageRender,
        messageVariantForRoleFn: messageVariantForRole,
        applyMessageMetaFn: applyMessageMetaForNode,
        renderMessageContentFn: renderMessageContentForNode,
      });
    }

    function createMessageNodeForRender(message, { index = 0 } = {}) {
      return createMessageNode(message, {
        index,
        templateElement,
        upsertMessageNodeFn: upsertMessageNodeForRender,
        messageStableKeyFn: messageStableKey,
      });
    }

    function appendMessagesForRender(fragment, messages, options = {}) {
      const normalizedOptions = (typeof options === "number")
        ? { startIndex: options }
        : (options && typeof options === "object" ? options : {});
      return appendMessages(fragment, messages, {
        ...normalizedOptions,
        startIndex: Number(normalizedOptions.startIndex) || 0,
        createMessageNodeFn: createMessageNodeForRender,
      });
    }

    function getHistoryForChat(chatId) {
      if (typeof getHistory !== "function") return [];
      const history = getHistory(chatId);
      return Array.isArray(history) ? history : [];
    }

    function findLatestHistoryMessageByRoleForChat(chatId, role, { pendingOnly = null } = {}) {
      return findLatestHistoryMessageByRole(getHistoryForChat(chatId), role, {
        pendingOnly,
        messageStableKeyFn: messageStableKey,
        messageStableKeyForPendingStateFn: messageStableKeyForPendingState,
      });
    }

    function findLatestAssistantHistoryMessageForChat(chatId, { pendingOnly = null } = {}) {
      return findLatestAssistantHistoryMessage(getHistoryForChat(chatId), {
        pendingOnly,
        messageStableKeyFn: messageStableKey,
        messageStableKeyForPendingStateFn: messageStableKeyForPendingState,
      });
    }

    function findMessageNodeByKeyForChat(selector, messageKey, alternateMessageKey = "") {
      return findMessageNodeByKey(
        typeof getMessagesContainer === "function" ? getMessagesContainer() : null,
        selector,
        messageKey,
        alternateMessageKey,
      );
    }

    function patchVisiblePendingAssistantForChat(chatId, nextBody, pendingState = true) {
      return patchVisiblePendingAssistant({
        chatId,
        activeChatId: typeof getActiveChatId === "function" ? getActiveChatId() : null,
        phase: typeof getStreamPhase === "function" ? getStreamPhase(chatId) : null,
        nextBody,
        pendingState,
        messagesContainer: typeof getMessagesContainer === "function" ? getMessagesContainer() : null,
        history: getHistoryForChat(chatId),
      }, {
        isPatchPhaseAllowedFn,
        findLatestAssistantHistoryMessageFn: findLatestAssistantHistoryMessage,
        findMessageNodeByKeyFn: findMessageNodeByKey,
        renderTraceLogFn,
        preserveViewportDuringUiMutationFn,
        renderBodyFn: renderBodyForMessage,
      });
    }

    function patchVisibleToolTraceForChat(chatId) {
      return patchVisibleToolTrace({
        chatId,
        activeChatId: typeof getActiveChatId === "function" ? getActiveChatId() : null,
        phase: typeof getStreamPhase === "function" ? getStreamPhase(chatId) : null,
        messagesContainer: typeof getMessagesContainer === "function" ? getMessagesContainer() : null,
        history: getHistoryForChat(chatId),
      }, {
        isPatchPhaseAllowedFn,
        findLatestHistoryMessageByRoleFn: findLatestHistoryMessageByRole,
        findMessageNodeByKeyFn: findMessageNodeByKey,
        renderTraceLogFn,
        preserveViewportDuringUiMutationFn,
        renderToolTraceBodyFn: renderToolTraceBodyForMessage,
        formatMessageTimeFn,
      });
    }

    return {
      renderBody: renderBodyForMessage,
      renderToolTraceBody: renderToolTraceBodyForMessage,
      roleLabelForMessage: roleLabelForRenderedMessage,
      messageVariantForRole,
      shouldSkipMessageRender,
      applyMessageMeta: applyMessageMetaForNode,
      renderMessageContent: renderMessageContentForNode,
      messageStableKey,
      messageStableKeyForPendingState,
      upsertMessageNode: upsertMessageNodeForRender,
      createMessageNode: createMessageNodeForRender,
      appendMessages: appendMessagesForRender,
      findLatestHistoryMessageByRole: findLatestHistoryMessageByRoleForChat,
      findLatestAssistantHistoryMessage: findLatestAssistantHistoryMessageForChat,
      findMessageNodeByKey: findMessageNodeByKeyForChat,
      patchVisiblePendingAssistant: patchVisiblePendingAssistantForChat,
      patchVisibleToolTrace: patchVisibleToolTraceForChat,
    };
  }

  const api = {
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
    createController,
  };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
  global.HermesMiniappRenderTraceMessage = api;
})(typeof window !== "undefined" ? window : globalThis);
