(function initRenderTraceHelpers(global) {
  "use strict";

  function parseBooleanFlag(rawValue) {
    if (rawValue == null) return null;
    const normalized = String(rawValue).trim().toLowerCase();
    if (!normalized) return null;
    if (["1", "true", "yes", "on"].includes(normalized)) return true;
    if (["0", "false", "no", "off"].includes(normalized)) return false;
    return null;
  }

  function normalizeFileRefs(fileRefs) {
    if (!Array.isArray(fileRefs)) return [];
    const normalized = [];
    for (const candidate of fileRefs) {
      const refId = String(candidate?.ref_id || "").trim();
      const rawText = String(candidate?.raw_text || "");
      if (!refId || !rawText) continue;
      normalized.push({ refId, rawText });
    }
    return normalized;
  }

  function chooseNextFileRefMatch(text, cursor, fileRefs) {
    let bestMatch = null;
    for (let fileRefIndex = 0; fileRefIndex < fileRefs.length; fileRefIndex += 1) {
      const fileRef = fileRefs[fileRefIndex];
      const matchIndex = text.indexOf(fileRef.rawText, cursor);
      if (matchIndex < 0) continue;
      if (!bestMatch) {
        bestMatch = { ...fileRef, index: matchIndex, fileRefIndex };
        continue;
      }
      if (matchIndex < bestMatch.index) {
        bestMatch = { ...fileRef, index: matchIndex, fileRefIndex };
        continue;
      }
      if (matchIndex === bestMatch.index && fileRef.rawText.length > bestMatch.rawText.length) {
        bestMatch = { ...fileRef, index: matchIndex, fileRefIndex };
      }
    }
    return bestMatch;
  }

  function renderPlainTextWithFileRefs(text, fileRefs, escapeHtmlFn) {
    const refs = normalizeFileRefs(fileRefs);
    if (!refs.length) {
      return escapeHtmlFn(text).replace(/\n/g, "<br>");
    }

    let html = "";
    let cursor = 0;
    const remainingRefs = refs.slice();
    while (cursor < text.length) {
      const match = chooseNextFileRefMatch(text, cursor, remainingRefs);
      if (!match) {
        html += escapeHtmlFn(text.slice(cursor));
        break;
      }

      if (match.index > cursor) {
        html += escapeHtmlFn(text.slice(cursor, match.index));
      }

      const safeRefId = escapeHtmlFn(match.refId);
      const safeLabel = escapeHtmlFn(match.rawText);
      html += `<button type="button" class="message-file-ref" data-file-ref-id="${safeRefId}" aria-label="Open file preview for ${safeLabel}">${safeLabel}</button>`;
      cursor = match.index + match.rawText.length;
      remainingRefs.splice(match.fileRefIndex, 1);
    }

    return html.replace(/\n/g, "<br>");
  }

  function renderBody(container, rawText, {
    cleanDisplayTextFn,
    escapeHtmlFn,
    fileRefs = null,
  } = {}) {
    if (!container || typeof cleanDisplayTextFn !== "function" || typeof escapeHtmlFn !== "function") return;
    const text = cleanDisplayTextFn(rawText);
    const fenced = text.includes("```");
    if (!fenced) {
      container.innerHTML = renderPlainTextWithFileRefs(text, fileRefs, escapeHtmlFn);
      return;
    }

    const fragments = text.split("```");
    const parts = [];
    fragments.forEach((fragment, index) => {
      if (index % 2 === 0) {
        const safe = escapeHtmlFn(fragment).replace(/\n/g, "<br>");
        if (safe) parts.push(`<div>${safe}</div>`);
        return;
      }
      const trimmed = fragment.replace(/^\n/, "");
      const lines = trimmed.split("\n");
      const maybeLang = lines[0].trim();
      const code = lines.slice(1).join("\n").trimEnd() || trimmed;
      parts.push(`<pre class="code-block" data-lang="${escapeHtmlFn(maybeLang)}"><code>${escapeHtmlFn(code)}</code></pre>`);
    });
    container.innerHTML = parts.join("");
  }

  function renderToolTraceBody(container, message, {
    cleanDisplayTextFn,
    documentObject = (typeof document !== "undefined" ? document : null),
  } = {}) {
    if (!container || typeof cleanDisplayTextFn !== "function" || !documentObject) return;
    container.innerHTML = "";
    const text = cleanDisplayTextFn(message?.body || "");
    const lines = text ? text.split("\n").map((line) => line.trim()).filter(Boolean) : [];
    if (!lines.length && !message?.pending) {
      return;
    }

    const details = documentObject.createElement("details");
    details.className = "tool-trace";
    const collapsed = typeof message?.collapsed === "boolean" ? message.collapsed : !message?.pending;
    details.open = !collapsed;

    const summary = documentObject.createElement("summary");
    const lineCount = lines.length;
    const liveSuffix = message?.pending ? " · live" : "";
    summary.textContent = `Tool activity (${lineCount})${liveSuffix}`;
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

    details.addEventListener("toggle", () => {
      message.collapsed = !details.open;
    });

    container.appendChild(details);
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

  function shouldSkipMessageRender({ role, renderedBody, pending }) {
    return !renderedBody && !pending && role !== "tool";
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
    renderBodyFn(bodyNode, renderedBody, { fileRefs: message?.file_refs || null });
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
    if (shouldSkipMessageRenderFn({ role, renderedBody, pending: Boolean(message?.pending) })) {
      return false;
    }

    const variant = messageVariantForRoleFn(role);
    node.className = "message";
    applyMessageMetaFn(node, message, role, variant);
    renderMessageContentFn(node, message, renderedBody);
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

  function createController(deps) {
    const {
      windowObject,
      localStorageRef,
      renderTraceBadge,
      storageKey,
      getRenderTraceDebugEnabled,
      setRenderTraceDebugEnabledState,
      consoleRef = console,
    } = deps || {};

    function resolveRenderTraceDebugEnabled() {
      let queryFlag = null;
      try {
        const params = new URLSearchParams(windowObject.location.search || "");
        queryFlag = parseBooleanFlag(params.get("render_trace"));
        if (queryFlag !== null) {
          try {
            if (queryFlag) {
              localStorageRef.setItem(storageKey, "1");
            } else {
              localStorageRef.removeItem(storageKey);
            }
          } catch {
            // Best-effort persistence only.
          }
          return queryFlag;
        }
      } catch {
        // URL parsing unavailable; fall through to stored preference.
      }

      try {
        return Boolean(parseBooleanFlag(localStorageRef.getItem(storageKey)));
      } catch {
        return false;
      }
    }

    function syncRenderTraceBadge() {
      if (!renderTraceBadge) return;
      const renderTraceDebugEnabled = Boolean(getRenderTraceDebugEnabled());
      renderTraceBadge.hidden = false;
      renderTraceBadge.dataset.enabled = renderTraceDebugEnabled ? "true" : "false";
      renderTraceBadge.setAttribute("aria-pressed", renderTraceDebugEnabled ? "true" : "false");
      renderTraceBadge.textContent = `Render Trace ${renderTraceDebugEnabled ? "ON" : "OFF"}`;
      renderTraceBadge.title = renderTraceDebugEnabled
        ? "Tap to disable render trace logging"
        : "Tap to enable render trace logging";
    }

    function setRenderTraceDebugEnabled(nextEnabled, options = {}) {
      const { persist = true, updateUrl = true } = options;
      const renderTraceDebugEnabled = Boolean(nextEnabled);
      setRenderTraceDebugEnabledState(renderTraceDebugEnabled);

      if (persist) {
        try {
          if (renderTraceDebugEnabled) {
            localStorageRef.setItem(storageKey, "1");
          } else {
            localStorageRef.removeItem(storageKey);
          }
        } catch {
          // Best-effort persistence only.
        }
      }

      if (updateUrl) {
        try {
          const url = new URL(windowObject.location.href);
          if (renderTraceDebugEnabled) {
            url.searchParams.set("render_trace", "1");
          } else {
            url.searchParams.delete("render_trace");
          }
          windowObject.history.replaceState(windowObject.history.state, "", url.toString());
        } catch {
          // Ignore URL update failures.
        }
      }

      syncRenderTraceBadge();
    }

    function handleRenderTraceBadgeClick() {
      const nextEnabled = !Boolean(getRenderTraceDebugEnabled());
      setRenderTraceDebugEnabled(nextEnabled);
      if (nextEnabled) {
        consoleRef.info("[render-trace] debug-enabled", { enabled: true, source: "badge" });
        return;
      }
      consoleRef.info("[render-trace] debug-disabled", { enabled: false, source: "badge" });
    }

    function renderTraceLog(eventName, details = null) {
      if (!Boolean(getRenderTraceDebugEnabled())) return;
      if (details == null) {
        consoleRef.info(`[render-trace] ${eventName}`);
        return;
      }
      consoleRef.info(`[render-trace] ${eventName}`, details);
    }

    return {
      parseBooleanFlag,
      resolveRenderTraceDebugEnabled,
      syncRenderTraceBadge,
      setRenderTraceDebugEnabled,
      handleRenderTraceBadgeClick,
      renderTraceLog,
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
    createController,
  };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
  global.HermesMiniappRenderTrace = api;
})(typeof window !== "undefined" ? window : globalThis);
