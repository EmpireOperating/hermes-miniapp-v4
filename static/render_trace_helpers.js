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

  function buildFileRefButtonHtml(label, escapeHtmlFn, attrs = {}) {
    const safeLabel = escapeHtmlFn(label);
    const attrText = Object.entries(attrs)
      .filter(([, value]) => value != null && String(value).trim())
      .map(([key, value]) => ` ${key}="${escapeHtmlFn(String(value))}"`)
      .join("");
    return `<button type="button" class="message-file-ref"${attrText} aria-label="Open file preview for ${safeLabel}">${safeLabel}</button>`;
  }

  function splitTrailingPunctuation(rawText) {
    const value = String(rawText || "");
    const match = value.match(/^(.*?)([\]),.;!?"'`>]+)?$/);
    if (!match) {
      return { core: value, trailing: "" };
    }
    return {
      core: String(match[1] || ""),
      trailing: String(match[2] || ""),
    };
  }

  const SPECIAL_BARE_FILENAMES = new Set([
    'dockerfile',
    'makefile',
    'procfile',
    'containerfile',
    'jenkinsfile',
    'vagrantfile',
    'brewfile',
    'gemfile',
    'rakefile',
    'justfile',
    'tiltfile',
    'readme',
    'license',
  ]);

  function isSupportedBareFilename(value) {
    const candidate = String(value || '').trim();
    if (!candidate) return false;
    if (/^(?:[A-Za-z0-9][A-Za-z0-9._-]*\.(?:py|js|mjs|cjs|ts|tsx|jsx|json|md|yaml|yml|toml|txt|sh|go|rs|java|c|cc|cpp|h|hpp|css|scss|html|htm|sql|ini|cfg|conf|env|lock|csv|tsv|log)|\.[A-Za-z0-9][A-Za-z0-9._-]*)$/i.test(candidate)) {
      return true;
    }
    const lowered = candidate.toLowerCase();
    if (SPECIAL_BARE_FILENAMES.has(lowered)) return true;
    const dotIndex = lowered.indexOf('.');
    return dotIndex > 0 && SPECIAL_BARE_FILENAMES.has(lowered.slice(0, dotIndex));
  }

  function isSupportedInlinePath(pathText, { hasLineHint = false } = {}) {
    const candidate = String(pathText || "").trim();
    if (!candidate) return false;
    if (candidate.includes("://")) return false;
    if (candidate.startsWith("//")) return false;
    const basenameSupported = (value) => isSupportedBareFilename(String(value || '').split('/').pop());
    if (candidate.startsWith("/")) return Boolean(hasLineHint || basenameSupported(candidate));
    if (candidate.startsWith("~/")) return candidate.length > 2 && Boolean(hasLineHint || basenameSupported(candidate));
    if (candidate.startsWith("./")) return candidate.length > 2 && Boolean(hasLineHint || basenameSupported(candidate));
    if (candidate.startsWith("../")) return candidate.length > 3 && Boolean(hasLineHint || basenameSupported(candidate));
    if (/^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)+$/.test(candidate)) return Boolean(hasLineHint || basenameSupported(candidate));
    return isSupportedBareFilename(candidate);
  }

  function parseInlinePathRef(rawText) {
    const trimmed = String(rawText || "").trim();
    if (!trimmed) return null;

    const { core, trailing } = splitTrailingPunctuation(trimmed);
    let pathPart = core;
    let lineStart = 0;
    let lineEnd = 0;

    const hashMatch = pathPart.match(/^(.*)#L?(\d+)(?:-L?(\d+))?$/i);
    if (hashMatch) {
      pathPart = String(hashMatch[1] || "");
      lineStart = Number(hashMatch[2] || 0);
      lineEnd = Number(hashMatch[3] || 0);
    } else {
      const lineSpecMatch = pathPart.match(/^(.+?):L?(\d+)(?::\d+)?(?:-(?:L)?(\d+)(?::\d+)?)?$/i);
      if (lineSpecMatch) {
        pathPart = String(lineSpecMatch[1] || "");
        lineStart = Number(lineSpecMatch[2] || 0);
        lineEnd = Number(lineSpecMatch[3] || 0);
      }
    }

    let path = String(pathPart || "").trim();
    if (path.toLowerCase().startsWith("file://")) {
      path = path.slice(7);
    }
    const hasLineHint = lineStart > 0 || lineEnd > 0;
    if (!isSupportedInlinePath(path, { hasLineHint })) return null;

    const normalizedLineStart = Number.isFinite(lineStart) && lineStart > 0 ? Math.floor(lineStart) : 0;
    const normalizedLineEnd = Number.isFinite(lineEnd) && lineEnd > 0 ? Math.floor(lineEnd) : 0;
    return {
      path,
      lineStart: normalizedLineStart,
      lineEnd: normalizedLineEnd,
      trailing,
    };
  }

  function isLikelyUrlPathMatch(text, startIndex) {
    const index = Number(startIndex || 0);
    if (!Number.isFinite(index) || index <= 0) return false;
    let tokenStart = index;
    while (tokenStart > 0 && !/\s/.test(text[tokenStart - 1])) {
      tokenStart -= 1;
    }
    const tokenPrefix = text.slice(tokenStart, index);
    if (tokenPrefix.includes("://")) return true;

    // Handle scheme split where match begins at "//..." and prefix is only "https:".
    if (index > 0 && text[index - 1] === ":" && text[index] === "/" && text[index + 1] === "/") {
      return /^[a-z][a-z0-9+.-]*$/i.test(tokenPrefix);
    }
    return false;
  }

  function normalizeAllowedRoots(allowedRoots) {
    if (!Array.isArray(allowedRoots)) return [];
    const roots = [];
    for (const root of allowedRoots) {
      const value = String(root || "").trim();
      if (!value || !value.startsWith("/")) continue;
      roots.push(value.endsWith("/") && value.length > 1 ? value.slice(0, -1) : value);
    }
    return roots;
  }

  function isPathAllowedByRoots(pathText, allowedRoots) {
    const candidate = String(pathText || "").trim();
    if (!candidate || !candidate.startsWith("/")) return false;
    const normalizedRoots = normalizeAllowedRoots(allowedRoots);
    if (!normalizedRoots.length) return false;
    return normalizedRoots.some((root) => candidate === root || candidate.startsWith(`${root}/`));
  }

  function renderPlainTextWithInlinePathFallback(text, escapeHtmlFn, { allowedRoots = [] } = {}) {
    const pattern = /(?:(?:file:\/\/)?\/(?:[^\s`<>"'(){}\[\],;]+)|(?:~\/|\.{1,2}\/|[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)+))(?::L?\d+(?::\d+)?(?:-(?:L)?\d+(?::\d+)?)?)?(?:#L?\d+(?:-L?\d+)?)?[\]),.;!?"'`>]*/gi;
    let cursor = 0;
    let html = "";
    let match = pattern.exec(text);
    while (match) {
      const raw = String(match[0] || "");
      const start = Number(match.index || 0);
      if (start > cursor) {
        html += escapeHtmlFn(text.slice(cursor, start));
      }
      if (isLikelyUrlPathMatch(text, start)) {
        html += escapeHtmlFn(raw);
        cursor = start + raw.length;
        match = pattern.exec(text);
        continue;
      }
      const parsed = parseInlinePathRef(raw);
      const canPreview = parsed && isPathAllowedByRoots(parsed.path, allowedRoots);
      if (!parsed || !canPreview || (!parsed.path.includes(".") && parsed.lineStart <= 0 && parsed.lineEnd <= 0)) {
        html += escapeHtmlFn(raw);
      } else {
        const label = raw.endsWith(parsed.trailing || "")
          ? raw.slice(0, raw.length - String(parsed.trailing || "").length)
          : raw;
        html += buildFileRefButtonHtml(label, escapeHtmlFn, {
          "data-file-path": parsed.path,
          "data-file-line-start": parsed.lineStart > 0 ? String(parsed.lineStart) : "",
          "data-file-line-end": parsed.lineEnd > 0 ? String(parsed.lineEnd) : "",
        });
        if (parsed.trailing) {
          html += escapeHtmlFn(parsed.trailing);
        }
      }
      cursor = start + raw.length;
      match = pattern.exec(text);
    }
    if (cursor < text.length) {
      html += escapeHtmlFn(text.slice(cursor));
    }
    return html.replace(/\n/g, "<br>");
  }

  function renderPlainTextWithFileRefs(text, fileRefs, escapeHtmlFn, { allowedRoots = [] } = {}) {
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

      const parsed = parseInlinePathRef(match.rawText);
      const trailing = String(parsed?.trailing || "");
      const label = trailing && match.rawText.endsWith(trailing)
        ? match.rawText.slice(0, match.rawText.length - trailing.length)
        : match.rawText;
      html += buildFileRefButtonHtml(label, escapeHtmlFn, {
        "data-file-ref-id": match.refId,
      });
      if (trailing) {
        html += escapeHtmlFn(trailing);
      }
      cursor = match.index + match.rawText.length;
      remainingRefs.splice(match.fileRefIndex, 1);
    }

    return html.replace(/\n/g, "<br>");
  }

  function renderBody(container, rawText, {
    cleanDisplayTextFn,
    escapeHtmlFn,
    fileRefs = null,
    allowedRoots = [],
  } = {}) {
    if (!container || typeof cleanDisplayTextFn !== "function" || typeof escapeHtmlFn !== "function") return;
    const text = cleanDisplayTextFn(rawText);
    const fenced = text.includes("```");
    if (!fenced) {
      container.innerHTML = renderPlainTextWithFileRefs(text, fileRefs, escapeHtmlFn, { allowedRoots });
      return;
    }

    const fragments = text.split("```");
    const parts = [];
    fragments.forEach((fragment, index) => {
      if (index % 2 === 0) {
        const rendered = renderPlainTextWithFileRefs(fragment, fileRefs, escapeHtmlFn, { allowedRoots });
        if (rendered) parts.push(`<div>${rendered}</div>`);
        return;
      }
      const trimmed = fragment.replace(/^\n/, "");
      const lines = trimmed.split("\n");
      const maybeLang = lines[0].trim();
      const code = lines.slice(1).join("\n").trimEnd() || trimmed;
      const renderedCode = renderPlainTextWithFileRefs(code, fileRefs, escapeHtmlFn, { allowedRoots });
      parts.push(`<pre class="code-block" data-lang="${escapeHtmlFn(maybeLang)}"><code>${renderedCode}</code></pre>`);
    });
    container.innerHTML = parts.join("");
  }

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

  function createHistoryRenderController(deps) {
    const {
      messagesEl,
      jumpLatestButton,
      jumpLastStartButton,
      histories,
      virtualizationRanges,
      virtualMetrics,
      renderedHistoryLength,
      renderedHistoryVirtualized,
      unseenStreamChats,
      chatScrollTop,
      chatStickToBottom,
      historyCountEl,
      virtualizeThreshold = 220,
      estimatedMessageHeight = 108,
      virtualOverscan = 18,
      getActiveChatId,
      getRenderedChatId,
      setRenderedChatId,
      refreshTabNode,
      clearSelectionQuoteStateFn,
      syncLiveToolStreamForChatFn,
      appendMessagesFn,
      shouldUseAppendOnlyRenderFn,
      renderTraceLogFn,
      createSpacerElementFn,
      createFragmentFn,
    } = deps || {};

    function isNearBottom(element, threshold = 24) {
      if (!element) return true;
      return (element.scrollHeight - element.clientHeight - element.scrollTop) <= threshold;
    }

    function shouldVirtualizeHistory(historyLength) {
      return Number(historyLength) > Number(virtualizeThreshold);
    }

    function getEstimatedMessageHeight(chatId) {
      const metric = virtualMetrics.get(Number(chatId));
      return Math.max(56, Number(metric?.avgHeight) || Number(estimatedMessageHeight));
    }

    function updateVirtualMetrics(chatId) {
      const nodes = messagesEl?.querySelectorAll?.('.message') || [];
      if (!nodes.length) return;

      let totalHeight = 0;
      nodes.forEach((node) => {
        totalHeight += Number(node?.offsetHeight) || 0;
      });
      if (totalHeight <= 0) return;

      const sampleAvg = totalHeight / nodes.length;
      const prior = getEstimatedMessageHeight(chatId);
      const blended = Math.round((prior * 0.68) + (sampleAvg * 0.32));
      virtualMetrics.set(Number(chatId), { avgHeight: blended });
    }

    function updateJumpLatestVisibility() {
      const key = Number(getActiveChatId?.());
      const hasActiveChat = key > 0;

      const showJumpLatest = hasActiveChat && !isNearBottom(messagesEl, 64);
      if (jumpLatestButton) {
        jumpLatestButton.hidden = !showJumpLatest;
      }

      if (jumpLastStartButton) {
        const renderedMessages = messagesEl?.querySelectorAll?.('.message') || [];
        const lastRenderedMessage = renderedMessages[renderedMessages.length - 1];
        const showJumpLastStart = Boolean(
          hasActiveChat
          && lastRenderedMessage
          && Number(lastRenderedMessage.offsetTop) < (messagesEl.scrollTop - 6)
        );
        jumpLastStartButton.hidden = !showJumpLastStart;
      }
    }

    function markStreamUpdate(chatId) {
      const key = Number(chatId);
      if (!key || key !== Number(getActiveChatId?.())) return;
      if (isNearBottom(messagesEl, 40)) return;
      unseenStreamChats.add(key);
      refreshTabNode?.(key);
      updateJumpLatestVisibility();
    }

    function computeVirtualRange({ total, scrollTop, viewportHeight, forceBottom, estimatedHeight }) {
      const rowHeight = Math.max(56, Number(estimatedHeight) || Number(estimatedMessageHeight));
      const estimatedVisible = Math.max(1, Math.ceil(Number(viewportHeight) / rowHeight));
      const windowSize = estimatedVisible + (Number(virtualOverscan) * 2);

      if (forceBottom) {
        const end = Number(total);
        const start = Math.max(0, end - windowSize);
        return { start, end };
      }

      const approxStart = Math.max(0, Math.floor(Number(scrollTop) / rowHeight) - Number(virtualOverscan));
      const start = Math.min(approxStart, Math.max(0, Number(total) - windowSize));
      const end = Math.min(Number(total), start + windowSize);
      return { start, end };
    }

    function renderVirtualizedHistory(targetChatId, history, {
      prevScrollTop,
      preserveViewport,
      forceBottom,
      shouldStick,
      estimatedHeight,
    }) {
      const viewportHeight = Math.max(messagesEl.clientHeight || 0, 320);
      const range = computeVirtualRange({
        total: history.length,
        scrollTop: forceBottom ? Number.MAX_SAFE_INTEGER : prevScrollTop,
        viewportHeight,
        forceBottom: forceBottom || (!preserveViewport && shouldStick),
        estimatedHeight,
      });

      const renderStart = range.start;
      const renderEnd = range.end;

      const topSpacer = typeof createSpacerElementFn === 'function'
        ? createSpacerElementFn()
        : document.createElement('div');
      topSpacer.className = 'messages__spacer';
      topSpacer.style.height = `${renderStart * estimatedHeight}px`;

      const bottomSpacer = typeof createSpacerElementFn === 'function'
        ? createSpacerElementFn()
        : document.createElement('div');
      bottomSpacer.className = 'messages__spacer';
      bottomSpacer.style.height = `${Math.max(0, history.length - renderEnd) * estimatedHeight}px`;

      messagesEl.appendChild(topSpacer);
      const fragment = typeof createFragmentFn === 'function'
        ? createFragmentFn()
        : document.createDocumentFragment();
      appendMessagesFn(fragment, history.slice(renderStart, renderEnd));
      messagesEl.appendChild(fragment);
      messagesEl.appendChild(bottomSpacer);

      virtualizationRanges.set(targetChatId, {
        start: renderStart,
        end: renderEnd,
        total: history.length,
        estimatedHeight,
      });
    }

    function renderFullHistory(targetChatId, history) {
      const fragment = typeof createFragmentFn === 'function'
        ? createFragmentFn()
        : document.createDocumentFragment();
      appendMessagesFn(fragment, history);
      messagesEl.appendChild(fragment);
      virtualizationRanges.delete(targetChatId);
    }

    function tryAppendOnlyRender(targetChatId, history, {
      preserveViewport,
      forceBottom,
      isSameRenderedChat,
      shouldVirtualize,
      prevScrollTop,
      wasNearBottom,
    }) {
      if (forceBottom || !preserveViewport || !isSameRenderedChat || shouldVirtualize) {
        return false;
      }

      if (renderedHistoryVirtualized.get(targetChatId)) {
        return false;
      }

      const previouslyRenderedLength = Number(renderedHistoryLength.get(targetChatId));
      if (!Number.isFinite(previouslyRenderedLength) || previouslyRenderedLength < 0) {
        return false;
      }

      if (history.length <= previouslyRenderedLength) {
        return false;
      }

      const renderedMessageKeys = Array.from(messagesEl.querySelectorAll('.message'))
        .map((node) => String(node?.dataset?.messageKey || ''));

      if (!shouldUseAppendOnlyRenderFn({
        history,
        previouslyRenderedLength,
        renderedMessageKeys,
      })) {
        renderTraceLogFn?.('append-only-skip-history-misaligned', {
          chatId: Number(targetChatId),
          previouslyRenderedLength,
          renderedMessageNodes: renderedMessageKeys.length,
          historyLength: history.length,
        });
        return false;
      }

      const appendedSlice = history.slice(previouslyRenderedLength);
      if (!appendedSlice.length) {
        return false;
      }

      const fragment = typeof createFragmentFn === 'function'
        ? createFragmentFn()
        : document.createDocumentFragment();
      appendMessagesFn(fragment, appendedSlice);
      messagesEl.appendChild(fragment);

      const shouldStickBottom = Boolean(chatStickToBottom.get(targetChatId) || wasNearBottom);
      if (shouldStickBottom) {
        messagesEl.scrollTop = messagesEl.scrollHeight;
      } else {
        messagesEl.scrollTop = Math.max(0, prevScrollTop);
      }

      renderTraceLogFn?.('append-only-render', {
        chatId: Number(targetChatId),
        appendedCount: appendedSlice.length,
        shouldStickBottom,
        preservedScrollTop: Math.max(0, prevScrollTop),
      });

      return true;
    }

    function restoreMessageViewport(targetChatId, {
      forceBottom,
      preserveViewport,
      isSameRenderedChat,
      shouldStick,
      prevScrollTop,
    }) {
      if (forceBottom) {
        messagesEl.scrollTop = messagesEl.scrollHeight;
      } else if (preserveViewport && isSameRenderedChat && !shouldStick) {
        messagesEl.scrollTop = Math.max(0, prevScrollTop);
      } else if (chatScrollTop.has(targetChatId) && !shouldStick) {
        messagesEl.scrollTop = Math.max(0, chatScrollTop.get(targetChatId));
      } else {
        messagesEl.scrollTop = messagesEl.scrollHeight;
      }
    }

    function finalizeRenderMessages(targetChatId, history, { shouldVirtualize, forceBottom }) {
      setRenderedChatId?.(targetChatId);
      renderedHistoryLength.set(targetChatId, history.length);
      renderedHistoryVirtualized.set(targetChatId, Boolean(shouldVirtualize));
      if (shouldVirtualize) {
        updateVirtualMetrics(targetChatId);
      }

      const atBottom = isNearBottom(messagesEl, 40);
      if (forceBottom || atBottom) {
        unseenStreamChats.delete(targetChatId);
        refreshTabNode?.(targetChatId);
      }
      chatScrollTop.set(targetChatId, messagesEl.scrollTop);
      chatStickToBottom.set(targetChatId, atBottom);
      updateJumpLatestVisibility();
      if (historyCountEl) {
        historyCountEl.textContent = String(history.filter((item) => item.role !== 'system').length);
      }
    }

    function renderMessages(chatId, { preserveViewport = false, forceBottom = false } = {}) {
      const targetChatId = Number(chatId);
      const isSameRenderedChat = Number(getRenderedChatId?.()) === targetChatId;
      const prevScrollTop = Number(messagesEl.scrollTop || 0);
      const wasNearBottom = isNearBottom(messagesEl, 40);
      const shouldStick = Boolean(forceBottom || (preserveViewport && isSameRenderedChat && wasNearBottom));

      const history = histories.get(targetChatId) || [];
      const shouldVirtualize = shouldVirtualizeHistory(history.length);
      const estimatedHeight = getEstimatedMessageHeight(targetChatId);

      if (tryAppendOnlyRender(targetChatId, history, {
        preserveViewport,
        forceBottom,
        isSameRenderedChat,
        shouldVirtualize,
        prevScrollTop,
        wasNearBottom,
      })) {
        finalizeRenderMessages(targetChatId, history, { shouldVirtualize, forceBottom });
        if (Number(getActiveChatId?.()) === targetChatId) {
          syncLiveToolStreamForChatFn?.(targetChatId);
        }
        return;
      }

      renderTraceLogFn?.('full-render', {
        chatId: Number(targetChatId),
        reason: 'append-only-unavailable',
        preserveViewport: Boolean(preserveViewport),
        forceBottom: Boolean(forceBottom),
        shouldVirtualize,
        historyLength: history.length,
      });

      messagesEl.innerHTML = '';
      clearSelectionQuoteStateFn?.();

      if (shouldVirtualize) {
        renderVirtualizedHistory(targetChatId, history, {
          prevScrollTop,
          preserveViewport,
          forceBottom,
          shouldStick,
          estimatedHeight,
        });
      } else {
        renderFullHistory(targetChatId, history);
      }

      restoreMessageViewport(targetChatId, {
        forceBottom,
        preserveViewport,
        isSameRenderedChat,
        shouldStick,
        prevScrollTop,
      });

      finalizeRenderMessages(targetChatId, history, { shouldVirtualize, forceBottom });
      if (Number(getActiveChatId?.()) === targetChatId) {
        syncLiveToolStreamForChatFn?.(targetChatId);
      }
    }

    return {
      isNearBottom,
      shouldVirtualizeHistory,
      getEstimatedMessageHeight,
      updateVirtualMetrics,
      updateJumpLatestVisibility,
      markStreamUpdate,
      computeVirtualRange,
      renderVirtualizedHistory,
      renderFullHistory,
      tryAppendOnlyRender,
      restoreMessageViewport,
      finalizeRenderMessages,
      renderMessages,
    };
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
    createHistoryRenderController,
    createController,
  };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
  global.HermesMiniappRenderTrace = api;
})(typeof window !== "undefined" ? window : globalThis);
