const tg = window.Telegram?.WebApp;
const devConfig = window.__HERMES_DEV__ || { enabled: false, reloadStateUrl: "/dev/reload-state", intervalMs: 1200, version: "" };
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
const bootSkin = document.documentElement?.getAttribute("data-skin") || window.__HERMES_SKIN_BOOT__ || "terminal";
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
const fullscreenAppTopButton = document.getElementById("fullscreen-app-top");
const closeAppTopButton = document.getElementById("close-app-top");
const settingsButton = document.getElementById("settings-button");
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
const histories = new Map();
const pendingChats = new Set();
const prefetchingHistories = new Set();
const tabNodes = new Map();
const chatScrollTop = new Map();
const chatStickToBottom = new Map();
const virtualizationRanges = new Map();
const virtualMetrics = new Map();
const unseenStreamChats = new Set();
const markReadInFlight = new Set();
const VIRTUALIZE_THRESHOLD = 220;
const ESTIMATED_MESSAGE_HEIGHT = 108;
const VIRTUAL_OVERSCAN = 18;
let renderedChatId = null;
let lastOpenChatRequestId = 0;
let activeRenderScheduled = false;
let activeRenderChatId = null;
let selectionQuoteText = "";
let selectionQuoteSyncTimer = null;
let selectionQuoteClearTimer = null;
let selectionQuoteSettleTimer = null;
let mobileQuotePlacementKey = "";
const mobileQuoteMode = isCoarsePointer();
const draftByChat = new Map();
const DRAFT_STORAGE_KEY = "hermes_miniapp_chat_drafts_v1";
let lastInAppHapticAt = 0;


const MESSAGE_TIMEZONE = "America/Regina";
const REGINA_FIXED_OFFSET_MINUTES = -6 * 60;

function buildMessageTimeFormatter() {
  try {
    const formatter = new Intl.DateTimeFormat([], {
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
      timeZone: MESSAGE_TIMEZONE,
    });
    const resolvedZone = formatter.resolvedOptions?.().timeZone;
    return { formatter, supportsReginaZone: resolvedZone === MESSAGE_TIMEZONE };
  } catch {
    return { formatter: null, supportsReginaZone: false };
  }
}

const { formatter: messageTimeFormatter, supportsReginaZone } = buildMessageTimeFormatter();

function parseMessageTimestamp(rawValue) {
  if (!rawValue) return null;
  const value = String(rawValue).trim();
  if (!value) return null;

  const match = value.match(
    /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,6}))?)?(?:\s*(Z|[+-]\d{2}:?\d{2}))?$/i,
  );
  if (match) {
    const [, year, month, day, hour, minute, second = "00", fraction = "", rawTz = ""] = match;
    const millis = Number((fraction || "").slice(0, 3).padEnd(3, "0"));
    let epochMs = Date.UTC(
      Number(year),
      Number(month) - 1,
      Number(day),
      Number(hour),
      Number(minute),
      Number(second),
      millis,
    );

    if (rawTz && rawTz.toUpperCase() !== "Z") {
      const tz = rawTz.replace(":", "");
      const sign = tz.startsWith("-") ? -1 : 1;
      const tzHours = Number(tz.slice(1, 3));
      const tzMinutes = Number(tz.slice(3, 5));
      const offsetMinutes = sign * ((tzHours * 60) + tzMinutes);
      epochMs -= offsetMinutes * 60_000;
    }

    // No timezone in DB values means SQLite CURRENT_TIMESTAMP in UTC.
    return new Date(epochMs);
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed;
}

function formatReginaTimeFallback(date) {
  const shifted = new Date(date.getTime() + (REGINA_FIXED_OFFSET_MINUTES * 60_000));
  const hours = String(shifted.getUTCHours()).padStart(2, "0");
  const minutes = String(shifted.getUTCMinutes()).padStart(2, "0");
  return `${hours}:${minutes}`;
}

function formatMessageTime(rawValue) {
  const parsed = parseMessageTimestamp(rawValue) || new Date();
  if (messageTimeFormatter && supportsReginaZone) {
    return messageTimeFormatter.format(parsed);
  }
  return formatReginaTimeFallback(parsed);
}

function nowStamp() {
  return formatMessageTime(new Date().toISOString());
}

function formatLatency(msValue) {
  const ms = Number(msValue);
  if (!Number.isFinite(ms) || ms < 0) return "--";
  if (ms < 1000) return `${Math.round(ms)} ms`;

  const totalSeconds = Math.round(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
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

function triggerInAppReplyHaptic(chatId) {
  if (!mobileQuoteMode) return;
  if (Number(activeChatId) !== Number(chatId)) return;

  const now = Date.now();
  const minGapMs = 600;
  if ((now - lastInAppHapticAt) < minGapMs) return;
  lastInAppHapticAt = now;

  try {
    tg?.HapticFeedback?.notificationOccurred?.("success");
    return;
  } catch {
    // Telegram client rejected notification-style haptic; try fallback.
  }

  try {
    tg?.HapticFeedback?.impactOccurred?.("light");
  } catch {
    // Best-effort haptics only.
  }
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
  if (pendingChats.size > 0) {
    tg.enableClosingConfirmation();
    return;
  }
  tg.disableClosingConfirmation();
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

function parseSseEvent(rawEvent) {
  const lines = rawEvent.split("\n");
  const eventName = lines.find((line) => line.startsWith("event:"))?.slice(6).trim() || "message";
  const dataLines = lines
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trim());

  if (!dataLines.length) {
    return { eventName, payload: null };
  }

  const mergedData = dataLines.join("\n");
  try {
    return { eventName, payload: JSON.parse(mergedData) };
  } catch {
    return { eventName, payload: { text: mergedData } };
  }
}

function incrementUnread(chatId) {
  const key = Number(chatId);
  if (!chats.has(key)) return;
  const chat = chats.get(key);
  chat.unread_count = Number(chat.unread_count || 0) + 1;
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

function toToolTraceRawText(payload) {
  if (!payload || typeof payload !== "object") return "";
  try {
    return JSON.stringify(payload, null, 2);
  } catch {
    return "";
  }
}

function normalizeToolTraceEntry(rawEntry) {
  if (!rawEntry || typeof rawEntry !== "object") {
    const summary = String(rawEntry || "").trim();
    return summary ? { summary, details: [], raw: "", expanded: false } : null;
  }

  const summary = String(rawEntry.display || rawEntry.preview || rawEntry.tool_name || "Tool running").trim();
  if (!summary) return null;

  const details = [];
  const toolName = String(rawEntry.tool_name || "").trim();
  const preview = String(rawEntry.preview || "").trim();
  if (toolName) details.push(`Tool: ${toolName}`);
  if (preview) details.push(`Preview: ${preview}`);

  if (rawEntry.args && typeof rawEntry.args === "object" && Object.keys(rawEntry.args).length > 0) {
    try {
      details.push(`Args: ${JSON.stringify(rawEntry.args)}`);
    } catch {
      details.push("Args: [unserializable]");
    }
  }

  const excluded = new Set(["display", "preview", "tool_name", "args", "chat_id"]);
  const extraKeys = Object.keys(rawEntry).filter((key) => !excluded.has(key));
  for (const key of extraKeys) {
    const value = rawEntry[key];
    if (value === undefined || value === null || value === "") continue;
    if (typeof value === "object") {
      try {
        details.push(`${key}: ${JSON.stringify(value)}`);
      } catch {
        details.push(`${key}: [unserializable]`);
      }
    } else {
      details.push(`${key}: ${String(value)}`);
    }
  }

  return {
    summary,
    details,
    raw: toToolTraceRawText(rawEntry),
    expanded: false,
    rawExpanded: false,
  };
}

function appendInlineToolTrace(chatId, entryOrText) {
  const entry = normalizeToolTraceEntry(entryOrText);
  if (!entry) return;
  const line = String(entry.summary || "").trim();
  if (!line) return;

  const key = Number(chatId);
  const trace = ensurePendingToolTraceMessage(key);
  trace.body = trace.body ? `${trace.body}\n${line}` : line;
  if (!Array.isArray(trace.tool_entries)) {
    trace.tool_entries = [];
  }
  trace.tool_entries.push(entry);
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

function escapeHtml(input) {
  return (input || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function cleanDisplayText(rawText) {
  const text = String(rawText || "");
  const lines = text.split("\n");
  const kept = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (/^session_id\s*:/i.test(trimmed)) continue;
    if (/^\d{8}_\d{6}_[a-z0-9]+$/i.test(trimmed)) continue;
    kept.push(line);
  }

  return kept.join("\n").replace(/\n{3,}/g, "\n\n").trim();
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

function legacyCopyTextToClipboard(text) {
  const selection = window.getSelection?.();
  const previousRanges = [];
  if (selection && selection.rangeCount > 0) {
    for (let index = 0; index < selection.rangeCount; index += 1) {
      previousRanges.push(selection.getRangeAt(index).cloneRange());
    }
  }

  const restoreSelection = () => {
    if (!selection) return;
    try {
      selection.removeAllRanges();
      for (const range of previousRanges) {
        selection.addRange(range);
      }
    } catch {
      // Selection restoration is best-effort only.
    }
  };

  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  textarea.style.pointerEvents = "none";
  // Keep the element in-viewport for iOS/WebView copy reliability.
  textarea.style.left = "0";
  textarea.style.top = "0";
  textarea.style.width = "1px";
  textarea.style.height = "1px";

  let copied = false;
  try {
    document.body.appendChild(textarea);
    textarea.focus();
    textarea.select();
    textarea.setSelectionRange(0, textarea.value.length);
    copied = document.execCommand("copy");
  } catch {
    copied = false;
  } finally {
    textarea.remove();
  }

  if (!copied) {
    // Some iOS/WebView variants are unreliable with textarea selection but
    // work with a contenteditable element and explicit range selection.
    const probe = document.createElement("div");
    probe.textContent = text;
    probe.setAttribute("contenteditable", "true");
    probe.style.position = "fixed";
    probe.style.opacity = "0";
    probe.style.pointerEvents = "none";
    probe.style.left = "0";
    probe.style.top = "0";
    probe.style.whiteSpace = "pre-wrap";

    try {
      document.body.appendChild(probe);
      const range = document.createRange();
      range.selectNodeContents(probe);
      selection?.removeAllRanges?.();
      selection?.addRange?.(range);
      copied = document.execCommand("copy");
    } catch {
      copied = false;
    } finally {
      probe.remove();
    }
  }

  restoreSelection();
  return copied;
}

async function copyTextToClipboard(rawText) {
  const text = String(rawText || "");
  if (!text) return false;

  // Try legacy copy first while still inside the direct pointer gesture.
  if (legacyCopyTextToClipboard(text)) {
    return true;
  }

  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      return false;
    }
  }

  return false;
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
  selectionQuoteText = "";
  mobileQuotePlacementKey = "";
  if (selectionQuoteButton) {
    selectionQuoteButton.hidden = true;
  }
}

function cancelSelectionQuoteSync() {
  if (selectionQuoteSyncTimer) {
    window.clearTimeout(selectionQuoteSyncTimer);
    selectionQuoteSyncTimer = null;
  }
}

function cancelSelectionQuoteSettle() {
  if (selectionQuoteSettleTimer) {
    window.clearTimeout(selectionQuoteSettleTimer);
    selectionQuoteSettleTimer = null;
  }
}

function cancelSelectionQuoteClear() {
  if (selectionQuoteClearTimer) {
    window.clearTimeout(selectionQuoteClearTimer);
    selectionQuoteClearTimer = null;
  }
}

function scheduleSelectionQuoteClear(delayMs = 380) {
  cancelSelectionQuoteClear();
  selectionQuoteClearTimer = window.setTimeout(() => {
    selectionQuoteClearTimer = null;
    const picked = activeSelectionQuote();
    if (!picked) {
      clearSelectionQuoteState();
    }
  }, Math.max(0, Number(delayMs) || 0));
}

function scheduleSelectionQuoteSync(delayMs = 120) {
  cancelSelectionQuoteSync();
  cancelSelectionQuoteSettle();
  selectionQuoteSyncTimer = window.setTimeout(() => {
    selectionQuoteSyncTimer = null;
    syncSelectionQuoteAction();
  }, Math.max(0, Number(delayMs) || 0));
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
  if (mobileQuoteMode && lockPlacement && !selectionQuoteButton.hidden && mobileQuotePlacementKey === placementKey) {
    selectionQuoteText = text;
    return;
  }

  selectionQuoteText = text;
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
    // Keep the popup farther from iOS/Telegram selection handles so taps don't collide.
    const selectionHandleClearance = 56;
    const belowSelection = rect.bottom + selectionHandleClearance;
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
    mobileQuotePlacementKey = placementKey;
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
  if (!selectionQuoteButton.hidden && mobileQuotePlacementKey === firstKey) {
    selectionQuoteText = firstPick.text;
    return;
  }

  cancelSelectionQuoteSettle();
  selectionQuoteSettleTimer = window.setTimeout(() => {
    selectionQuoteSettleTimer = null;
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
  }, 110);
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

function parseToolTraceLine(line) {
  const text = String(line || "").trim();
  if (!text) return null;

  // Expected line style from _format_tool_progress:
  // "🧠 memory: \"preview\""
  // "⚙️ tool_name..."
  const lineMatch = text.match(/^([\p{Emoji}\u200D\uFE0F]+\s+)?([a-zA-Z0-9_.-]+)(?::\s*"([\s\S]*)"|\.\.\.)?$/u);
  if (!lineMatch) {
    return {
      summary: text,
      details: ["Captured from stored tool trace."],
      raw: text,
      expanded: false,
      rawExpanded: false,
    };
  }

  const emoji = String(lineMatch[1] || "").trim();
  const toolName = String(lineMatch[2] || "").trim();
  const preview = lineMatch[3] != null ? String(lineMatch[3]) : "";
  const details = ["Captured from stored tool trace."];
  if (emoji) details.push(`Icon: ${emoji}`);
  if (toolName) details.push(`Tool: ${toolName}`);
  if (preview) {
    details.push(`Preview: ${preview}`);
    if (preview.endsWith("...")) {
      details.push("Preview may be truncated by runtime formatter.");
    }
  }

  return {
    summary: text,
    details,
    raw: text,
    expanded: false,
    rawExpanded: false,
  };
}

function getToolTraceEntriesForMessage(message, lines) {
  if (Array.isArray(message.tool_entries) && message.tool_entries.length) {
    return message.tool_entries;
  }

  const fallback = (lines || [])
    .map((line) => parseToolTraceLine(line))
    .filter(Boolean);
  message.tool_entries = fallback;
  return fallback;
}

function renderToolTraceBody(container, message) {
  container.innerHTML = "";
  const text = cleanDisplayText(message.body || "");
  const lines = text ? text.split("\n").map((line) => line.trim()).filter(Boolean) : [];
  if (!lines.length && !message.pending) {
    return;
  }

  const entries = getToolTraceEntriesForMessage(message, lines);

  const details = document.createElement("details");
  details.className = "tool-trace";
  const collapsed = typeof message.collapsed === "boolean" ? message.collapsed : !message.pending;
  details.open = !collapsed;

  const summary = document.createElement("summary");
  const lineCount = entries.length;
  const liveSuffix = message.pending ? " · live" : "";
  summary.textContent = `Tool activity (${lineCount})${liveSuffix}`;
  details.appendChild(summary);

  const list = document.createElement("div");
  list.className = "tool-trace__lines";
  if (entries.length) {
    for (const entry of entries) {
      const row = document.createElement("details");
      row.className = "tool-trace__entry";
      row.open = Boolean(entry.expanded);

      const rowSummary = document.createElement("summary");
      rowSummary.className = "tool-trace__line";
      rowSummary.textContent = String(entry.summary || "Tool event");
      row.appendChild(rowSummary);

      const hasDetails = Array.isArray(entry.details) && entry.details.length > 0;
      const hasRaw = Boolean(String(entry.raw || "").trim());
      if (hasDetails || hasRaw) {
        const rowDetails = document.createElement("div");
        rowDetails.className = "tool-trace__entry-body";

        if (hasDetails) {
          for (const detailLine of entry.details) {
            const detail = document.createElement("div");
            detail.className = "tool-trace__detail";
            detail.textContent = String(detailLine || "");
            rowDetails.appendChild(detail);
          }
        }

        if (hasRaw) {
          const rawDetails = document.createElement("details");
          rawDetails.className = "tool-trace__raw";
          rawDetails.open = Boolean(entry.rawExpanded);

          const rawSummary = document.createElement("summary");
          rawSummary.textContent = "Show raw";
          rawDetails.appendChild(rawSummary);

          const rawPre = document.createElement("pre");
          rawPre.className = "tool-trace__raw-pre";
          rawPre.textContent = String(entry.raw || "");
          rawDetails.appendChild(rawPre);

          rawDetails.addEventListener("toggle", () => {
            entry.rawExpanded = rawDetails.open;
          });

          rowDetails.appendChild(rawDetails);
        }

        row.appendChild(rowDetails);
      }

      row.addEventListener("toggle", () => {
        entry.expanded = row.open;
      });

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

function createMessageNode(message) {
  const renderedBody = cleanDisplayText(message.body || (message.pending ? "…" : ""));
  if (!renderedBody && !message.pending && message.role !== "tool") {
    return null;
  }

  const node = template.content.firstElementChild.cloneNode(true);
  const role = String(message.role || "").toLowerCase();
  const variant = (role === "operator" || role === "user")
    ? "operator"
    : (role === "hermes" || role === "assistant")
      ? "assistant"
      : role === "tool"
        ? "tool"
        : "system";
  node.classList.add(`message--${variant}`);
  if (message.pending) {
    node.classList.add("message--pending");
  }
  node.dataset.role = String(message.role || "").toLowerCase();
  node.querySelector(".message__role").textContent = roleLabelForMessage(message);
  node.querySelector(".message__time").textContent = formatMessageTime(message.created_at);

  const bodyNode = node.querySelector(".message__body");
  if (message.role === "tool") {
    renderToolTraceBody(bodyNode, message);
  } else {
    renderBody(bodyNode, renderedBody);
  }
  return node;
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

function renderMessages(chatId, { preserveViewport = false, forceBottom = false } = {}) {
  const targetChatId = Number(chatId);
  const isSameRenderedChat = Number(renderedChatId) === targetChatId;
  const prevScrollTop = messagesEl.scrollTop;
  // Stable viewport policy: never auto-stick to bottom unless explicitly forced
  // (e.g. user taps the Jump to latest button).
  const shouldStick = Boolean(forceBottom);

  messagesEl.innerHTML = "";
  clearSelectionQuoteState();
  const history = histories.get(targetChatId) || [];
  const shouldVirtualize = shouldVirtualizeHistory(history.length);

  let renderStart = 0;
  let renderEnd = history.length;
  const estimatedHeight = getEstimatedMessageHeight(targetChatId);

  if (shouldVirtualize) {
    const viewportHeight = Math.max(messagesEl.clientHeight || 0, 320);
    const range = computeVirtualRange({
      total: history.length,
      scrollTop: forceBottom ? Number.MAX_SAFE_INTEGER : prevScrollTop,
      viewportHeight,
      forceBottom: forceBottom || (!preserveViewport && shouldStick),
      estimatedHeight,
    });

    renderStart = range.start;
    renderEnd = range.end;

    const topSpacer = document.createElement("div");
    topSpacer.className = "messages__spacer";
    topSpacer.style.height = `${renderStart * estimatedHeight}px`;

    const bottomSpacer = document.createElement("div");
    bottomSpacer.className = "messages__spacer";
    bottomSpacer.style.height = `${Math.max(0, history.length - renderEnd) * estimatedHeight}px`;

    messagesEl.appendChild(topSpacer);
    const fragment = document.createDocumentFragment();
    history.slice(renderStart, renderEnd).forEach((message) => {
      const node = createMessageNode(message);
      if (node) {
        fragment.appendChild(node);
      }
    });
    messagesEl.appendChild(fragment);
    messagesEl.appendChild(bottomSpacer);
    virtualizationRanges.set(targetChatId, { start: renderStart, end: renderEnd, total: history.length, estimatedHeight });
  } else {
    const fragment = document.createDocumentFragment();
    history.forEach((message) => {
      const node = createMessageNode(message);
      if (node) {
        fragment.appendChild(node);
      }
    });
    messagesEl.appendChild(fragment);
    virtualizationRanges.delete(targetChatId);
  }

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

  renderedChatId = targetChatId;
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

function upsertChat(chat) {
  chats.set(Number(chat.id), {
    ...chat,
    id: Number(chat.id),
    unread_count: Number(chat.unread_count || 0),
    pending: Boolean(chat.pending),
  });
}

function syncChats(chatList) {
  const nextIds = new Set((chatList || []).map((chat) => Number(chat.id)));
  [...chats.keys()].forEach((chatId) => {
    if (!nextIds.has(Number(chatId))) {
      chats.delete(Number(chatId));
      histories.delete(Number(chatId));
      pendingChats.delete(Number(chatId));
      prefetchingHistories.delete(Number(chatId));
      chatScrollTop.delete(Number(chatId));
      chatStickToBottom.delete(Number(chatId));
      virtualizationRanges.delete(Number(chatId));
      virtualMetrics.delete(Number(chatId));
      unseenStreamChats.delete(Number(chatId));
      const staleNode = tabNodes.get(Number(chatId));
      staleNode?.remove();
      tabNodes.delete(Number(chatId));
    }
  });
  (chatList || []).forEach(upsertChat);
}

function getOrCreateTabNode(chatId) {
  const key = Number(chatId);
  if (tabNodes.has(key)) {
    return tabNodes.get(key);
  }
  const node = tabTemplate.content.firstElementChild.cloneNode(true);
  node.dataset.chatId = String(key);
  node.setAttribute("role", "tab");
  node.setAttribute("aria-controls", "messages");
  tabNodes.set(key, node);
  return node;
}

function updateTabNode(node, chat) {
  const isActive = Number(chat.id) === Number(activeChatId);
  node.classList.toggle("is-active", isActive);
  node.setAttribute("aria-selected", isActive ? "true" : "false");
  node.querySelector(".chat-tab__title").textContent = chat.title;

  const badge = node.querySelector(".chat-tab__badge");
  const chatKey = Number(chat.id);
  const pending = pendingChats.has(chatKey) || Boolean(chat.pending);
  const unread = Number(chat.unread_count || 0);
  const hasUnseenInViewport = unseenStreamChats.has(chatKey);
  badge.classList.remove("is-visible", "is-pending", "is-unread-dot");
  badge.removeAttribute("aria-label");

  if (pending) {
    badge.textContent = "…";
    badge.classList.add("is-visible", "is-pending");
    badge.setAttribute("aria-label", "Pending response");
  } else if (unread > 0 || hasUnseenInViewport) {
    badge.textContent = "•";
    badge.classList.add("is-visible", "is-unread-dot");
    if (unread > 0) {
      badge.setAttribute("aria-label", `${unread} unread ${unread === 1 ? "message" : "messages"}`);
    } else {
      badge.setAttribute("aria-label", "New messages below current scroll position");
    }
  } else {
    badge.textContent = "";
  }
}

function renderTabs() {
  const ordered = [...chats.values()].sort((a, b) => a.id - b.id);
  const nextIds = new Set(ordered.map((chat) => Number(chat.id)));

  [...tabNodes.entries()].forEach(([chatId, node]) => {
    if (!nextIds.has(chatId)) {
      node.remove();
      tabNodes.delete(chatId);
    }
  });

  ordered.forEach((chat) => {
    const node = getOrCreateTabNode(chat.id);
    updateTabNode(node, chat);
    if (node.parentElement !== tabsEl) {
      tabsEl.appendChild(node);
    }
  });
}

function refreshTabNode(chatId) {
  const key = Number(chatId);
  if (!key) return;
  const node = tabNodes.get(key);
  const chat = chats.get(key);
  if (!node || !chat) return;
  updateTabNode(node, chat);
}

function syncActiveTabSelection(previousChatId, nextChatId) {
  const prevKey = Number(previousChatId);
  const nextKey = Number(nextChatId);
  const hasPrevNode = !prevKey || tabNodes.has(prevKey);
  const hasNextNode = !!nextKey && tabNodes.has(nextKey);

  if (!hasPrevNode || !hasNextNode) {
    renderTabs();
    return;
  }

  refreshTabNode(prevKey);
  refreshTabNode(nextKey);
}

function setSkin(skin) {
  currentSkin = skin;
  body.dataset.skin = skin;
  document.documentElement?.setAttribute("data-skin", skin);
  try {
    localStorage.setItem("hermes_skin", skin);
  } catch (_) {
    // non-fatal
  }
  skinName.textContent = skin;
  skinButtons.forEach((button) => {
    button.classList.toggle("is-active", button.dataset.skin === skin);
  });
  if (panelHint) panelHint.textContent = "";
  syncTelegramChromeForSkin(skin);
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

  if (fullTabRender) {
    renderTabs();
  } else {
    syncActiveTabSelection(previousActiveChatId, activeChatId);
  }

  const finalizeMeta = () => {
    syncActivePendingStatus();
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
  renderTabs();
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

  const nextHistory = data.history || [];
  const previousHistory = histories.get(targetChatId) || [];
  const historyChanged = historiesDiffer(previousHistory, nextHistory);
  histories.set(targetChatId, nextHistory);

  if (chats.has(targetChatId)) {
    chats.get(targetChatId).unread_count = 0;
  }
  refreshTabNode(targetChatId);

  if (Number(activeChatId) !== targetChatId) {
    setActiveChatMeta(targetChatId);
    renderMessages(targetChatId);
    return;
  }

  if (!hadCachedHistory || historyChanged) {
    renderMessages(targetChatId, { preserveViewport: hadCachedHistory });
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

function patchVisiblePendingAssistant(chatId, nextBody, pendingState = true) {
  if (Number(chatId) !== Number(activeChatId)) return false;

  const pendingNodes = messagesEl.querySelectorAll(".message--assistant.message--pending");
  const node = pendingNodes[pendingNodes.length - 1];
  if (!node) return false;

  const bodyNode = node.querySelector(".message__body");
  if (!bodyNode) return false;

  renderBody(bodyNode, nextBody || (pendingState ? "…" : ""));
  node.classList.toggle("message--pending", Boolean(pendingState));
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
}

async function removeActiveChat() {
  if (!activeChatId) return;
  if (pendingChats.has(Number(activeChatId))) {
    throw new Error("Wait for Hermes to finish before closing this chat.");
  }
  const currentChatId = Number(activeChatId);
  const ok = await confirmAction(`Close chat '${chatLabel(currentChatId)}' and remove its tab?`);
  if (!ok) return;
  const data = await apiPost("/api/chats/remove", { chat_id: currentChatId });
  syncChats(data.chats || []);
  histories.delete(Number(data.removed_chat_id));
  pendingChats.delete(Number(data.removed_chat_id));
  histories.set(Number(data.active_chat_id), data.history || []);
  upsertChat(data.active_chat);
  setActiveChatMeta(data.active_chat_id);
  renderMessages(data.active_chat_id);
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
  requestAnimationFrame(() => {
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

  tg.ready();
  tg.expand();
  loadDraftsFromStorage();
  syncClosingConfirmation();
  syncFullscreenControlState();
  tg.onEvent?.("fullscreenChanged", syncFullscreenControlState);
  tg.onEvent?.("fullscreenFailed", () => appendSystemMessage("Fullscreen request was denied by Telegram client."));
  initData = tg.initData || "";

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
    histories.set(Number(data.active_chat_id), data.history || []);
    setActiveChatMeta(data.active_chat_id);
    renderMessages(data.active_chat_id);
    warmChatHistoryCache();
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

  let builtReply = "";
  let doneReceived = false;

  try {
    const response = await fetch("/api/chat/stream", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(authPayload({ chat_id: chatId, message: cleaned })),
    });

    if (!response.ok || !response.body) {
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

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const events = buffer.split("\n\n");
      buffer = events.pop() || "";

      for (const rawEvent of events) {
        const { eventName, payload } = parseSseEvent(rawEvent);
        if (!payload) continue;

        if (eventName === "meta" && payload.skin) {
          setSkin(payload.skin);
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
            }
          }
        }
        if (eventName === "tool") {
          appendInlineToolTrace(chatId, payload);
          markStreamUpdate(chatId);
          scheduleActiveMessageView(chatId);
          setStreamStatus(`Using tools in ${chatLabel(chatId)}`);
          setActivityChip(streamChip, `stream: tools active · ${compactChatLabel(chatId)}`);
        }
        if (eventName === "chunk") {
          builtReply += payload.text || "";
          updatePendingAssistant(chatId, builtReply, true);
          markStreamUpdate(chatId);
          if (!patchVisiblePendingAssistant(chatId, builtReply, true)) {
            scheduleActiveMessageView(chatId);
          }
        }
        if (eventName === "error") {
          finalizeInlineToolTrace(chatId);
          updatePendingAssistant(chatId, payload.error || "Hermes stream failed.", false);
          markStreamUpdate(chatId);
          syncActiveMessageView(chatId, { preserveViewport: true });
          setStreamStatus("Stream error");
          setActivityChip(streamChip, "stream: error");
        }
        if (eventName === "done") {
          doneReceived = true;
          builtReply = payload.reply || builtReply;
          finalizeInlineToolTrace(chatId);
          updatePendingAssistant(chatId, builtReply, false);
          triggerInAppReplyHaptic(chatId);
          markStreamUpdate(chatId);
          if (!patchVisiblePendingAssistant(chatId, builtReply, false)) {
            syncActiveMessageView(chatId, { preserveViewport: true });
          }
          setActivityChip(latencyChip, `latency: ${formatLatency(payload.latency_ms)}`);
          setStreamStatus(`Reply received in ${chatLabel(chatId)}`);
          setActivityChip(streamChip, `stream: complete · ${compactChatLabel(chatId)}`);
          if (Number(activeChatId) !== chatId) {
            incrementUnread(chatId);
            renderTabs();
          }
        }
      }
    }

    if (buffer.trim()) {
      const { eventName, payload } = parseSseEvent(buffer.trim());
      if (payload && eventName === "done") {
        doneReceived = true;
        builtReply = payload.reply || builtReply;
        finalizeInlineToolTrace(chatId);
        updatePendingAssistant(chatId, builtReply, false);
        triggerInAppReplyHaptic(chatId);
        markStreamUpdate(chatId);
        if (!patchVisiblePendingAssistant(chatId, builtReply, false)) {
          syncActiveMessageView(chatId, { preserveViewport: true });
        }
        setActivityChip(latencyChip, `latency: ${formatLatency(payload.latency_ms)}`);
        setStreamStatus(`Reply received in ${chatLabel(chatId)}`);
        setActivityChip(streamChip, `stream: complete · ${compactChatLabel(chatId)}`);
      }
    }

    if (!doneReceived) {
      const fallbackReply = builtReply || "Hermes stream closed before a final reply event.";
      finalizeInlineToolTrace(chatId);
      updatePendingAssistant(chatId, fallbackReply, false);
      triggerInAppReplyHaptic(chatId);
      markStreamUpdate(chatId);
      if (!patchVisiblePendingAssistant(chatId, fallbackReply, false)) {
        syncActiveMessageView(chatId, { preserveViewport: true });
      }
      setStreamStatus("Stream closed early");
      setActivityChip(streamChip, "stream: closed early");
      if (Number(activeChatId) !== chatId) {
        incrementUnread(chatId);
      }
    }
  } catch (error) {
    finalizeInlineToolTrace(chatId);
    updatePendingAssistant(chatId, `Network failure: ${error.message}`, false);
    markStreamUpdate(chatId);
    syncActiveMessageView(chatId, { preserveViewport: true });
    setStreamStatus("Network failure");
    setActivityChip(streamChip, "stream: network failure");
  } finally {
    pendingChats.delete(chatId);
    if (chats.has(chatId)) {
      chats.get(chatId).pending = false;
    }
    syncClosingConfirmation();
    try {
      if (Number(activeChatId) === chatId) {
        maybeMarkRead(chatId);
      } else {
        await refreshChats();
      }
    } catch (error) {
      appendSystemMessage(`Failed to sync chat state: ${error.message}`);
    }
    renderTabs();
    updateComposerState();
    if (Number(activeChatId) === chatId && document.visibilityState === "visible") {
      promptEl.focus();
    }
  }
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    await sendPrompt(promptEl.value);
  } catch (error) {
    appendSystemMessage(error.message);
  }
});

promptEl.addEventListener("keydown", async (event) => {
  if (event.isComposing) return;

  // On coarse-pointer/mobile keyboards, Enter should always insert a newline.
  // Telegram/iOS modifier reporting is inconsistent (e.g. shift double-tap/caps-lock),
  // which can accidentally flip shiftKey=false and trigger unwanted sends.
  if (mobileQuoteMode) {
    return;
  }

  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    try {
      await sendPrompt(promptEl.value);
    } catch (error) {
      appendSystemMessage(error.message);
    }
  }
});

promptEl.addEventListener("input", () => {
  if (!activeChatId) return;
  setDraft(activeChatId, promptEl.value || "");
});

selectionQuoteButton?.addEventListener("click", () => {
  const picked = mobileQuoteMode ? activeSelectionQuote() : null;
  const textToQuote = mobileQuoteMode ? (picked?.text || selectionQuoteText) : selectionQuoteText;
  if (!textToQuote) return;
  cancelSelectionQuoteSync();
  cancelSelectionQuoteSettle();
  cancelSelectionQuoteClear();
  applyQuoteIntoPrompt(textToQuote);
  window.getSelection?.()?.removeAllRanges?.();
  clearSelectionQuoteState();
});

async function handleMessageCopy(event) {
  const copyButton = event.target.closest(".message__copy");
  if (!copyButton || !messagesEl.contains(copyButton)) return;

  event.preventDefault();
  event.stopPropagation();

  const now = Date.now();
  const lastHandledAt = Number(copyButton.dataset.copyHandledAt || 0);
  if (now - lastHandledAt < 350) {
    return;
  }
  copyButton.dataset.copyHandledAt = String(now);

  const messageNode = copyButton.closest(".message");
  const bodyNode = messageNode?.querySelector(".message__body");
  const copyText = normalizeQuoteSelection(bodyNode?.innerText || bodyNode?.textContent || "");
  const copied = await copyTextToClipboard(copyText);

  copyButton.classList.remove("is-copied", "is-error");
  copyButton.textContent = copied ? "✓" : "!";
  copyButton.setAttribute("aria-label", copied ? "Copied" : "Copy failed");
  copyButton.title = copied ? "Copied" : "Copy failed";
  copyButton.classList.add(copied ? "is-copied" : "is-error");

  if (copyButton._copyResetTimer) {
    window.clearTimeout(copyButton._copyResetTimer);
  }
  copyButton._copyResetTimer = window.setTimeout(() => {
    copyButton.classList.remove("is-copied", "is-error");
    copyButton.textContent = "⧉";
    copyButton.setAttribute("aria-label", "Copy message");
    copyButton.title = "Copy message";
    copyButton._copyResetTimer = null;
  }, copied ? 1200 : 1600);
}

// Use click (not pointerdown) for clipboard writes.
// Some Telegram WebView variants reject clipboard operations on pointerdown
// but allow them on click as a trusted user activation.
messagesEl.addEventListener("click", handleMessageCopy);

messagesEl.addEventListener("mouseup", () => {
  if (mobileQuoteMode) return;
  cancelSelectionQuoteClear();
  scheduleSelectionQuoteSync(80);
});
messagesEl.addEventListener("touchstart", () => {
  if (!mobileQuoteMode) return;
  // Freeze quote action while selection handles are moving.
  cancelSelectionQuoteSync();
  cancelSelectionQuoteSettle();
  cancelSelectionQuoteClear();
  mobileQuotePlacementKey = "";
  if (selectionQuoteButton) {
    selectionQuoteButton.hidden = true;
  }
});
messagesEl.addEventListener("touchend", () => {
  if (!mobileQuoteMode) return;
  cancelSelectionQuoteClear();
  // Wait for native toolbar/handles to settle before showing popup.
  scheduleSelectionQuoteSync(220);
});
messagesEl.addEventListener("touchcancel", () => {
  if (!mobileQuoteMode) return;
  cancelSelectionQuoteSync();
  cancelSelectionQuoteSettle();
  scheduleSelectionQuoteClear(220);
});
document.addEventListener("selectionchange", () => {
  const active = document.activeElement;
  if (active === promptEl) {
    return;
  }

  const selection = document.getSelection?.();
  const hasSelection = Boolean(selection && selection.rangeCount >= 1 && !selection.isCollapsed);
  const inMessages = Boolean(hasSelection && messagesEl.contains(selection.anchorNode || null));

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
    mobileQuotePlacementKey = "";
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
});

document.addEventListener("touchstart", (event) => {
  if (!mobileQuoteMode) return;
  const target = event.target;
  if (!target) return;
  if (messagesEl.contains(target)) return;
  if (target === promptEl || promptEl?.contains?.(target)) return;
  cancelSelectionQuoteSync();
  cancelSelectionQuoteSettle();
  scheduleSelectionQuoteClear(220);
});

tabsEl.addEventListener("click", (event) => {
  const tab = event.target.closest(".chat-tab");
  if (!tab) return;
  const chatId = Number(tab.dataset.chatId);
  if (!chatId || chatId === Number(activeChatId)) return;
  void openChat(chatId);
});

messagesEl.addEventListener("scroll", () => {
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
});

jumpLatestButton?.addEventListener("click", () => {
  const key = Number(activeChatId);
  if (!key) return;
  unseenStreamChats.delete(key);
  refreshTabNode(key);
  syncActiveMessageView(key, { forceBottom: true });
  maybeMarkRead(key, { force: true });
  updateJumpLatestVisibility();
});

jumpLastStartButton?.addEventListener("click", () => {
  const key = Number(activeChatId);
  if (!key) return;
  const renderedMessages = messagesEl.querySelectorAll(".message");
  const lastRenderedMessage = renderedMessages[renderedMessages.length - 1];
  if (!lastRenderedMessage) return;

  messagesEl.scrollTop = Math.max(0, Number(lastRenderedMessage.offsetTop));
  chatScrollTop.set(key, messagesEl.scrollTop);
  chatStickToBottom.set(key, isNearBottom(messagesEl, 40));
  updateJumpLatestVisibility();
});

skinButtons.forEach((button) => {
  button.addEventListener("click", async () => {
    if (!isAuthenticated) {
      appendSystemMessage("Still signing you in. Try again in a moment.");
      return;
    }
    try {
      await saveSkinPreference(button.dataset.skin);
      closeSettingsModal();
    } catch (error) {
      appendSystemMessage(error.message);
    }
  });
});

newChatButton.addEventListener("click", async () => {
  try {
    await createChat();
  } catch (error) {
    appendSystemMessage(error.message);
  }
});

renameChatButton.addEventListener("click", async () => {
  try {
    await renameActiveChat();
  } catch (error) {
    appendSystemMessage(error.message);
  }
});

removeChatButton.addEventListener("click", async () => {
  try {
    await removeActiveChat();
  } catch (error) {
    appendSystemMessage(error.message);
  }
});

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
settingsButton?.addEventListener("click", openSettingsModal);
settingsClose?.addEventListener("click", closeSettingsModal);
settingsModal?.addEventListener?.("cancel", (event) => {
  event.preventDefault();
  closeSettingsModal();
});

document.addEventListener("visibilitychange", async () => {
  if (document.visibilityState !== "visible" || !isAuthenticated) return;
  try {
    await refreshChats();
    if (activeChatId) {
      maybeMarkRead(activeChatId);
      const data = await loadChatHistory(Number(activeChatId), { activate: true });
      const nextHistory = data.history || [];
      histories.set(Number(activeChatId), nextHistory);
      upsertChat(data.chat);
      renderMessages(Number(activeChatId), { preserveViewport: true });
    }
  } catch {
    // best effort sync
  }
});

startDevAutoRefresh();
installTapToDismissKeyboard();
installKeyboardViewportSync();
void bootstrap();
