const tg = window.Telegram?.WebApp;
const devConfig = window.__HERMES_DEV__ || {
  enabled: false,
  reloadStateUrl: "/dev/reload-state",
  intervalMs: 1200,
  version: "",
  requestDebug: false,
};
const streamDebugEnabled = Boolean(devConfig.requestDebug);
const sharedUtils = window.HermesMiniappSharedUtils;
if (!sharedUtils) {
  throw new Error("HermesMiniappSharedUtils is required before app.js");
}
const chatUiHelpers = window.HermesMiniappChatUI;
if (!chatUiHelpers) {
  throw new Error("HermesMiniappChatUI is required before app.js");
}
const { parseSseEvent, formatMessageTime, nowStamp, formatLatency, escapeHtml, cleanDisplayText, copyTextToClipboard } = sharedUtils;
const authStatus = document.getElementById("auth-status");
const streamStatus = document.getElementById("stream-status");
const operatorName = document.getElementById("operator-name");
const activeChatName = document.getElementById("active-chat-name");
const historyCount = document.getElementById("history-count");
const skinName = document.getElementById("skin-name");
const panelHint = document.getElementById("panel-hint");
const panelTitle = document.getElementById("panel-title");
const latencyChip = document.getElementById("latency-chip");
const sourceChip = null;
const streamChip = null;
const jumpLatestButton = document.getElementById("jump-latest");
const jumpLastStartButton = document.getElementById("jump-last-start");
const body = document.body;
const SKIN_STORAGE_KEY = "hermes_skin";
const ALLOWED_SKINS = new Set(["terminal", "oracle", "obsidian"]);
const bootSkin = document.documentElement?.getAttribute("data-skin") || window.__HERMES_SKIN_BOOT__ || "terminal";
const skinSyncChannel = (() => {
  try {
    if (typeof BroadcastChannel !== "function") return null;
    return new BroadcastChannel("hermes-miniapp-skin");
  } catch {
    return null;
  }
})();
if (body && !body.dataset.skin) {
  body.dataset.skin = bootSkin;
}
const messagesEl = document.getElementById("messages");
const toolStreamEl = document.getElementById("tool-stream");
const toolStreamLinesEl = document.getElementById("tool-stream-lines");
const tabsEl = document.getElementById("chat-tabs");
const form = document.getElementById("chat-form");
const promptEl = document.getElementById("prompt");
const sendButton = document.getElementById("send-button");
const removeChatButton = document.getElementById("remove-chat");
const newChatButton = document.getElementById("new-chat");
const renameChatButton = document.getElementById("rename-chat");
const pinChatButton = document.getElementById("pin-chat");
const pinnedChatsWrap = document.getElementById("pinned-chats-wrap");
const pinnedChatsEl = document.getElementById("pinned-chats");
const fullscreenAppTopButton = document.getElementById("fullscreen-app-top");
const closeAppTopButton = document.getElementById("close-app-top");
const settingsButton = document.getElementById("settings-button");
const renderTraceBadge = document.getElementById("render-trace-badge");
const settingsModal = document.getElementById("settings-modal");
const settingsClose = document.getElementById("settings-close");
const template = document.getElementById("message-template");
const tabTemplate = document.getElementById("chat-tab-template");
const skinButtons = document.querySelectorAll(".skin-toggle");
const chatTitleModal = document.getElementById("chat-title-modal");
const chatTitleForm = document.getElementById("chat-title-form");
const chatTitleHint = document.getElementById("chat-title-modal-hint");
const chatTitleInput = document.getElementById("chat-title-input");
const chatTitleCancel = document.getElementById("chat-title-cancel");
const chatTitleConfirm = document.getElementById("chat-title-confirm");
const selectionQuoteButton = document.getElementById("selection-quote-button");

let initData = "";
let isAuthenticated = false;
let currentSkin = bootSkin;
let activeChatId = null;
let operatorDisplayName = "Operator";
const chats = new Map();
const pinnedChats = new Map();
const histories = new Map();
const pendingChats = new Set();
const streamAbortControllers = new Map();
const latencyByChat = new Map();
const runtimeHelpers = window.HermesMiniappRuntime;
if (!runtimeHelpers) {
  throw new Error("HermesMiniappRuntime is required before app.js");
}

const prefetchingHistories = new Set();
const tabNodes = new Map();
const chatScrollTop = new Map();
const chatStickToBottom = new Map();
const virtualizationRanges = new Map();
const virtualMetrics = new Map();
const renderedHistoryLength = new Map();
const renderedHistoryVirtualized = new Map();
const unseenStreamChats = new Set();
const markReadInFlight = new Set();
const VIRTUALIZE_THRESHOLD = 220;
const ESTIMATED_MESSAGE_HEIGHT = 108;
const VIRTUAL_OVERSCAN = 18;
const SCROLL_STICKY_THRESHOLD_PX = 80;
let renderedChatId = null;
let lastOpenChatRequestId = 0;
let activeRenderScheduled = false;
let activeRenderChatId = null;
const streamPhaseByChat = new Map();
const STREAM_PHASES = Object.freeze({
  IDLE: "idle",
  PENDING_TOOL: "pending_tool",
  STREAMING_TOOL: "streaming_tool",
  STREAMING_ASSISTANT: "streaming_assistant",
  FINALIZED: "finalized",
  ERROR: "error",
});
// Back-compat aliases kept for tests and grep-based checks.
let selectionQuoteSyncTimer = null;
let selectionQuoteClearTimer = null;
let selectionQuoteSettleTimer = null;

const selectionQuoteState = {
  text: "",
  placementKey: "",
  timers: {
    sync: null,
    clear: null,
    settle: null,
  },
  getText() {
    return this.text;
  },
  setText(text) {
    this.text = String(text || "");
  },
  clearPlacement() {
    this.placementKey = "";
  },
  setPlacement(placementKey) {
    this.placementKey = String(placementKey || "");
  },
  reset() {
    this.setText("");
    this.clearPlacement();
  },
  cancelTimer(name) {
    const timerId = this.timers[name];
    if (!timerId) return;
    window.clearTimeout(timerId);
    this.timers[name] = null;
  },
  scheduleTimer(name, delayMs, callback) {
    this.cancelTimer(name);
    const safeDelay = Math.max(0, Number(delayMs) || 0);
    this.timers[name] = window.setTimeout(() => {
      this.timers[name] = null;
      callback();
    }, safeDelay);
  },
};
const messageCopyState = {
  minHandledIntervalMs: 350,
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
    window.clearTimeout(timerId);
    this.resetTimerByButton.delete(button);
  },

  scheduleReset(button, delayMs, callback) {
    this.cancelReset(button);
    const safeDelay = Math.max(0, Number(delayMs) || 0);
    const timerId = window.setTimeout(() => {
      this.resetTimerByButton.delete(button);
      callback();
    }, safeDelay);
    this.resetTimerByButton.set(button, timerId);
  },
};
const mobileQuoteMode = isCoarsePointer();
const draftByChat = new Map();
const DRAFT_STORAGE_KEY = "hermes_miniapp_chat_drafts_v1";
const RENDER_TRACE_STORAGE_KEY = "hermes_render_trace_debug";

function parseBooleanFlag(rawValue) {
  if (rawValue == null) return null;
  const normalized = String(rawValue).trim().toLowerCase();
  if (!normalized) return null;
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return null;
}

function resolveRenderTraceDebugEnabled() {
  let queryFlag = null;
  try {
    const params = new URLSearchParams(window.location.search || "");
    queryFlag = parseBooleanFlag(params.get("render_trace"));
    if (queryFlag !== null) {
      try {
        if (queryFlag) {
          localStorage.setItem(RENDER_TRACE_STORAGE_KEY, "1");
        } else {
          localStorage.removeItem(RENDER_TRACE_STORAGE_KEY);
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
    return Boolean(parseBooleanFlag(localStorage.getItem(RENDER_TRACE_STORAGE_KEY)));
  } catch {
    return false;
  }
}

let renderTraceDebugEnabled = resolveRenderTraceDebugEnabled();

function syncRenderTraceBadge() {
  if (!renderTraceBadge) return;
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
  renderTraceDebugEnabled = Boolean(nextEnabled);

  if (persist) {
    try {
      if (renderTraceDebugEnabled) {
        localStorage.setItem(RENDER_TRACE_STORAGE_KEY, "1");
      } else {
        localStorage.removeItem(RENDER_TRACE_STORAGE_KEY);
      }
    } catch {
      // Best-effort persistence only.
    }
  }

  if (updateUrl) {
    try {
      const url = new URL(window.location.href);
      if (renderTraceDebugEnabled) {
        url.searchParams.set("render_trace", "1");
      } else {
        url.searchParams.delete("render_trace");
      }
      window.history.replaceState(window.history.state, "", url.toString());
    } catch {
      // Ignore URL update failures.
    }
  }

  syncRenderTraceBadge();
}

function handleRenderTraceBadgeClick() {
  setRenderTraceDebugEnabled(!renderTraceDebugEnabled);
  if (renderTraceDebugEnabled) {
    console.info("[render-trace] debug-enabled", { enabled: true, source: "badge" });
    return;
  }
  console.info("[render-trace] debug-disabled", { enabled: false, source: "badge" });
}

function renderTraceLog(eventName, details = null) {
  if (!renderTraceDebugEnabled) return;
  if (details == null) {
    console.info(`[render-trace] ${eventName}`);
    return;
  }
  console.info(`[render-trace] ${eventName}`, details);
}

function streamDebugLog(eventName, details = null) {
  if (!streamDebugEnabled) return;
  if (details == null) {
    console.info(`[stream-debug] ${eventName}`);
    return;
  }
  console.info(`[stream-debug] ${eventName}`, details);
}

let viewportMutationSeq = 0;

function runAfterUiMutation(callback) {
  let settled = false;
  let timeoutId = null;
  let rafId = null;

  const finalize = () => {
    if (settled) return;
    settled = true;
    if (timeoutId != null) {
      window.clearTimeout(timeoutId);
    }
    if (rafId != null && typeof cancelAnimationFrame === "function") {
      cancelAnimationFrame(rafId);
    }
    callback();
  };

  if (typeof requestAnimationFrame === "function") {
    rafId = requestAnimationFrame(finalize);
  }

  timeoutId = window.setTimeout(finalize, document.visibilityState === "visible" ? 34 : 0);
}

function preserveViewportDuringUiMutation(mutator) {
  const key = Number(activeChatId);
  const hasActiveChat = Number.isInteger(key) && key > 0;
  const previousScrollTop = messagesEl ? messagesEl.scrollTop : null;
  const previousWindowScrollY = Number(window.scrollY || 0);
  const wasNearBottom = Boolean(messagesEl && isNearBottom(messagesEl, 40));
  const mutationSeq = ++viewportMutationSeq;

  mutator();

  if (!hasActiveChat || !messagesEl || previousScrollTop == null) {
    return;
  }

  runAfterUiMutation(() => {
    if (mutationSeq !== viewportMutationSeq) return;
    if (Number(activeChatId) !== key) return;

    const shouldStickBottom = Boolean(chatStickToBottom.get(key));
    if (shouldStickBottom || wasNearBottom) {
      messagesEl.scrollTop = messagesEl.scrollHeight;
      if (mobileQuoteMode) {
        // Mobile webviews can settle layout one more tick later; keep bottom lock stable.
        window.setTimeout(() => {
          if (mutationSeq !== viewportMutationSeq) return;
          if (Number(activeChatId) !== key) return;
          messagesEl.scrollTop = messagesEl.scrollHeight;
          chatScrollTop.set(key, messagesEl.scrollTop);
          chatStickToBottom.set(key, true);
          updateJumpLatestVisibility();
        }, 0);
      }
      chatScrollTop.set(key, messagesEl.scrollTop);
      chatStickToBottom.set(key, true);
    } else {
      messagesEl.scrollTop = Math.max(0, Number(previousScrollTop) || 0);
      chatScrollTop.set(key, messagesEl.scrollTop);
      chatStickToBottom.set(key, false);
    }
    updateJumpLatestVisibility();

    if (!mobileQuoteMode && Math.abs((window.scrollY || 0) - previousWindowScrollY) > 1) {
      window.scrollTo({ top: previousWindowScrollY, left: 0, behavior: "auto" });
    }
  });
}

function setChatLatency(chatId, text) {
  const result = runtimeHelpers.nextLatencyState({
    latencyByChat,
    targetChatId: chatId,
    text,
    activeChatId,
  });
  streamDebugLog("latency-set", {
    chatId: Number(chatId),
    activeChatId: Number(activeChatId),
    text: String(text || "").trim() || "--",
    hasChipText: Boolean(result.chipText),
  });
  if (result.chipText) {
    preserveViewportDuringUiMutation(() => {
      setActivityChip(latencyChip, result.chipText);
    });
    return;
  }

  // Defensive fallback: when active chat bookkeeping lags behind a send/resume tick,
  // still keep latency chip populated for the current stream chat.
  const targetKey = Number(chatId);
  if (targetKey && Number(activeChatId) === targetKey) {
    preserveViewportDuringUiMutation(() => {
      setActivityChip(latencyChip, `latency: ${String(text || "--").trim() || "--"}`);
    });
    streamDebugLog("latency-fallback", {
      chatId: targetKey,
      activeChatId: Number(activeChatId),
    });
  }
}

function syncActiveLatencyChip() {
  const key = Number(activeChatId);
  if (!key) {
    setActivityChip(latencyChip, "latency: --");
    return;
  }
  const value = latencyByChat.get(key) || "--";
  setActivityChip(latencyChip, `latency: ${value}`);
}

function revealShell() {
  document.documentElement?.setAttribute("data-shell-ready", "1");
}

function chatLabel(chatId) {
  const chat = chats.get(Number(chatId));
  return chat?.title || "Chat";
}

function compactChatLabel(chatId, maxLength = 24) {
  const title = chatLabel(chatId);
  if (title.length <= maxLength) return title;
  return `${title.slice(0, maxLength - 1)}…`;
}

function setActivityChip(chip, text) {
  if (!chip) return;
  const compact = String(text || "").replace(/\s+/g, " ").trim();
  chip.textContent = compact;
  chip.title = compact;
}

function setStreamStatus(text) {
  if (!streamStatus) return;
  streamStatus.textContent = String(text || "");
}

function authPayload(extra = {}) {
  return { init_data: initData, ...extra };
}

async function safeReadJson(response) {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function syncClosingConfirmation() {
  if (!tg?.isVersionAtLeast?.("6.2")) return;
  try {
    if (pendingChats.size > 0) {
      tg.enableClosingConfirmation?.();
      return;
    }
    tg.disableClosingConfirmation?.();
  } catch {
    // Best effort only; some Telegram clients expose partial WebApp APIs.
  }
}

function syncTelegramChromeForSkin(skin) {
  if (!tg) return;
  const palette = {
    terminal: { header: "#0f1218", background: "#0b0d12" },
    oracle: { header: "#140f1b", background: "#09070c" },
    obsidian: { header: "#0d1216", background: "#080d10" },
  };
  const picked = palette[skin] || palette.terminal;
  try {
    tg.setHeaderColor?.(picked.header);
    tg.setBackgroundColor?.(picked.background);
  } catch {
    // Best effort only; desktop clients vary
  }
}

function shouldApplyDevReload() {
  return document.visibilityState === "visible" && pendingChats.size === 0;
}

function startDevAutoRefresh() {
  if (!devConfig.enabled || !devConfig.reloadStateUrl) return;

  let currentVersion = String(devConfig.version || "");
  let reloadQueued = false;

  const maybeReload = () => {
    if (!reloadQueued || !shouldApplyDevReload()) return;
    window.location.reload();
  };

  const poll = async () => {
    try {
      const response = await fetch(`${devConfig.reloadStateUrl}?t=${Date.now()}`, {
        cache: "no-store",
        headers: { "Cache-Control": "no-store" },
      });
      if (!response.ok) return;
      const data = await response.json();
      const nextVersion = String(data.version || "");
      if (!nextVersion) return;
      if (!currentVersion) {
        currentVersion = nextVersion;
        return;
      }
      if (nextVersion !== currentVersion) {
        currentVersion = nextVersion;
        reloadQueued = true;
        maybeReload();
      }
    } catch {
      // dev-only best effort polling
    }
  };

  document.addEventListener("visibilitychange", maybeReload);
  setInterval(poll, Math.max(Number(devConfig.intervalMs) || 1200, 500));
}

function incrementUnread(chatId) {
  const key = Number(chatId);
  if (!chats.has(key)) return;
  const chat = chats.get(key);
  chat.unread_count = runtimeHelpers.nextUnreadCount({
    currentUnreadCount: chat.unread_count,
    targetChatId: chatId,
    activeChatId,
    hidden: Boolean(document.hidden),
  });
}

function loadDraftsFromStorage() {
  try {
    const raw = localStorage.getItem(DRAFT_STORAGE_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return;
    for (const [chatId, value] of Object.entries(parsed)) {
      const key = Number(chatId);
      if (!key) continue;
      const text = String(value || "");
      if (text) {
        draftByChat.set(key, text);
      }
    }
  } catch {
    // non-fatal
  }
}

function persistDraftsToStorage() {
  try {
    const payload = {};
    for (const [chatId, draft] of draftByChat.entries()) {
      if (!draft) continue;
      payload[String(chatId)] = draft;
    }
    localStorage.setItem(DRAFT_STORAGE_KEY, JSON.stringify(payload));
  } catch {
    // non-fatal
  }
}

function setDraft(chatId, value) {
  const key = Number(chatId);
  if (!key) return;
  const text = String(value || "");
  if (text) {
    draftByChat.set(key, text);
  } else {
    draftByChat.delete(key);
  }
  persistDraftsToStorage();
}

function getDraft(chatId) {
  const key = Number(chatId);
  if (!key) return "";
  return String(draftByChat.get(key) || "");
}

function resetToolStream() {
  if (!toolStreamEl || !toolStreamLinesEl) return;
  toolStreamLinesEl.innerHTML = "";
  toolStreamEl.hidden = true;
}

function findPendingToolTraceMessage(chatId) {
  const key = Number(chatId);
  const history = histories.get(key) || [];
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const item = history[index];
    if (item?.role === "tool" && item?.pending) {
      return item;
    }
  }
  return null;
}

function ensurePendingToolTraceMessage(chatId) {
  const key = Number(chatId);
  const history = histories.get(key) || [];
  const existing = findPendingToolTraceMessage(key);
  if (existing) return existing;

  const next = {
    role: "tool",
    body: "",
    created_at: new Date().toISOString(),
    pending: true,
    collapsed: false,
  };

  const firstPendingHermesIndex = history.findIndex((item) => item?.role === "hermes" && item?.pending);
  if (firstPendingHermesIndex >= 0) {
    history.splice(firstPendingHermesIndex, 0, next);
  } else {
    history.push(next);
  }

  histories.set(key, history);
  return next;
}

function appendInlineToolTrace(chatId, text) {
  const line = String(text || "").trim();
  if (!line) return;
  const key = Number(chatId);
  const trace = ensurePendingToolTraceMessage(key);
  trace.body = trace.body ? `${trace.body}\n${line}` : line;
}

function finalizeInlineToolTrace(chatId) {
  const key = Number(chatId);
  const history = histories.get(key) || [];
  let changed = false;

  for (let index = history.length - 1; index >= 0; index -= 1) {
    const item = history[index];
    if (item?.role !== "tool" || !item?.pending) continue;

    const content = cleanDisplayText(item.body || "");
    if (!content) {
      history.splice(index, 1);
    } else {
      item.body = content;
      item.pending = false;
      if (typeof item.collapsed !== "boolean") {
        item.collapsed = true;
      } else {
        item.collapsed = true;
      }
    }
    changed = true;
    break;
  }

  if (changed) {
    histories.set(key, history);
  }
}

async function confirmAction(message) {
  if (tg?.showPopup) {
    return new Promise((resolve) => {
      tg.showPopup(
        {
          title: "Confirm",
          message,
          buttons: [
            { id: "cancel", type: "cancel" },
            { id: "ok", type: "destructive", text: "Close" },
          ],
        },
        (buttonId) => resolve(buttonId === "ok"),
      );
    });
  }
  return window.confirm(message);
}

async function askForChatTitle({ mode, currentTitle = "", defaultTitle = "New chat" }) {
  if (!chatTitleModal || !chatTitleForm || !chatTitleInput || !chatTitleHint || !chatTitleConfirm || !chatTitleCancel || !chatTitleModal.showModal) {
    const fallback = window.prompt(mode === "rename" ? "Rename chat" : "New chat name", currentTitle || defaultTitle);
    if (fallback === null) return null;
    const cleaned = fallback.trim();
    if (!cleaned) return null;
    return cleaned;
  }

  chatTitleHint.textContent = mode === "rename" ? "Update this chat title." : "Create a title for this chat.";
  chatTitleConfirm.textContent = mode === "rename" ? "Rename" : "Create";
  chatTitleInput.value = (mode === "rename" ? currentTitle : defaultTitle) || defaultTitle;

  return new Promise((resolve) => {
    let done = false;

    const cleanup = () => {
      chatTitleForm.removeEventListener("submit", onSubmit);
      chatTitleCancel.removeEventListener("click", onCancel);
      chatTitleModal.removeEventListener("cancel", onCancel);
      chatTitleModal.removeEventListener("close", onClose);
    };

    const finish = (value) => {
      if (done) return;
      done = true;
      cleanup();
      resolve(value);
    };

    const onSubmit = (event) => {
      event.preventDefault();
      const value = chatTitleInput.value.trim();
      if (!value) {
        chatTitleInput.focus();
        return;
      }
      if (chatTitleModal.open) chatTitleModal.close();
      finish(value);
    };

    const onCancel = (event) => {
      event?.preventDefault?.();
      if (chatTitleModal.open) chatTitleModal.close();
      finish(null);
    };

    const onClose = () => finish(null);

    chatTitleForm.addEventListener("submit", onSubmit);
    chatTitleCancel.addEventListener("click", onCancel);
    chatTitleModal.addEventListener("cancel", onCancel);
    chatTitleModal.addEventListener("close", onClose);

    chatTitleModal.showModal();
    setTimeout(() => {
      chatTitleInput.focus();
      chatTitleInput.select();
    }, 0);
  });
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

function getQuoteWrapWidth() {
  const fallback = 46;
  try {
    if (!promptInput || typeof window === "undefined") return fallback;
    const style = window.getComputedStyle(promptInput);
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

function formatQuoteBlock(rawText) {
  const clean = normalizeQuoteSelection(rawText);
  if (!clean) return "";

  const lines = [];
  for (const line of clean.split("\n")) {
    lines.push(line ? `│ ${line}` : "│");
  }

  return `┌ Quote\n${lines.join("\n")}\n└\n\n\n`;
}

function isCoarsePointer() {
  try {
    if (window.matchMedia?.("(pointer: coarse)")?.matches) {
      return true;
    }
  } catch {
    // Fallback below.
  }
  return "ontouchstart" in window;
}

function clearSelectionQuoteState() {
  selectionQuoteState.reset();
  if (selectionQuoteButton) {
    selectionQuoteButton.hidden = true;
  }
}

function cancelSelectionQuoteTimer(name) {
  selectionQuoteState.cancelTimer(name);
}

function cancelSelectionQuoteSync() {
  cancelSelectionQuoteTimer("sync");
}

function cancelSelectionQuoteSettle() {
  cancelSelectionQuoteTimer("settle");
}

function cancelSelectionQuoteClear() {
  cancelSelectionQuoteTimer("clear");
}

function scheduleSelectionQuoteClear(delayMs = 380) {
  selectionQuoteState.scheduleTimer("clear", delayMs, () => {
    const picked = activeSelectionQuote();
    if (!picked) {
      clearSelectionQuoteState();
    }
  });
}

function scheduleSelectionQuoteSync(delayMs = 120) {
  cancelSelectionQuoteSync();
  cancelSelectionQuoteSettle();
  selectionQuoteState.scheduleTimer("sync", delayMs, () => {
    syncSelectionQuoteAction();
  });
}

function applyQuoteIntoPrompt(text) {
  if (!promptEl) return;
  const quoteBlock = formatQuoteBlock(text);
  if (!quoteBlock) return;

  const maxLen = Number(promptEl.maxLength) > 0 ? Number(promptEl.maxLength) : 6000;
  const current = String(promptEl.value || "");
  const cursorStart = Number.isInteger(promptEl.selectionStart) ? promptEl.selectionStart : current.length;
  const cursorEnd = Number.isInteger(promptEl.selectionEnd) ? promptEl.selectionEnd : current.length;
  const next = `${current.slice(0, cursorStart)}${quoteBlock}${current.slice(cursorEnd)}`;
  promptEl.value = next.slice(0, maxLen);

  const nextCaret = Math.min(cursorStart + quoteBlock.length, promptEl.value.length);
  promptEl.focus();
  promptEl.setSelectionRange(nextCaret, nextCaret);
  ensureComposerVisible({ smooth: false });
}

function activeSelectionQuote() {
  if (!messagesEl) return null;
  const selection = window.getSelection?.();
  if (!selection || selection.rangeCount < 1 || selection.isCollapsed) {
    return null;
  }

  const range = selection.getRangeAt(0);
  const anchorNode = range.commonAncestorContainer;
  const anchorElement = anchorNode?.nodeType === Node.TEXT_NODE ? anchorNode.parentElement : anchorNode;
  if (!anchorElement || !messagesEl.contains(anchorElement)) {
    return null;
  }

  const text = normalizeQuoteSelection(selection.toString());
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

function showSelectionQuoteAction({ text, rect }, { lockPlacement = false } = {}) {
  if (!selectionQuoteButton) return;
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
  const viewportWidth = Number(window.innerWidth || 0);
  const viewportHeight = Number(window.innerHeight || 0);
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

function syncSelectionQuoteAction() {
  const firstPick = activeSelectionQuote();
  if (!firstPick) {
    clearSelectionQuoteState();
    return;
  }

  cancelSelectionQuoteClear();

  if (!mobileQuoteMode) {
    showSelectionQuoteAction(firstPick);
    return;
  }

  const firstKey = quotePlacementKey(firstPick);
  if (!selectionQuoteButton.hidden && selectionQuoteState.placementKey === firstKey) {
    selectionQuoteState.setText(firstPick.text);
    return;
  }

  cancelSelectionQuoteSettle();
  selectionQuoteState.scheduleTimer("settle", 110, () => {
    const settledPick = activeSelectionQuote();
    if (!settledPick) {
      scheduleSelectionQuoteClear(160);
      return;
    }
    const settledKey = quotePlacementKey(settledPick);
    if (settledKey !== firstKey) {
      scheduleSelectionQuoteSync(140);
      return;
    }
    showSelectionQuoteAction(settledPick, { lockPlacement: true });
  });
}

function renderBody(container, rawText) {
  const text = cleanDisplayText(rawText);
  const fenced = text.includes("```");
  if (!fenced) {
    container.innerHTML = escapeHtml(text).replace(/\n/g, "<br>");
    return;
  }

  const fragments = text.split("```");
  const parts = [];
  fragments.forEach((fragment, index) => {
    if (index % 2 === 0) {
      const safe = escapeHtml(fragment).replace(/\n/g, "<br>");
      if (safe) parts.push(`<div>${safe}</div>`);
      return;
    }
    const trimmed = fragment.replace(/^\n/, "");
    const lines = trimmed.split("\n");
    const maybeLang = lines[0].trim();
    const code = lines.slice(1).join("\n").trimEnd() || trimmed;
    parts.push(`<pre class="code-block" data-lang="${escapeHtml(maybeLang)}"><code>${escapeHtml(code)}</code></pre>`);
  });
  container.innerHTML = parts.join("");
}

function renderToolTraceBody(container, message) {
  container.innerHTML = "";
  const text = cleanDisplayText(message.body || "");
  const lines = text ? text.split("\n").map((line) => line.trim()).filter(Boolean) : [];
  if (!lines.length && !message.pending) {
    return;
  }

  const details = document.createElement("details");
  details.className = "tool-trace";
  const collapsed = typeof message.collapsed === "boolean" ? message.collapsed : !message.pending;
  details.open = !collapsed;

  const summary = document.createElement("summary");
  const lineCount = lines.length;
  const liveSuffix = message.pending ? " · live" : "";
  summary.textContent = `Tool activity (${lineCount})${liveSuffix}`;
  details.appendChild(summary);

  const list = document.createElement("div");
  list.className = "tool-trace__lines";
  if (lines.length) {
    for (const line of lines) {
      const row = document.createElement("div");
      row.className = "tool-trace__line";
      row.textContent = line;
      list.appendChild(row);
    }
  } else {
    const empty = document.createElement("div");
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

function roleLabelForMessage(message) {
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

function normalizeHandle(value) {
  return String(value || "").trim().replace(/^@+/, "");
}

function fallbackHandleFromDisplayName(value) {
  const cleaned = String(value || "").trim();
  if (!cleaned) return "";
  if (/^[\w .-]+$/.test(cleaned)) {
    return cleaned.replace(/\s+/g, "");
  }
  return cleaned;
}

function refreshOperatorRoleLabels() {
  if (!messagesEl) return;
  const label = operatorDisplayName || "Operator";
  for (const roleNode of messagesEl.querySelectorAll('.message--operator .message__role, .message[data-role="operator"] .message__role, .message[data-role="user"] .message__role')) {
    roleNode.textContent = label;
  }
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

function applyMessageMeta(node, message, role, variant) {
  node.classList.add(`message--${variant}`);
  if (message.pending) {
    node.classList.add("message--pending");
  }
  node.dataset.role = role;
  node.querySelector(".message__role").textContent = roleLabelForMessage(message);
  node.querySelector(".message__time").textContent = formatMessageTime(message.created_at);
}

function renderMessageContent(node, message, renderedBody) {
  const bodyNode = node.querySelector(".message__body");
  if (String(message.role || "").toLowerCase() === "tool") {
    renderToolTraceBody(bodyNode, message);
    return;
  }
  renderBody(bodyNode, renderedBody);
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

function upsertMessageNode(node, message) {
  const role = String(message.role || "").toLowerCase();
  const renderedBody = cleanDisplayText(message.body || (message.pending ? "…" : ""));
  if (shouldSkipMessageRender({ role, renderedBody, pending: Boolean(message.pending) })) {
    return false;
  }

  const variant = messageVariantForRole(role);
  node.className = "message";
  applyMessageMeta(node, message, role, variant);
  renderMessageContent(node, message, renderedBody);
  return true;
}

function createMessageNode(message, { index = 0 } = {}) {
  const node = template.content.firstElementChild.cloneNode(true);
  if (!upsertMessageNode(node, message)) {
    return null;
  }
  node.dataset.messageKey = messageStableKey(message, index);
  if (Number.isFinite(Number(message?.id)) && Number(message.id) > 0) {
    node.dataset.messageId = String(Number(message.id));
  } else {
    delete node.dataset.messageId;
  }
  return node;
}

function appendMessages(fragment, messages, startIndex = 0) {
  messages.forEach((message, offset) => {
    const node = createMessageNode(message, { index: startIndex + offset });
    if (node) {
      fragment.appendChild(node);
    }
  });
}

function isNearBottom(element, threshold = 24) {
  return (element.scrollHeight - element.clientHeight - element.scrollTop) <= threshold;
}

function shouldVirtualizeHistory(historyLength) {
  return historyLength > VIRTUALIZE_THRESHOLD;
}

function getEstimatedMessageHeight(chatId) {
  const metric = virtualMetrics.get(Number(chatId));
  return Math.max(56, Number(metric?.avgHeight) || ESTIMATED_MESSAGE_HEIGHT);
}

function updateVirtualMetrics(chatId) {
  const nodes = messagesEl.querySelectorAll(".message");
  if (!nodes.length) return;

  let totalHeight = 0;
  nodes.forEach((node) => {
    totalHeight += node.offsetHeight;
  });
  if (totalHeight <= 0) return;

  const sampleAvg = totalHeight / nodes.length;
  const prior = getEstimatedMessageHeight(chatId);
  const blended = Math.round((prior * 0.68) + (sampleAvg * 0.32));
  virtualMetrics.set(Number(chatId), { avgHeight: blended });
}

function updateJumpLatestVisibility() {
  const key = Number(activeChatId);
  const hasActiveChat = key > 0;

  const showJumpLatest = hasActiveChat && !isNearBottom(messagesEl, 64);
  if (jumpLatestButton) {
    jumpLatestButton.hidden = !showJumpLatest;
  }

  // Show an "up" helper when the beginning of the final message is above
  // the current viewport (common for long assistant outputs).
  if (jumpLastStartButton) {
    const renderedMessages = messagesEl.querySelectorAll(".message");
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
  if (!key || key !== Number(activeChatId)) return;
  if (isNearBottom(messagesEl, 40)) return;
  unseenStreamChats.add(key);
  refreshTabNode(key);
  updateJumpLatestVisibility();
}

function computeVirtualRange({ total, scrollTop, viewportHeight, forceBottom, estimatedHeight }) {
  const rowHeight = Math.max(56, estimatedHeight || ESTIMATED_MESSAGE_HEIGHT);
  const estimatedVisible = Math.max(1, Math.ceil(viewportHeight / rowHeight));
  const windowSize = estimatedVisible + (VIRTUAL_OVERSCAN * 2);

  if (forceBottom) {
    const end = total;
    const start = Math.max(0, end - windowSize);
    return { start, end };
  }

  const approxStart = Math.max(0, Math.floor(scrollTop / rowHeight) - VIRTUAL_OVERSCAN);
  const start = Math.min(approxStart, Math.max(0, total - windowSize));
  const end = Math.min(total, start + windowSize);
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

  const topSpacer = document.createElement("div");
  topSpacer.className = "messages__spacer";
  topSpacer.style.height = `${renderStart * estimatedHeight}px`;

  const bottomSpacer = document.createElement("div");
  bottomSpacer.className = "messages__spacer";
  bottomSpacer.style.height = `${Math.max(0, history.length - renderEnd) * estimatedHeight}px`;

  messagesEl.appendChild(topSpacer);
  const fragment = document.createDocumentFragment();
  appendMessages(fragment, history.slice(renderStart, renderEnd));
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
  const fragment = document.createDocumentFragment();
  appendMessages(fragment, history);
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

  const renderedMessageKeys = Array.from(messagesEl.querySelectorAll(".message"))
    .map((node) => String(node?.dataset?.messageKey || ""));
  if (!runtimeHelpers.shouldUseAppendOnlyRender({
    history,
    previouslyRenderedLength,
    renderedMessageKeys,
  })) {
    renderTraceLog("append-only-skip-history-misaligned", {
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

  const fragment = document.createDocumentFragment();
  appendMessages(fragment, appendedSlice);
  messagesEl.appendChild(fragment);

  const shouldStickBottom = Boolean(chatStickToBottom.get(targetChatId) || wasNearBottom);
  if (shouldStickBottom) {
    messagesEl.scrollTop = messagesEl.scrollHeight;
  } else {
    // Appending new messages at the bottom should not move the viewport when
    // the operator is reading older content.
    messagesEl.scrollTop = Math.max(0, prevScrollTop);
  }

  renderTraceLog("append-only-render", {
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
    // Keep the user's viewport anchored to the same absolute scroll offset.
    messagesEl.scrollTop = Math.max(0, prevScrollTop);
  } else if (chatScrollTop.has(targetChatId) && !shouldStick) {
    messagesEl.scrollTop = Math.max(0, chatScrollTop.get(targetChatId));
  } else {
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }
}

function finalizeRenderMessages(targetChatId, history, { shouldVirtualize, forceBottom }) {
  renderedChatId = targetChatId;
  renderedHistoryLength.set(targetChatId, history.length);
  renderedHistoryVirtualized.set(targetChatId, Boolean(shouldVirtualize));
  if (shouldVirtualize) {
    updateVirtualMetrics(targetChatId);
  }

  const atBottom = isNearBottom(messagesEl, 40);
  if (forceBottom || atBottom) {
    unseenStreamChats.delete(targetChatId);
    refreshTabNode(targetChatId);
  }
  chatScrollTop.set(targetChatId, messagesEl.scrollTop);
  chatStickToBottom.set(targetChatId, atBottom);
  updateJumpLatestVisibility();
  historyCount.textContent = String(history.filter((item) => item.role !== "system").length);
}

function renderMessages(chatId, { preserveViewport = false, forceBottom = false } = {}) {
  const targetChatId = Number(chatId);
  const isSameRenderedChat = Number(renderedChatId) === targetChatId;
  const prevScrollTop = messagesEl.scrollTop;
  const wasNearBottom = isNearBottom(messagesEl, 40);
  // Keep viewport stable when reading older messages, but anchor to bottom
  // when the operator is already near latest and new content arrives.
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
    return;
  }

  renderTraceLog("full-render", {
    chatId: Number(targetChatId),
    reason: "append-only-unavailable",
    preserveViewport: Boolean(preserveViewport),
    forceBottom: Boolean(forceBottom),
    shouldVirtualize,
    historyLength: history.length,
  });

  messagesEl.innerHTML = "";
  clearSelectionQuoteState();

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
}

function normalizeChat(chat, { forcePinned = null } = {}) {
  return {
    ...chat,
    id: Number(chat.id),
    unread_count: Number(chat.unread_count || 0),
    pending: Boolean(chat.pending),
    is_pinned: forcePinned == null ? Boolean(chat.is_pinned) : Boolean(forcePinned),
  };
}

function upsertChat(chat) {
  const normalized = normalizeChat(chat);
  chats.set(Number(normalized.id), normalized);
  if (normalized.is_pinned) {
    pinnedChats.set(Number(normalized.id), { ...normalized });
  } else {
    pinnedChats.delete(Number(normalized.id));
  }
}

function syncPinnedChats(chatList) {
  if (!Array.isArray(chatList)) {
    return;
  }
  pinnedChats.clear();
  chatList.forEach((chat) => {
    const normalized = normalizeChat(chat, { forcePinned: true });
    if (normalized.id > 0) {
      pinnedChats.set(normalized.id, normalized);
    }
  });
}

function syncChats(chatList) {
  const nextIds = new Set((chatList || []).map((chat) => Number(chat.id)));
  [...chats.keys()].forEach((chatId) => {
    if (!nextIds.has(Number(chatId))) {
      chats.delete(Number(chatId));
      histories.delete(Number(chatId));
      pendingChats.delete(Number(chatId));
      streamPhaseByChat.delete(Number(chatId));
      prefetchingHistories.delete(Number(chatId));
      chatScrollTop.delete(Number(chatId));
      chatStickToBottom.delete(Number(chatId));
      virtualizationRanges.delete(Number(chatId));
      virtualMetrics.delete(Number(chatId));
      renderedHistoryLength.delete(Number(chatId));
      renderedHistoryVirtualized.delete(Number(chatId));
      unseenStreamChats.delete(Number(chatId));
      const staleNode = tabNodes.get(Number(chatId));
      staleNode?.remove();
      tabNodes.delete(Number(chatId));
    }
  });
  (chatList || []).forEach(upsertChat);
}

function getOrCreateTabNode(chatId) {
  return chatUiHelpers.getOrCreateTabNode({
    tabNodes,
    tabTemplate,
    chatId,
  });
}

function getTabBadgeState(chat) {
  return chatUiHelpers.getTabBadgeState({
    chat,
    pendingChats,
    unseenStreamChats,
  });
}

function applyTabBadgeState(badge, badgeState) {
  chatUiHelpers.applyTabBadgeState({ badge, badgeState });
}

function applyTabNodeState(node, chat) {
  chatUiHelpers.applyTabNodeState({
    node,
    chat,
    activeChatId,
    pendingChats,
    unseenStreamChats,
    getTabBadgeState,
    applyTabBadgeState,
  });
}

function removeMissingTabNodes(nextIds) {
  chatUiHelpers.removeMissingTabNodes({ tabNodes, nextIds });
}

function renderTabs() {
  chatUiHelpers.renderTabs({
    chats,
    tabNodes,
    tabTemplate,
    tabsEl,
    applyTabNodeState,
  });
}

function renderPinnedChats() {
  chatUiHelpers.renderPinnedChats({
    pinnedChatsWrap,
    pinnedChatsEl,
    pinnedChats,
    doc: document,
  });
}

function syncPinChatButton() {
  if (!pinChatButton) return;
  const chat = chats.get(Number(activeChatId));
  pinChatButton.textContent = chat?.is_pinned ? "Unpin chat" : "Pin chat";
}

function refreshTabNode(chatId) {
  chatUiHelpers.refreshTabNode({
    chatId,
    tabNodes,
    chats,
    applyTabNodeState,
  });
}

function syncActiveTabSelection(previousChatId, nextChatId) {
  chatUiHelpers.syncActiveTabSelection({
    previousChatId,
    nextChatId,
    tabNodes,
    renderTabs,
    refreshTabNode,
  });
}

function normalizeSkin(value) {
  const candidate = String(value || "").trim().toLowerCase();
  return ALLOWED_SKINS.has(candidate) ? candidate : null;
}

function getStoredSkin() {
  try {
    return normalizeSkin(localStorage.getItem(SKIN_STORAGE_KEY));
  } catch {
    return null;
  }
}

function broadcastSkinUpdate(skin) {
  if (!skinSyncChannel) return;
  try {
    skinSyncChannel.postMessage({ type: "skin", skin });
  } catch {
    // best effort
  }
}

function setSkin(skin, { persist = true, broadcast = true } = {}) {
  const nextSkin = normalizeSkin(skin);
  if (!nextSkin) return;

  currentSkin = nextSkin;
  body.dataset.skin = nextSkin;
  document.documentElement?.setAttribute("data-skin", nextSkin);

  if (persist) {
    try {
      localStorage.setItem(SKIN_STORAGE_KEY, nextSkin);
    } catch (_) {
      // non-fatal
    }
  }

  if (broadcast) {
    broadcastSkinUpdate(nextSkin);
  }

  skinName.textContent = nextSkin;
  skinButtons.forEach((button) => {
    button.classList.toggle("is-active", button.dataset.skin === nextSkin);
  });
  if (panelHint) panelHint.textContent = "";
  syncTelegramChromeForSkin(nextSkin);
}

function syncSkinFromStorage() {
  const storedSkin = getStoredSkin();
  if (!storedSkin || storedSkin === currentSkin) return;
  setSkin(storedSkin, { persist: false, broadcast: false });
}

function syncActivePendingStatus() {
  const chat = chats.get(Number(activeChatId));
  if (chat?.pending) {
    setStreamStatus(`Waiting for Hermes in ${chatLabel(activeChatId)}`);
    setActivityChip(streamChip, `stream: pending · ${compactChatLabel(activeChatId)}`);
    return;
  }
  if ((streamChip?.textContent || "").startsWith("stream: pending")) {
    setActivityChip(streamChip, "stream: idle");
  }
}

function setActiveChatMeta(chatId, { fullTabRender = true, deferNonCritical = false } = {}) {
  const hadPreviousActive = activeChatId != null;
  const previousActiveChatId = Number(activeChatId);
  if (hadPreviousActive && Number(renderedChatId) === previousActiveChatId) {
    chatScrollTop.set(previousActiveChatId, messagesEl.scrollTop);
    chatStickToBottom.set(previousActiveChatId, isNearBottom(messagesEl));
  }
  if (hadPreviousActive && previousActiveChatId) {
    setDraft(previousActiveChatId, promptEl.value || "");
  }

  activeChatId = Number(chatId);
  promptEl.value = getDraft(activeChatId);
  const chat = chats.get(activeChatId);
  const title = chat?.title || "Chat";
  activeChatName.textContent = title;
  panelTitle.textContent = `Conversation · ${title}`;
  updateComposerState();
  syncPinChatButton();

  if (fullTabRender) {
    renderTabs();
  } else {
    syncActiveTabSelection(previousActiveChatId, activeChatId);
  }

  const finalizeMeta = () => {
    syncActivePendingStatus();
    syncActiveLatencyChip();
    updateJumpLatestVisibility();
  };

  if (deferNonCritical) {
    setTimeout(finalizeMeta, 0);
  } else {
    finalizeMeta();
  }
}

function updateComposerState() {
  const pending = pendingChats.has(Number(activeChatId)) || Boolean(chats.get(Number(activeChatId))?.pending);
  sendButton.disabled = pending || !isAuthenticated;
  sendButton.textContent = pending ? "Sending…" : "Send";
  promptEl.disabled = !isAuthenticated;
  if (removeChatButton) {
    removeChatButton.disabled = pending || !isAuthenticated || !activeChatId;
  }
  if (pinChatButton) {
    pinChatButton.disabled = pending || !isAuthenticated || !activeChatId;
  }
}

function setStreamAbortController(chatId, controller) {
  const key = Number(chatId);
  const existing = streamAbortControllers.get(key);
  if (existing && existing !== controller) {
    try {
      existing.abort();
    } catch {
      // best effort
    }
  }
  streamAbortControllers.set(key, controller);
}

function clearStreamAbortController(chatId, controller) {
  const key = Number(chatId);
  const existing = streamAbortControllers.get(key);
  if (!existing) return;
  if (controller && existing !== controller) return;
  streamAbortControllers.delete(key);
}

function hasLiveStreamController(chatId) {
  const key = Number(chatId);
  const controller = streamAbortControllers.get(key);
  if (!controller) return false;
  return !Boolean(controller.signal?.aborted);
}

async function apiPost(url, payload) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(authPayload(payload)),
  });
  const data = await safeReadJson(response);
  if (!response.ok || !data?.ok) {
    const message = data?.error || `Request failed: ${response.status}`;
    if (/Telegram init data is too old/i.test(message)) {
      isAuthenticated = false;
      authStatus.textContent = "Session expired";
      updateComposerState();
      throw new Error("Telegram session expired. Close and reopen the mini app to refresh auth.");
    }
    throw new Error(message);
  }
  return data;
}

async function refreshChats() {
  const data = await apiPost("/api/chats/status", {});
  syncChats(data.chats || []);
  syncPinnedChats(data.pinned_chats || []);
  renderTabs();
  renderPinnedChats();
  syncActivePendingStatus();
  updateComposerState();
}

function historiesDiffer(currentHistory, incomingHistory) {
  const a = currentHistory || [];
  const b = incomingHistory || [];
  if (a.length !== b.length) return true;
  if (!a.length) return false;

  const aLast = a[a.length - 1] || {};
  const bLast = b[b.length - 1] || {};
  return aLast.id !== bLast.id || aLast.body !== bLast.body || aLast.role !== bLast.role;
}

async function hydrateChatFromServer(targetChatId, requestId, hadCachedHistory) {
  const data = await loadChatHistory(targetChatId, { activate: true });
  upsertChat(data.chat);

  if (requestId !== lastOpenChatRequestId) {
    return;
  }

  const previousHistory = histories.get(targetChatId) || [];
  const chatPending = Boolean(data.chat?.pending);
  const shouldResumePending = chatPending && !hasLiveStreamController(targetChatId);
  const nextHistory = runtimeHelpers.mergeHydratedHistory({
    previousHistory,
    nextHistory: data.history || [],
    chatPending,
  });
  const historyChanged = historiesDiffer(previousHistory, nextHistory);
  histories.set(targetChatId, nextHistory);

  if (chats.has(targetChatId)) {
    chats.get(targetChatId).unread_count = 0;
  }
  refreshTabNode(targetChatId);

  if (Number(activeChatId) !== targetChatId) {
    setActiveChatMeta(targetChatId);
    renderMessages(targetChatId);
    if (shouldResumePending) {
      void resumePendingChatStream(targetChatId);
    }
    return;
  }

  if (!hadCachedHistory || historyChanged) {
    renderMessages(targetChatId, { preserveViewport: hadCachedHistory });
  }
  if (shouldResumePending) {
    void resumePendingChatStream(targetChatId);
  }
}

async function openChat(chatId) {
  const targetChatId = Number(chatId);
  const requestId = ++lastOpenChatRequestId;
  const hadCachedHistory = histories.has(targetChatId);

  if (chats.has(targetChatId)) {
    chats.get(targetChatId).unread_count = 0;
  }

  if (hadCachedHistory) {
    setActiveChatMeta(targetChatId, { fullTabRender: false, deferNonCritical: true });
    renderMessages(targetChatId);

    setTimeout(() => {
      void hydrateChatFromServer(targetChatId, requestId, true).catch(() => {
        // best-effort refresh while cached view is already visible
      });
    }, 0);
    return;
  }

  try {
    await hydrateChatFromServer(targetChatId, requestId, false);
  } catch (error) {
    if (requestId === lastOpenChatRequestId) {
      appendSystemMessage(error.message || "Failed to open chat.");
    }
  }
}

async function markRead(chatId) {
  const data = await apiPost("/api/chats/mark-read", { chat_id: chatId });
  upsertChat(data.chat);
  renderTabs();
  if (Number(chatId) === Number(activeChatId)) {
    syncActivePendingStatus();
    updateComposerState();
  }
}

function normalizeStreamPhase(value) {
  const normalized = String(value || "").toLowerCase();
  if (Object.values(STREAM_PHASES).includes(normalized)) {
    return normalized;
  }
  return STREAM_PHASES.IDLE;
}

function getStreamPhase(chatId) {
  const key = Number(chatId);
  if (!key) return STREAM_PHASES.IDLE;
  return normalizeStreamPhase(streamPhaseByChat.get(key));
}

function setStreamPhase(chatId, phase) {
  const key = Number(chatId);
  if (!key) return;
  const next = normalizeStreamPhase(phase);
  streamPhaseByChat.set(key, next);
  renderTraceLog("stream-phase", { chatId: key, phase: next });
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

function findLatestHistoryMessageByRole(chatId, role, { pendingOnly = null } = {}) {
  const targetRole = String(role || "").toLowerCase();
  const history = histories.get(Number(chatId)) || [];
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const item = history[index];
    if (String(item?.role || "").toLowerCase() !== targetRole) continue;
    if (pendingOnly !== null && Boolean(item?.pending) !== Boolean(pendingOnly)) continue;
    return {
      message: item,
      index,
      key: messageStableKey(item, index),
      alternatePendingKey: messageStableKeyForPendingState(item, index, !Boolean(item?.pending)),
    };
  }
  return null;
}

function findLatestAssistantHistoryMessage(chatId, { pendingOnly = null } = {}) {
  const history = histories.get(Number(chatId)) || [];
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const item = history[index];
    const role = String(item?.role || "").toLowerCase();
    if (role !== "assistant" && role !== "hermes") continue;
    if (pendingOnly !== null && Boolean(item?.pending) !== Boolean(pendingOnly)) continue;
    return {
      message: item,
      index,
      key: messageStableKey(item, index),
      alternatePendingKey: messageStableKeyForPendingState(item, index, !Boolean(item?.pending)),
    };
  }
  return null;
}

function findMessageNodeByKey(selector, messageKey, alternateMessageKey = "") {
  if (!messagesEl) return null;
  const nodes = messagesEl.querySelectorAll(selector);
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

function patchVisiblePendingAssistant(chatId, nextBody, pendingState = true) {
  if (Number(chatId) !== Number(activeChatId)) return false;

  const phase = getStreamPhase(chatId);
  const phaseAllowed = phase === STREAM_PHASES.PENDING_TOOL
    || phase === STREAM_PHASES.STREAMING_TOOL
    || phase === STREAM_PHASES.STREAMING_ASSISTANT
    || phase === STREAM_PHASES.FINALIZED
    || phase === STREAM_PHASES.ERROR;
  if (!phaseAllowed) {
    renderTraceLog("stream-assistant-phase-mismatch", { chatId: Number(chatId), phase });
    return false;
  }

  const assistantTarget = findLatestAssistantHistoryMessage(chatId, { pendingOnly: null });
  if (!assistantTarget) {
    renderTraceLog("stream-assistant-target-missing", { chatId: Number(chatId), phase });
    return false;
  }

  const node = findMessageNodeByKey(
    ".message--assistant",
    assistantTarget.key,
    assistantTarget.alternatePendingKey,
  );
  if (!node) {
    renderTraceLog("stream-assistant-node-missing", {
      chatId: Number(chatId),
      phase,
      targetKey: assistantTarget.key,
      alternateKey: assistantTarget.alternatePendingKey,
    });
    return false;
  }

  const patchedNodeKey = String(node?.dataset?.messageKey || "");
  if (patchedNodeKey !== assistantTarget.key && patchedNodeKey !== assistantTarget.alternatePendingKey) {
    renderTraceLog("stream-assistant-key-mismatch", {
      chatId: Number(chatId),
      phase,
      targetKey: assistantTarget.key,
      alternateKey: assistantTarget.alternatePendingKey,
      patchedNodeKey,
    });
    return false;
  }

  const bodyNode = node.querySelector(".message__body");
  if (!bodyNode) return false;

  preserveViewportDuringUiMutation(() => {
    renderBody(bodyNode, nextBody || (pendingState ? "…" : ""));
    node.classList.toggle("message--pending", Boolean(pendingState));
  });
  return true;
}

function patchVisibleToolTrace(chatId) {
  if (Number(chatId) !== Number(activeChatId)) return false;

  const phase = getStreamPhase(chatId);
  const phaseAllowed = phase === STREAM_PHASES.PENDING_TOOL
    || phase === STREAM_PHASES.STREAMING_TOOL
    || phase === STREAM_PHASES.STREAMING_ASSISTANT
    || phase === STREAM_PHASES.FINALIZED
    || phase === STREAM_PHASES.ERROR;
  if (!phaseAllowed) {
    renderTraceLog("stream-tool-phase-mismatch", { chatId: Number(chatId), phase });
    return false;
  }

  const latestToolTarget = findLatestHistoryMessageByRole(chatId, "tool", { pendingOnly: null });
  if (!latestToolTarget) {
    return true;
  }

  const node = findMessageNodeByKey(
    ".message--tool",
    latestToolTarget.key,
    latestToolTarget.alternatePendingKey,
  );
  if (!node) {
    renderTraceLog("stream-tool-node-missing", {
      chatId: Number(chatId),
      phase,
      targetKey: latestToolTarget.key,
      alternateKey: latestToolTarget.alternatePendingKey,
    });
    return false;
  }

  const patchedNodeKey = String(node?.dataset?.messageKey || "");
  if (patchedNodeKey !== latestToolTarget.key && patchedNodeKey !== latestToolTarget.alternatePendingKey) {
    renderTraceLog("stream-tool-key-mismatch", {
      chatId: Number(chatId),
      phase,
      targetKey: latestToolTarget.key,
      alternateKey: latestToolTarget.alternatePendingKey,
      patchedNodeKey,
    });
    return false;
  }

  const bodyNode = node.querySelector(".message__body");
  const timeNode = node.querySelector(".message__time");
  if (!bodyNode || !timeNode) return false;

  preserveViewportDuringUiMutation(() => {
    renderToolTraceBody(bodyNode, latestToolTarget.message);
    timeNode.textContent = formatMessageTime(latestToolTarget.message.created_at);
    node.classList.toggle("message--pending", Boolean(latestToolTarget.message.pending));
  });
  return true;
}

function maybeMarkRead(chatId, { force = false } = {}) {
  const key = Number(chatId);
  if (!key || !isAuthenticated || key !== Number(activeChatId)) {
    return;
  }
  if (!force) {
    if (!isNearBottom(messagesEl, 40)) return;
    if (unseenStreamChats.has(key)) return;
    const unread = Number(chats.get(key)?.unread_count || 0);
    if (unread <= 0) return;
  }
  if (markReadInFlight.has(key)) {
    return;
  }
  markReadInFlight.add(key);
  void markRead(key)
    .catch(() => {
      // Best-effort read sync; retry on next visibility/scroll tick.
    })
    .finally(() => {
      markReadInFlight.delete(key);
    });
}

async function createChat() {
  const title = await askForChatTitle({ mode: "create", defaultTitle: "New chat" });
  if (!title) return;
  const cleaned = title.trim() || "New chat";
  const data = await apiPost("/api/chats", { title: cleaned });
  upsertChat(data.chat);
  histories.set(Number(data.chat.id), data.history || []);
  setActiveChatMeta(data.chat.id);
  renderMessages(data.chat.id);
}

async function renameActiveChat() {
  if (!activeChatId) return;
  const currentTitle = chatLabel(activeChatId);
  const nextTitle = await askForChatTitle({ mode: "rename", currentTitle, defaultTitle: currentTitle });
  if (!nextTitle) return;
  const cleaned = nextTitle.trim() || currentTitle;
  const data = await apiPost("/api/chats/rename", { chat_id: activeChatId, title: cleaned });
  upsertChat(data.chat);
  setActiveChatMeta(activeChatId);
  renderTabs();
  renderPinnedChats();
}

function ensureSilentCloseTabAllowed(chatId) {
  // Product intent: closing a chat tab is intentionally silent.
  // Keep this non-interactive (no modal/toast confirmations) and rely on
  // server-side guards + pending-state checks for safety.
  if (pendingChats.has(Number(chatId))) {
    throw new Error("Wait for Hermes to finish before closing this chat.");
  }
}

async function removeActiveChat() {
  if (!activeChatId) return;
  ensureSilentCloseTabAllowed(activeChatId);
  const currentChatId = Number(activeChatId);
  const data = await apiPost("/api/chats/remove", { chat_id: currentChatId });
  syncChats(data.chats || []);
  syncPinnedChats(data.pinned_chats || []);
  histories.delete(Number(data.removed_chat_id));
  pendingChats.delete(Number(data.removed_chat_id));
  streamPhaseByChat.delete(Number(data.removed_chat_id));
  latencyByChat.delete(Number(data.removed_chat_id));
  histories.set(Number(data.active_chat_id), data.history || []);
  upsertChat(data.active_chat);
  setActiveChatMeta(data.active_chat_id);
  renderPinnedChats();
  renderMessages(data.active_chat_id);
}

async function openPinnedChat(chatId) {
  const targetChatId = Number(chatId);
  if (!targetChatId) return;
  if (!chats.has(targetChatId)) {
    const reopenData = await apiPost("/api/chats/reopen", { chat_id: targetChatId });
    syncChats(reopenData.chats || []);
    syncPinnedChats(reopenData.pinned_chats || []);
    upsertChat(reopenData.chat);
    renderTabs();
    renderPinnedChats();
  }
  await openChat(targetChatId);
}

async function toggleActiveChatPin() {
  const targetChatId = Number(activeChatId);
  if (!targetChatId) return;
  const chat = chats.get(targetChatId);
  const isPinned = Boolean(chat?.is_pinned);
  const endpoint = isPinned ? "/api/chats/unpin" : "/api/chats/pin";
  const data = await apiPost(endpoint, { chat_id: targetChatId });
  upsertChat(data.chat);
  syncPinnedChats(data.pinned_chats || []);
  renderTabs();
  renderPinnedChats();
  syncPinChatButton();
}

function addLocalMessage(chatId, message) {
  const key = Number(chatId);
  const history = histories.get(key) || [];
  history.push(message);
  histories.set(key, history);
}

function updatePendingAssistant(chatId, nextBody, pendingState = true) {
  const key = Number(chatId);
  const history = histories.get(key) || [];
  let pendingMessage = null;
  for (let index = history.length - 1; index >= 0; index -= 1) {
    if (history[index].pending && history[index].role === "hermes") {
      pendingMessage = history[index];
      break;
    }
  }

  if (!pendingMessage) {
    const safeBody = String(nextBody || "").trim();
    if (!safeBody && !pendingState) {
      return;
    }
    history.push({
      role: "hermes",
      body: nextBody,
      created_at: new Date().toISOString(),
      pending: pendingState,
    });
    histories.set(key, history);
    return;
  }

  pendingMessage.body = nextBody;
  pendingMessage.pending = pendingState;
  histories.set(key, history);
}

function appendSystemMessage(text) {
  if (!activeChatId) {
    const node = template.content.firstElementChild.cloneNode(true);
    node.classList.add("message--system");
    node.querySelector(".message__role").textContent = "system";
    node.querySelector(".message__time").textContent = nowStamp();
    renderBody(node.querySelector(".message__body"), text);
    messagesEl.appendChild(node);
    return;
  }
  addLocalMessage(activeChatId, { role: "system", body: text, created_at: new Date().toISOString() });
  renderMessages(activeChatId);
}

function syncActiveMessageView(chatId, options = {}) {
  if (Number(chatId) === Number(activeChatId)) {
    renderMessages(chatId, options);
  }
}

function scheduleActiveMessageView(chatId) {
  if (Number(chatId) !== Number(activeChatId)) return;
  activeRenderChatId = Number(chatId);
  if (activeRenderScheduled) return;
  activeRenderScheduled = true;
  runAfterUiMutation(() => {
    activeRenderScheduled = false;
    const targetChatId = activeRenderChatId;
    activeRenderChatId = null;
    if (targetChatId == null || Number(targetChatId) !== Number(activeChatId)) return;
    renderMessages(targetChatId, { preserveViewport: true });
  });
}

async function loadChatHistory(chatId, { activate = true } = {}) {
  const targetChatId = Number(chatId);
  try {
    return await apiPost("/api/chats/history", { chat_id: targetChatId, activate });
  } catch (error) {
    // Backward compatibility: older backend may not expose /api/chats/history yet.
    const message = String(error?.message || "");
    const isNotFound = /request failed:\s*404/i.test(message);
    if (!isNotFound) {
      throw error;
    }
    return apiPost("/api/chats/open", { chat_id: targetChatId });
  }
}

function prefetchChatHistory(chatId) {
  const key = Number(chatId);
  if (!isAuthenticated || !key || histories.has(key) || prefetchingHistories.has(key)) {
    return;
  }
  prefetchingHistories.add(key);
  void loadChatHistory(key, { activate: false })
    .then((data) => {
      upsertChat(data.chat);
      histories.set(key, data.history || []);
    })
    .catch(() => {
      // Best-effort warm cache
    })
    .finally(() => {
      prefetchingHistories.delete(key);
    });
}

function warmChatHistoryCache() {
  const ids = [...chats.keys()].filter((id) => Number(id) !== Number(activeChatId));
  if (!ids.length) return;
  const warmNext = (index) => {
    if (index >= ids.length) return;
    prefetchChatHistory(ids[index]);
    setTimeout(() => warmNext(index + 1), 160);
  };

  if (typeof window.requestIdleCallback === "function") {
    window.requestIdleCallback(() => warmNext(0), { timeout: 1200 });
    return;
  }
  setTimeout(() => warmNext(0), 120);
}

async function bootstrap() {
  if (!tg) {
    authStatus.textContent = "Telegram connection missing";
    appendSystemMessage("Open this mini app from Telegram.");
    revealShell();
    return;
  }

  try {
    tg.ready?.();
    tg.expand?.();
  } catch {
    // Non-fatal: proceed with auth even when client WebApp helpers partially fail.
  }

  syncRenderTraceBadge();
  loadDraftsFromStorage();
  syncClosingConfirmation();
  syncFullscreenControlState();
  try {
    tg.onEvent?.("fullscreenChanged", syncFullscreenControlState);
    tg.onEvent?.("fullscreenFailed", () => appendSystemMessage("Fullscreen request was denied by Telegram client."));
  } catch {
    // Optional event hooks vary across Telegram clients.
  }
  initData = tg.initData || "";
  renderTraceLog("debug-enabled", {
    enabled: renderTraceDebugEnabled,
    toggleHint: "Open Settings and tap Render Trace to toggle logging",
  });

  try {
    const response = await fetch("/api/auth", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ init_data: initData }),
    });
    const data = await safeReadJson(response);

    if (!response.ok || !data?.ok) {
      authStatus.textContent = "Sign-in failed";
      appendSystemMessage(data?.error || "Sign-in failed.");
      return;
    }

    isAuthenticated = true;
    const telegramUsername = normalizeHandle(tg?.initDataUnsafe?.user?.username);
    const apiUsername = normalizeHandle(data?.user?.username);
    const displayName = String(data?.user?.display_name || "").trim();
    const signedInName = telegramUsername || apiUsername || fallbackHandleFromDisplayName(displayName) || "Operator";
    operatorDisplayName = signedInName;
    operatorName.textContent = signedInName;
    authStatus.textContent = `Signed in as ${signedInName}`;
    refreshOperatorRoleLabels();
    setSkin(data.skin || "terminal");

    (data.chats || []).forEach(upsertChat);
    syncPinnedChats(data.pinned_chats || []);
    histories.set(Number(data.active_chat_id), data.history || []);
    setActiveChatMeta(data.active_chat_id);
    renderPinnedChats();
    renderMessages(data.active_chat_id);
    warmChatHistoryCache();
    if (Boolean(chats.get(Number(data.active_chat_id))?.pending) && !pendingChats.has(Number(data.active_chat_id))) {
      void resumePendingChatStream(Number(data.active_chat_id));
    }
    if (!(data.history || []).length) {
      addLocalMessage(data.active_chat_id, {
        role: "system",
        body: "You're all set. This chat is empty.",
        created_at: new Date().toISOString(),
      });
      renderMessages(data.active_chat_id);
    }
  } catch (error) {
    authStatus.textContent = "Sign-in error";
    appendSystemMessage(`Could not start the app: ${error.message}`);
  } finally {
    updateComposerState();
    revealShell();
  }
}

async function saveSkinPreference(skin) {
  const data = await apiPost("/api/preferences/skin", { skin });
  setSkin(data.skin);
}

function applyDonePayload(chatId, payload, builtReplyRef, { updateUnread = true } = {}) {
  builtReplyRef.value = payload.reply || builtReplyRef.value;
  finalizeInlineToolTrace(chatId);
  updatePendingAssistant(chatId, builtReplyRef.value, false);
  markStreamUpdate(chatId);
  const patchedAssistant = patchVisiblePendingAssistant(chatId, builtReplyRef.value, false);
  const patchedToolTrace = patchVisibleToolTrace(chatId);
  renderTraceLog("stream-done-patch", {
    chatId: Number(chatId),
    patchedAssistant,
    patchedToolTrace,
    fallbackRender: !patchedAssistant || !patchedToolTrace,
  });
  if (!patchedAssistant || !patchedToolTrace) {
    syncActiveMessageView(chatId, { preserveViewport: true });
  }
  setChatLatency(chatId, formatLatency(payload.latency_ms));
  setStreamStatus(`Reply received in ${chatLabel(chatId)}`);
  setActivityChip(streamChip, `stream: complete · ${compactChatLabel(chatId)}`);
  if (updateUnread && Number(activeChatId) !== chatId) {
    incrementUnread(chatId);
    renderTabs();
  }
}

function handleStreamEvent(chatId, eventName, payload, builtReplyRef) {
  if (!payload) {
    return false;
  }

  if (eventName === "meta") {
    const detail = String(payload?.detail || "").toLowerCase();
    if (detail.includes("running") || payload?.job_status === "running") {
      if (getStreamPhase(chatId) === STREAM_PHASES.IDLE) {
        setStreamPhase(chatId, STREAM_PHASES.PENDING_TOOL);
      }
    }
  }

  if (eventName === "meta" && payload.skin) {
    // Stream meta can be delayed (queued/resume) and may carry stale skin values from
    // when a job started. Applying it here can unexpectedly revert an operator's
    // newly selected skin while another chat is still streaming.
    renderTraceLog("stream-meta-skin-ignored", {
      chatId: Number(chatId),
      incomingSkin: payload.skin,
      currentSkin,
    });
  }
  if (eventName === "meta" && payload.source) {
    setActivityChip(sourceChip, `source: ${payload.source}`);
  }
  if (eventName === "meta" && payload.detail) {
    const detail = String(payload.detail || "").trim();
    if (detail) {
      setStreamStatus(`Queue update (${chatLabel(chatId)}): ${detail}`);
      if (payload.source === "queue") {
        setActivityChip(streamChip, `stream: ${detail} · ${compactChatLabel(chatId)}`);
        if (payload.job_status === "running") {
          const elapsedMs = Number(payload.elapsed_ms);
          if (Number.isFinite(elapsedMs) && elapsedMs >= 0) {
            setChatLatency(chatId, `${formatLatency(elapsedMs)} · live`);
          } else {
            setChatLatency(chatId, "calculating...");
          }
        }
      }
    }
    return false;
  }

  if (eventName === "tool") {
    setStreamPhase(chatId, STREAM_PHASES.STREAMING_TOOL);
    const display = payload.display || payload.preview || payload.tool_name || "Tool running";
    appendInlineToolTrace(chatId, display);
    markStreamUpdate(chatId);
    const patchedToolTrace = patchVisibleToolTrace(chatId);
    renderTraceLog("stream-tool-patch", {
      chatId: Number(chatId),
      phase: getStreamPhase(chatId),
      patchedToolTrace,
      fallbackRender: !patchedToolTrace,
    });
    if (!patchedToolTrace) {
      scheduleActiveMessageView(chatId);
    }
    setStreamStatus(`Using tools in ${chatLabel(chatId)}`);
    setActivityChip(streamChip, `stream: tools active · ${compactChatLabel(chatId)}`);
    return false;
  }

  if (eventName === "chunk") {
    setStreamPhase(chatId, STREAM_PHASES.STREAMING_ASSISTANT);
    builtReplyRef.value += payload.text || "";
    updatePendingAssistant(chatId, builtReplyRef.value, true);
    markStreamUpdate(chatId);
    const patchedAssistant = patchVisiblePendingAssistant(chatId, builtReplyRef.value, true);
    renderTraceLog("stream-chunk-patch", {
      chatId: Number(chatId),
      phase: getStreamPhase(chatId),
      patchedAssistant,
      fallbackRender: !patchedAssistant,
      chunkLength: String(payload.text || "").length,
      replyLength: builtReplyRef.value.length,
    });
    if (!patchedAssistant) {
      scheduleActiveMessageView(chatId);
    }
    return false;
  }

  if (eventName === "error") {
    setStreamPhase(chatId, STREAM_PHASES.ERROR);
    finalizeInlineToolTrace(chatId);
    updatePendingAssistant(chatId, payload.error || "Hermes stream failed.", false);
    markStreamUpdate(chatId);
    syncActiveMessageView(chatId, { preserveViewport: true });
    setStreamStatus("Stream error");
    setActivityChip(streamChip, "stream: error");
    return false;
  }

  if (eventName === "done") {
    setStreamPhase(chatId, STREAM_PHASES.FINALIZED);
    applyDonePayload(chatId, payload, builtReplyRef);
    return true;
  }

  return false;
}

function applyEarlyStreamCloseFallback(chatId, builtReplyRef, fallbackTraceEvent) {
  setStreamPhase(chatId, STREAM_PHASES.FINALIZED);
  const fallbackReply = builtReplyRef.value || "The response ended before completion.";
  finalizeInlineToolTrace(chatId);
  updatePendingAssistant(chatId, fallbackReply, false);
  markStreamUpdate(chatId);
  const patchedAssistant = patchVisiblePendingAssistant(chatId, fallbackReply, false);
  const patchedToolTrace = patchVisibleToolTrace(chatId);
  renderTraceLog(fallbackTraceEvent, {
    chatId: Number(chatId),
    patchedAssistant,
    patchedToolTrace,
    fallbackRender: !patchedAssistant || !patchedToolTrace,
  });
  if (!patchedAssistant || !patchedToolTrace) {
    syncActiveMessageView(chatId, { preserveViewport: true });
  }
  setStreamStatus("Stream closed early");
  setActivityChip(streamChip, "stream: closed early");
  if (Number(activeChatId) !== chatId) {
    incrementUnread(chatId);
  }
}

async function consumeStreamResponse(chatId, response, builtReplyRef, { fallbackTraceEvent } = {}) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let doneReceived = false;

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const events = buffer.split("\n\n");
    buffer = events.pop() || "";

    for (const rawEvent of events) {
      const parsed = parseSseEvent(rawEvent);
      if (!parsed) continue;
      const eventName = parsed.eventName || parsed.event || "message";
      const payload = parsed.payload;
      streamDebugLog("sse-event", {
        chatId: Number(chatId),
        eventName,
        payloadKeys: payload && typeof payload === "object" ? Object.keys(payload) : [],
      });
      if (handleStreamEvent(chatId, eventName, payload, builtReplyRef)) {
        doneReceived = true;
      }
    }
  }

  if (buffer.trim()) {
    const parsed = parseSseEvent(buffer.trim());
    const eventName = parsed?.eventName || parsed?.event || "message";
    const payload = parsed?.payload;
    streamDebugLog("sse-buffer-tail", {
      chatId: Number(chatId),
      eventName,
      hasPayload: Boolean(payload),
    });
    if (eventName === "done" && payload) {
      applyDonePayload(chatId, payload, builtReplyRef, { updateUnread: false });
      doneReceived = true;
    }
  }

  if (!doneReceived) {
    applyEarlyStreamCloseFallback(chatId, builtReplyRef, fallbackTraceEvent);
  }
}

function focusPromptIfActiveChat(chatId) {
  if (Number(activeChatId) !== Number(chatId) || document.visibilityState !== "visible" || mobileQuoteMode) {
    return;
  }
  try {
    promptEl.focus({ preventScroll: true });
  } catch {
    promptEl.focus();
  }
}

async function finalizeStreamLifecycle(chatId, streamController, { wasAborted }) {
  clearStreamAbortController(chatId, streamController);
  if (wasAborted) {
    setStreamPhase(chatId, STREAM_PHASES.IDLE);
    return;
  }

  pendingChats.delete(chatId);
  if (chats.has(chatId)) {
    chats.get(chatId).pending = false;
  }
  syncClosingConfirmation();

  try {
    if (Number(activeChatId) === Number(chatId)) {
      maybeMarkRead(Number(chatId));
    } else {
      await refreshChats();
    }
  } catch (error) {
    appendSystemMessage(`Failed to sync chat state: ${error.message}`);
  }

  renderTabs();
  updateComposerState();
  setStreamPhase(chatId, STREAM_PHASES.IDLE);
  focusPromptIfActiveChat(chatId);
}

async function sendPrompt(message) {
  if (!isAuthenticated || !activeChatId) {
    appendSystemMessage("Still signing you in. Try again in a moment.");
    return;
  }

  const cleaned = message.trim();
  if (!cleaned) return;

  const chatId = Number(activeChatId);
  const serverPending = Boolean(chats.get(chatId)?.pending);
  if (pendingChats.has(chatId) || serverPending) {
    appendSystemMessage(`Still replying in '${chatLabel(chatId)}'.`);
    return;
  }

  pendingChats.add(chatId);
  if (chats.has(chatId)) {
    chats.get(chatId).pending = true;
  }
  setStreamPhase(chatId, STREAM_PHASES.PENDING_TOOL);
  syncClosingConfirmation();
  renderTabs();
  updateComposerState();

  addLocalMessage(chatId, { role: "operator", body: cleaned, created_at: new Date().toISOString() });
  if (chatId === Number(activeChatId)) {
    promptEl.value = "";
    setDraft(chatId, "");
  }
  syncActiveMessageView(chatId, { preserveViewport: true });

  resetToolStream();
  const chatLabelCompact = compactChatLabel(chatId);
  setStreamStatus(`Hermes responding in ${chatLabel(chatId)}`);
  setActivityChip(streamChip, `stream: active · ${chatLabelCompact}`);
  setActivityChip(latencyChip, "latency: calculating...");
  setChatLatency(chatId, "calculating...");

  const builtReplyRef = { value: "" };
  let wasAborted = false;
  const streamController = new AbortController();
  setStreamAbortController(chatId, streamController);

  try {
    const response = await fetch("/api/chat/stream", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(authPayload({ chat_id: chatId, message: cleaned })),
      signal: streamController.signal,
    });

    if (!response.ok || !response.body) {
      setStreamPhase(chatId, STREAM_PHASES.ERROR);
      const fallback = await response.text();
      if (/Telegram init data is too old/i.test(fallback || "")) {
        isAuthenticated = false;
        authStatus.textContent = "Session expired";
        updatePendingAssistant(chatId, "Telegram session expired. Close and reopen the mini app to refresh auth.", false);
        updateComposerState();
      } else {
        updatePendingAssistant(chatId, fallback || "Hermes call failed.", false);
      }
      syncActiveMessageView(chatId, { preserveViewport: true });
      setStreamStatus("Stream error");
      setActivityChip(streamChip, "stream: error");
      return;
    }

    await consumeStreamResponse(chatId, response, builtReplyRef, {
      fallbackTraceEvent: "stream-fallback-patch",
    });
  } catch (error) {
    if (error?.name === "AbortError") {
      wasAborted = true;
      return;
    }
    setStreamPhase(chatId, STREAM_PHASES.ERROR);
    finalizeInlineToolTrace(chatId);
    updatePendingAssistant(chatId, `Network failure: ${error.message}`, false);
    markStreamUpdate(chatId);
    syncActiveMessageView(chatId, { preserveViewport: true });
    setStreamStatus("Network failure");
    setActivityChip(streamChip, "stream: network failure");
  } finally {
    await finalizeStreamLifecycle(chatId, streamController, { wasAborted });
  }
}

async function resumePendingChatStream(chatId, { force = false } = {}) {
  const key = Number(chatId);
  if (!key || !isAuthenticated) return;
  const hasLiveController = hasLiveStreamController(key);
  if (hasLiveController && !force) return;
  if (!Boolean(chats.get(key)?.pending)) return;

  if (force && hasLiveController) {
    const existingController = streamAbortControllers.get(key);
    if (existingController) {
      try {
        existingController.abort();
      } catch {
        // best effort
      }
    }
  }

  pendingChats.add(key);
  if (chats.has(key)) {
    chats.get(key).pending = true;
  }
  setStreamPhase(key, STREAM_PHASES.PENDING_TOOL);
  syncClosingConfirmation();
  renderTabs();
  updateComposerState();

  if (Number(activeChatId) === key) {
    setStreamStatus(`Reconnecting stream in ${chatLabel(key)}...`);
    setActivityChip(streamChip, `stream: reconnecting · ${compactChatLabel(key)}`);
    setActivityChip(latencyChip, "latency: recalculating...");
    setChatLatency(key, "recalculating...");
  }

  const builtReplyRef = { value: "" };
  let wasAborted = false;
  const streamController = new AbortController();
  setStreamAbortController(key, streamController);

  try {
    const response = await fetch("/api/chat/stream/resume", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(authPayload({ chat_id: key })),
      signal: streamController.signal,
    });

    if (!response.ok || !response.body) {
      const fallback = await response.text();
      throw new Error(fallback || `Resume failed: ${response.status}`);
    }

    await consumeStreamResponse(key, response, builtReplyRef, {
      fallbackTraceEvent: "stream-resume-fallback-patch",
    });
  } catch (error) {
    if (error?.name === "AbortError") {
      wasAborted = true;
      return;
    }
    setStreamPhase(key, STREAM_PHASES.ERROR);
    finalizeInlineToolTrace(key);
    appendSystemMessage(`Stream reconnect failed for '${chatLabel(key)}': ${error.message}`);
    if (Number(activeChatId) === key) {
      setStreamStatus("Stream reconnect failed");
      setActivityChip(streamChip, "stream: reconnect failed");
    }
  } finally {
    await finalizeStreamLifecycle(key, streamController, { wasAborted });
  }
}

function reportUiError(error) {
  appendSystemMessage(error?.message || "Action failed");
}

async function submitPromptFromComposer() {
  await sendPrompt(promptEl.value);
}

const submitPromptWithUiError = async () => {
  try {
    await submitPromptFromComposer();
  } catch (error) {
    reportUiError(error);
  }
};

form.addEventListener("submit", (event) => {
  event.preventDefault();
  void submitPromptWithUiError();
});

promptEl.addEventListener("keydown", (event) => {
  if (event.isComposing) return;

  // On coarse-pointer/mobile keyboards, Enter should always insert a newline.
  // Telegram/iOS modifier reporting is inconsistent (e.g. shift double-tap/caps-lock),
  // which can accidentally flip shiftKey=false and trigger unwanted sends.
  if (mobileQuoteMode) {
    return;
  }

  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    void submitPromptWithUiError();
  }
});

promptEl.addEventListener("input", () => {
  if (!activeChatId) return;
  setDraft(activeChatId, promptEl.value || "");
});

function quoteSelectionTextForInsert() {
  const picked = mobileQuoteMode ? activeSelectionQuote() : null;
  return mobileQuoteMode ? (picked?.text || selectionQuoteState.getText()) : selectionQuoteState.getText();
}

function hasMessageSelection(selection) {
  const hasSelection = Boolean(selection && selection.rangeCount >= 1 && !selection.isCollapsed);
  return Boolean(hasSelection && messagesEl.contains(selection.anchorNode || null));
}

const selectionQuoteController = {
  handleQuoteButtonClick() {
    const textToQuote = quoteSelectionTextForInsert();
    if (!textToQuote) return;
    cancelSelectionQuoteSync();
    cancelSelectionQuoteSettle();
    cancelSelectionQuoteClear();
    applyQuoteIntoPrompt(textToQuote);
    window.getSelection?.()?.removeAllRanges?.();
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
    const active = document.activeElement;
    if (active === promptEl) {
      return;
    }

    const selection = document.getSelection?.();
    const inMessages = hasMessageSelection(selection);

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
    document.addEventListener("selectionchange", () => this.handleDocumentSelectionChange());
    document.addEventListener("touchstart", (event) => this.handleDocumentTouchStart(event));
  },
};

function copyTextFromMessageButton(copyButton) {
  const messageNode = copyButton.closest(".message");
  const bodyNode = messageNode?.querySelector(".message__body");
  const rawText = bodyNode?.innerText || bodyNode?.textContent || "";
  return normalizeQuoteSelection(rawText);
}

function setCopyButtonFeedback(copyButton, copied) {
  copyButton.classList.remove("is-copied", "is-error");
  copyButton.textContent = copied ? "✓" : "!";
  copyButton.setAttribute("aria-label", copied ? "Copied" : "Copy failed");
  copyButton.title = copied ? "Copied" : "Copy failed";
  copyButton.classList.add(copied ? "is-copied" : "is-error");
}

function resetCopyButtonFeedback(copyButton) {
  copyButton.classList.remove("is-copied", "is-error");
  copyButton.textContent = "⧉";
  copyButton.setAttribute("aria-label", "Copy message");
  copyButton.title = "Copy message";
}

async function handleMessageCopy(event) {
  const copyButton = event.target.closest(".message__copy");
  if (!copyButton || !messagesEl.contains(copyButton)) return;

  event.preventDefault();
  event.stopPropagation();

  const now = Date.now();
  if (messageCopyState.wasHandledRecently(copyButton, now)) {
    return;
  }
  messageCopyState.markHandled(copyButton, now);

  const copyText = copyTextFromMessageButton(copyButton);
  const copied = await copyTextToClipboard(copyText);

  setCopyButtonFeedback(copyButton, copied);
  messageCopyState.scheduleReset(copyButton, copied ? 1200 : 1600, () => {
    resetCopyButtonFeedback(copyButton);
  });
}

// Use click (not pointerdown) for clipboard writes.
// Some Telegram WebView variants reject clipboard operations on pointerdown
// but allow them on click as a trusted user activation.
messagesEl.addEventListener("click", handleMessageCopy);
selectionQuoteController.bind();

function getOrderedChatIds() {
  return [...chats.values()]
    .map((chat) => Number(chat?.id || 0))
    .filter((id) => Number.isInteger(id) && id > 0)
    .sort((a, b) => a - b);
}

function handleTabClick(event) {
  const tab = event.target.closest(".chat-tab");
  if (!tab) return;
  const chatId = Number(tab.dataset.chatId);
  if (!chatId || chatId === Number(activeChatId)) return;
  void openChat(chatId);
}

function handlePinnedChatClick(event) {
  const item = event.target.closest(".pinned-chat-item");
  if (!item) return;
  const chatId = Number(item.dataset.chatId);
  if (!chatId) return;
  if (chatId === Number(activeChatId) && chats.has(chatId)) return;
  void openPinnedChat(chatId);
}

function isTextEntryElement(element) {
  if (!element || !(element instanceof Element)) return false;
  const tag = String(element.tagName || "").toLowerCase();
  if (tag === "textarea" || tag === "input" || tag === "select") return true;
  return Boolean(element.closest("[contenteditable='true']"));
}

function handleGlobalTabCycle(event) {
  if (event.defaultPrevented) return;
  if (event.isComposing) return;
  if (event.key !== "Tab") return;
  if (event.altKey || event.ctrlKey || event.metaKey) return;
  if (mobileQuoteMode) return;
  if (settingsModal?.open) return;

  const target = event.target;
  if (isTextEntryElement(target) && target !== promptEl) {
    return;
  }

  const current = Number(activeChatId);
  if (!current) return;

  const nextChatId = runtimeHelpers.getNextChatTabId({
    orderedChatIds: getOrderedChatIds(),
    activeChatId: current,
    reverse: Boolean(event.shiftKey),
  });
  if (!nextChatId || nextChatId === current) return;

  event.preventDefault();
  void openChat(nextChatId);
}

function isDesktopViewport() {
  try {
    if (window.matchMedia?.("(min-width: 861px)")?.matches) {
      return true;
    }
  } catch {
    // Fallback below.
  }
  return Number(window.innerWidth || 0) >= 861;
}

function handleGlobalArrowJump(event) {
  if (event.defaultPrevented) return;
  if (event.isComposing) return;
  if (event.altKey || event.ctrlKey || event.metaKey) return;
  if (mobileQuoteMode || !isDesktopViewport()) return;
  if (settingsModal?.open) return;

  const target = event.target;
  if (isTextEntryElement(target)) return;

  if (!event.shiftKey) return;

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
}

function handleMessagesScroll() {
  cancelSelectionQuoteSync();
  cancelSelectionQuoteSettle();
  cancelSelectionQuoteClear();
  clearSelectionQuoteState();
  const key = Number(activeChatId);
  if (!key || Number(renderedChatId) !== key) return;
  const atBottom = isNearBottom(messagesEl, 40);
  chatScrollTop.set(key, messagesEl.scrollTop);
  chatStickToBottom.set(key, atBottom);
  if (atBottom) {
    unseenStreamChats.delete(key);
    refreshTabNode(key);
    maybeMarkRead(key);
  }
  updateJumpLatestVisibility();

  const historyLength = (histories.get(key) || []).length;
  if (shouldVirtualizeHistory(historyLength)) {
    scheduleActiveMessageView(key);
  }
}

function handleJumpLatest() {
  const key = Number(activeChatId);
  if (!key) return;
  unseenStreamChats.delete(key);
  refreshTabNode(key);
  syncActiveMessageView(key, { forceBottom: true });
  maybeMarkRead(key, { force: true });
  updateJumpLatestVisibility();
}

function handleJumpLastStart() {
  const key = Number(activeChatId);
  if (!key) return;
  const renderedMessages = messagesEl.querySelectorAll(".message");
  const lastRenderedMessage = renderedMessages[renderedMessages.length - 1];
  if (!lastRenderedMessage) return;

  messagesEl.scrollTop = Math.max(0, Number(lastRenderedMessage.offsetTop));
  chatScrollTop.set(key, messagesEl.scrollTop);
  chatStickToBottom.set(key, isNearBottom(messagesEl, 40));
  updateJumpLatestVisibility();
}

tabsEl.addEventListener("click", handleTabClick);
pinnedChatsEl?.addEventListener("click", handlePinnedChatClick);
document.addEventListener("keydown", handleGlobalTabCycle);
document.addEventListener("keydown", handleGlobalArrowJump);
messagesEl.addEventListener("scroll", handleMessagesScroll);
jumpLatestButton?.addEventListener("click", handleJumpLatest);
jumpLastStartButton?.addEventListener("click", handleJumpLastStart);

function bindAsyncClick(button, action) {
  button?.addEventListener("click", () => {
    void (async () => {
      try {
        await action();
      } catch (error) {
        reportUiError(error);
      }
    })();
  });
}

skinButtons.forEach((button) => {
  bindAsyncClick(button, async () => {
    if (!isAuthenticated) {
      appendSystemMessage("Still signing you in. Try again in a moment.");
      return;
    }
    await saveSkinPreference(button.dataset.skin);
    closeSettingsModal();
  });
});

bindAsyncClick(newChatButton, createChat);
bindAsyncClick(renameChatButton, renameActiveChat);
bindAsyncClick(pinChatButton, toggleActiveChatPin);
bindAsyncClick(removeChatButton, removeActiveChat);

function syncFullscreenControlState() {
  if (!fullscreenAppTopButton) return;
  const isFullscreen = Boolean(tg?.isFullscreen);
  fullscreenAppTopButton.textContent = isFullscreen ? "🗗" : "⛶";
  fullscreenAppTopButton.title = isFullscreen ? "Exit fullscreen" : "Enter fullscreen";
}

function handleFullscreenToggle() {
  try {
    if (!tg?.requestFullscreen) {
      appendSystemMessage("Fullscreen is not supported by this Telegram client.");
      return;
    }

    const isFullscreen = Boolean(tg?.isFullscreen);
    if (isFullscreen && tg?.exitFullscreen) {
      tg.exitFullscreen();
    } else {
      tg.requestFullscreen();
    }

    setTimeout(syncFullscreenControlState, 120);
  } catch {
    appendSystemMessage("Fullscreen toggle failed on this Telegram client.");
  }
}

function handleCloseApp() {
  try {
    if (!tg?.close) {
      appendSystemMessage("Close action is not available on this Telegram client.");
      return;
    }
    tg.close();
  } catch {
    appendSystemMessage("Close action is not available on this Telegram client.");
  }
}

function openSettingsModal() {
  if (!settingsModal) return;
  if (settingsModal.showModal) {
    settingsModal.showModal();
    return;
  }
  settingsModal.setAttribute("open", "open");
}

function closeSettingsModal() {
  if (!settingsModal) return;
  if (settingsModal.close) {
    settingsModal.close();
    return;
  }
  settingsModal.removeAttribute("open");
}

function ensureComposerVisible({ smooth = false } = {}) {
  if (!promptEl || !form) return;

  const behavior = smooth ? "smooth" : "auto";
  // Bring the full composer into view (not just the caret line).
  form.scrollIntoView({ block: "end", inline: "nearest", behavior });

  // Telegram keyboard animations can move the visual viewport while focused.
  // Keep the actual text input box within the visible viewport bounds.
  const viewport = window.visualViewport;
  const viewportTop = Number(viewport?.offsetTop || 0);
  const viewportBottom = viewport
    ? Number(viewport.offsetTop + viewport.height)
    : Number(window.innerHeight || 0);

  if (viewportBottom > viewportTop) {
    const rect = promptEl.getBoundingClientRect();
    const topSafe = viewportTop + 8;
    const bottomSafe = viewportBottom - 10;

    if (rect.bottom > bottomSafe) {
      const deltaDown = rect.bottom - bottomSafe;
      window.scrollBy({ top: deltaDown, left: 0, behavior: "auto" });
    } else if (rect.top < topSafe) {
      const deltaUp = rect.top - topSafe;
      window.scrollBy({ top: deltaUp, left: 0, behavior: "auto" });
    }
  }
}

function dismissKeyboard() {
  const activeEl = document.activeElement;
  if (activeEl && (activeEl === promptEl || activeEl.tagName === "TEXTAREA" || activeEl.tagName === "INPUT")) {
    activeEl.blur();
  }
}

function installTapToDismissKeyboard() {
  const dismissTargets = [messagesEl, tabsEl, toolStreamEl, document.querySelector(".masthead"), document.querySelector(".sidebar")]
    .filter(Boolean);

  dismissTargets.forEach((target) => {
    // Mobile text selection in the message pane can become unstable if we blur on every touchstart.
    const skipTouchDismiss = mobileQuoteMode && target === messagesEl;
    if (!skipTouchDismiss) {
      target.addEventListener("touchstart", dismissKeyboard, { passive: true });
    }
    target.addEventListener("click", dismissKeyboard);
  });
}

function installKeyboardViewportSync() {
  if (!promptEl) return;

  let focusSyncIntervalId = null;
  let keyboardSyncUntil = 0;

  const isPromptFocused = () => document.activeElement === promptEl;

  const armSyncWindow = (durationMs = 1400) => {
    keyboardSyncUntil = Date.now() + durationMs;
  };

  const isWithinSyncWindow = () => Date.now() <= keyboardSyncUntil;

  const runSyncBurst = () => {
    // Immediate pass + staggered follow-ups to track keyboard slide-in/settle.
    ensureComposerVisible({ smooth: false });
    requestAnimationFrame(() => ensureComposerVisible({ smooth: false }));
    setTimeout(() => ensureComposerVisible({ smooth: false }), 90);
    setTimeout(() => ensureComposerVisible({ smooth: false }), 220);
    setTimeout(() => ensureComposerVisible({ smooth: false }), 420);
    setTimeout(() => ensureComposerVisible({ smooth: false }), 700);
    setTimeout(() => ensureComposerVisible({ smooth: false }), 1000);
  };

  const stopFocusIntervalSync = () => {
    if (!focusSyncIntervalId) return;
    window.clearInterval(focusSyncIntervalId);
    focusSyncIntervalId = null;
  };

  const startFocusIntervalSync = () => {
    if (focusSyncIntervalId) return;
    focusSyncIntervalId = window.setInterval(() => {
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

  // Fire before focus to reduce perceived lag when keyboard appears.
  promptEl.addEventListener("touchstart", primeBeforeFocus, { passive: true });
  promptEl.addEventListener("mousedown", primeBeforeFocus);

  const focusSync = () => {
    armSyncWindow();
    runSyncBurst();
    startFocusIntervalSync();
  };

  promptEl.addEventListener("focus", focusSync);
  promptEl.addEventListener("blur", () => {
    keyboardSyncUntil = 0;
    stopFocusIntervalSync();
  });

  const onViewportShift = () => {
    if (!isPromptFocused()) return;
    if (!isWithinSyncWindow()) return;
    ensureComposerVisible({ smooth: false });
  };

  if (window.visualViewport) {
    window.visualViewport.addEventListener("resize", onViewportShift);
    window.visualViewport.addEventListener("scroll", onViewportShift);
  }

  window.addEventListener("resize", onViewportShift);
  tg?.onEvent?.("viewportChanged", onViewportShift);
}

fullscreenAppTopButton?.addEventListener("click", handleFullscreenToggle);
closeAppTopButton?.addEventListener("click", handleCloseApp);
renderTraceBadge?.addEventListener("click", handleRenderTraceBadgeClick);
settingsButton?.addEventListener("click", openSettingsModal);
settingsClose?.addEventListener("click", closeSettingsModal);
settingsModal?.addEventListener?.("cancel", (event) => {
  event.preventDefault();
  closeSettingsModal();
});

async function syncVisibleActiveChat() {
  if (!activeChatId) return;
  const activeId = Number(activeChatId);
  maybeMarkRead(activeId);
  const data = await loadChatHistory(activeId, { activate: true });
  const previousHistory = histories.get(activeId) || [];
  const nextHistory = runtimeHelpers.mergeHydratedHistory({
    previousHistory,
    nextHistory: data.history || [],
    chatPending: Boolean(data.chat?.pending),
  });
  histories.set(activeId, nextHistory);
  upsertChat(data.chat);
  renderMessages(activeId, { preserveViewport: true });
  const needsVisibilityResume = runtimeHelpers.shouldResumeOnVisibilityChange({
    hidden: document.visibilityState !== "visible",
    activeChatId: activeId,
    pendingChats,
    streamAbortControllers,
  });
  const serverPendingWithoutLiveStream = Boolean(data.chat?.pending) && !hasLiveStreamController(activeId);
  if (needsVisibilityResume || serverPendingWithoutLiveStream) {
    void resumePendingChatStream(activeId);
  }
}

async function handleVisibilityChange() {
  if (document.visibilityState !== "visible") return;
  syncSkinFromStorage();
  if (!isAuthenticated) return;

  const activeId = Number(activeChatId);
  if (activeId > 0) {
    // Visibility changes are a common point where throttled UI work catches up.
    // Force an immediate reconciliation from canonical history for the active chat.
    syncActiveMessageView(activeId, { preserveViewport: true });
  }

  try {
    await refreshChats();
    await syncVisibleActiveChat();
  } catch {
    // best effort sync
  }
}

document.addEventListener("visibilitychange", () => {
  void handleVisibilityChange();
});

window.addEventListener("focus", () => {
  syncSkinFromStorage();
});

window.addEventListener("storage", (event) => {
  if (event.key !== SKIN_STORAGE_KEY) return;
  const nextSkin = normalizeSkin(event.newValue);
  if (!nextSkin || nextSkin === currentSkin) return;
  setSkin(nextSkin, { persist: false, broadcast: false });
});

skinSyncChannel?.addEventListener?.("message", (event) => {
  const payload = event?.data;
  if (!payload || payload.type !== "skin") return;
  const nextSkin = normalizeSkin(payload.skin);
  if (!nextSkin || nextSkin === currentSkin) return;
  setSkin(nextSkin, { persist: true, broadcast: false });
});

startDevAutoRefresh();
installTapToDismissKeyboard();
installKeyboardViewportSync();
void bootstrap();
