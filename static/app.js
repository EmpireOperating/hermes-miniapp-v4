const tg = window.Telegram?.WebApp;
const devConfig = window.__HERMES_DEV__ || {
  enabled: false,
  reloadStateUrl: "/dev/reload-state",
  intervalMs: 1200,
  version: "",
  requestDebug: false,
  devAuthEnabled: false,
  devAuthRevealHash: "#dev-auth",
};
const streamDebugEnabled = Boolean(devConfig.requestDebug);
const devAuthRevealHash = String(devConfig.devAuthRevealHash || "#dev-auth").trim() || "#dev-auth";
const currentLocationHash = typeof window?.location?.hash === "string" ? window.location.hash : "";
const desktopTestingRequested = currentLocationHash === devAuthRevealHash || currentLocationHash.startsWith(`${devAuthRevealHash}:`);
const desktopTestingEnabled = Boolean(devConfig.devAuthEnabled) && desktopTestingRequested;
const devAuthHashSecret = desktopTestingRequested && currentLocationHash.startsWith(`${devAuthRevealHash}:`)
  ? decodeURIComponent(currentLocationHash.slice(devAuthRevealHash.length + 1))
  : "";
const filePreviewConfig = window.__HERMES_FILE_PREVIEW__ || { enabled: false, allowedRoots: [] };
const filePreviewFeatureEnabled = Boolean(filePreviewConfig.enabled);
const filePreviewAllowedRoots = filePreviewFeatureEnabled && Array.isArray(filePreviewConfig.allowedRoots)
  ? filePreviewConfig.allowedRoots
      .map((value) => String(value || "").trim())
      .filter((value) => value.startsWith("/"))
  : [];
const sharedUtils = window.HermesMiniappSharedUtils;

if (!sharedUtils) {
  throw new Error("HermesMiniappSharedUtils is required before app.js");
}
const bootstrapAuthHelpers = window.HermesMiniappBootstrapAuth;
if (!bootstrapAuthHelpers) {
  throw new Error("HermesMiniappBootstrapAuth is required before app.js");
}
const chatHistoryHelpers = window.HermesMiniappChatHistory;
if (!chatHistoryHelpers) {
  throw new Error("HermesMiniappChatHistory is required before app.js");
}
const chatAdminHelpers = window.HermesMiniappChatAdmin;
if (!chatAdminHelpers) {
  throw new Error("HermesMiniappChatAdmin is required before app.js");
}
const chatUiHelpers = window.HermesMiniappChatUI;
if (!chatUiHelpers) {
  throw new Error("HermesMiniappChatUI is required before app.js");
}
const chatTabsHelpers = window.HermesMiniappChatTabs;
if (!chatTabsHelpers) {
  throw new Error("HermesMiniappChatTabs is required before app.js");
}
const messageActionsHelpers = window.HermesMiniappMessageActions;
if (!messageActionsHelpers) {
  throw new Error("HermesMiniappMessageActions is required before app.js");
}
const composerStateHelpers = window.HermesMiniappComposerState;
if (!composerStateHelpers) {
  throw new Error("HermesMiniappComposerState is required before app.js");
}
const keyboardShortcutsHelpers = window.HermesMiniappKeyboardShortcuts;
if (!keyboardShortcutsHelpers) {
  throw new Error("HermesMiniappKeyboardShortcuts is required before app.js");
}
const interactionHelpers = window.HermesMiniappInteraction;
if (!interactionHelpers) {
  throw new Error("HermesMiniappInteraction is required before app.js");
}
const shellUiHelpers = window.HermesMiniappShellUI;
if (!shellUiHelpers) {
  throw new Error("HermesMiniappShellUI is required before app.js");
}
const composerViewportHelpers = window.HermesMiniappComposerViewport;
if (!composerViewportHelpers) {
  throw new Error("HermesMiniappComposerViewport is required before app.js");
}
const visibilitySkinHelpers = window.HermesMiniappVisibilitySkin;
if (!visibilitySkinHelpers) {
  throw new Error("HermesMiniappVisibilitySkin is required before app.js");
}
const startupBindingsHelpers = window.HermesMiniappStartupBindings;
if (!startupBindingsHelpers) {
  throw new Error("HermesMiniappStartupBindings is required before app.js");
}
const renderTraceHelpers = window.HermesMiniappRenderTrace;
if (!renderTraceHelpers) {
  throw new Error("HermesMiniappRenderTrace is required before app.js");
}
const filePreviewHelpers = window.HermesMiniappFilePreview;
if (!filePreviewHelpers) {
  throw new Error("HermesMiniappFilePreview is required before app.js");
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
const streamChip = document.getElementById("stream-chip");
const jumpLatestButton = document.getElementById("jump-latest");
const jumpLastStartButton = document.getElementById("jump-last-start");
const body = document.body;
const SKIN_STORAGE_KEY = "hermes_skin";
const PINNED_CHATS_COLLAPSED_STORAGE_KEY = "hermes_pinned_chats_collapsed";
const DEV_AUTH_SESSION_STORAGE_KEY = "hermes_dev_auth_defaults";
const PINNED_CHATS_AUTO_COLLAPSE_THRESHOLD = 8;
const ALLOWED_SKINS = new Set(["terminal", "oracle", "obsidian"]);
const AUTH_BOOTSTRAP_MAX_ATTEMPTS = 3;
const AUTH_BOOTSTRAP_BASE_DELAY_MS = 220;
const AUTH_BOOTSTRAP_RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);
const BOOTSTRAP_VERSION_RELOAD_STORAGE_KEY = "hermes_bootstrap_version_reload_once";
const bootSkin = document.documentElement?.getAttribute("data-skin") || window.__HERMES_SKIN_BOOT__ || "terminal";
const bootBootstrapVersion = String(window.__HERMES_BOOTSTRAP_VERSION__ || "").trim();
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
const pinnedChatsCountEl = document.getElementById("pinned-chats-count");
const pinnedChatsToggleButton = document.getElementById("pinned-chats-toggle");
const fullscreenAppTopButton = document.getElementById("fullscreen-app-top");
const closeAppTopButton = document.getElementById("close-app-top");
const settingsButton = document.getElementById("settings-button");
const devAuthControls = document.getElementById("dev-auth-controls");
const devModeBadge = document.getElementById("dev-mode-badge");
const devSignInButton = document.getElementById("dev-signin-button");
const renderTraceBadge = document.getElementById("render-trace-badge");
const settingsModal = document.getElementById("settings-modal");
const settingsClose = document.getElementById("settings-close");
const devAuthModal = document.getElementById("dev-auth-modal");
const devAuthForm = document.getElementById("dev-auth-form");
const devAuthSecretInput = document.getElementById("dev-auth-secret");
const devAuthUserIdInput = document.getElementById("dev-auth-user-id");
const devAuthDisplayNameInput = document.getElementById("dev-auth-display-name");
const devAuthUsernameInput = document.getElementById("dev-auth-username");
const devAuthCancelButton = document.getElementById("dev-auth-cancel");
const template = document.getElementById("message-template");
const tabTemplate = document.getElementById("chat-tab-template");
const skinButtons = document.querySelectorAll(".skin-toggle");
const chatTitleModal = document.getElementById("chat-title-modal");
const chatTitleForm = document.getElementById("chat-title-form");
const chatTitleHint = document.getElementById("chat-title-modal-hint");
const chatTitleInput = document.getElementById("chat-title-input");
const chatTitleCancel = document.getElementById("chat-title-cancel");
const chatTitleConfirm = document.getElementById("chat-title-confirm");
const chatTitleTagLabel = document.getElementById("chat-title-tag-label");
const chatTitleTagRow = document.getElementById("chat-title-tag-row");
const chatTitleTagButtons = Array.from(document.querySelectorAll("[data-chat-title-tag]"));
const selectionQuoteButton = document.getElementById("selection-quote-button");
const filePreviewModal = document.getElementById("file-preview-modal");
const filePreviewPath = document.getElementById("file-preview-path");
const filePreviewStatus = document.getElementById("file-preview-status");
const filePreviewLines = document.getElementById("file-preview-lines");
const filePreviewExpandUp = document.getElementById("file-preview-expand-up");
const filePreviewLoadFull = document.getElementById("file-preview-load-full");
const filePreviewExpandDown = document.getElementById("file-preview-expand-down");
const filePreviewClose = document.getElementById("file-preview-close");
const chatTabContextMenu = document.getElementById("chat-tab-context-menu");
const chatTabContextFork = document.getElementById("chat-tab-context-fork");

let initData = "";
let isAuthenticated = false;
let currentSkin = bootSkin;
let activeChatId = null;
let operatorDisplayName = "Operator";
let currentFilePreviewRequest = null;
let currentFilePreview = null;
const chats = new Map();
const pinnedChats = new Map();
const histories = new Map();
let pinnedChatsCollapsed = false;
let hasPinnedChatsCollapsePreference = false;
const pendingChats = new Set();
const reconnectResumeBlockedChats = new Set();
const resumeAttemptedAtByChat = new Map();
const resumeCooldownUntilByChat = new Map();
const resumeInFlightByChat = new Set();
const latencyByChat = new Map();
const runtimeHelpers = window.HermesMiniappRuntime;
if (!runtimeHelpers) {
  throw new Error("HermesMiniappRuntime is required before app.js");
}
const streamStateHelpers = window.HermesMiniappStreamState;
if (!streamStateHelpers) {
  throw new Error("HermesMiniappStreamState is required before app.js");
}
const streamControllerHelpers = window.HermesMiniappStreamController;
if (!streamControllerHelpers) {
  throw new Error("HermesMiniappStreamController is required before app.js");
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
const streamPhaseByChat = new Map();
const {
  STREAM_PHASES,
  getStreamPhase: getStreamPhaseFromState,
  setStreamPhase: setStreamPhaseInState,
  isPatchPhaseAllowed,
  markChatStreamPending,
  finalizeChatStreamState,
  clearChatStreamState,
} = streamStateHelpers;

const chatTabsController = chatTabsHelpers.createController({
  localStorageRef: localStorage,
  pinnedChatsCollapsedStorageKey: PINNED_CHATS_COLLAPSED_STORAGE_KEY,
  pinnedChatsAutoCollapseThreshold: PINNED_CHATS_AUTO_COLLAPSE_THRESHOLD,
  chats,
  pinnedChats,
  histories,
  pendingChats,
  streamPhaseByChat,
  unseenStreamChats,
  prefetchingHistories,
  chatScrollTop,
  chatStickToBottom,
  virtualizationRanges,
  virtualMetrics,
  renderedHistoryLength,
  renderedHistoryVirtualized,
  tabNodes,
  clearChatStreamState,
  chatUiHelpers,
  pinnedChatsWrap,
  pinnedChatsEl,
  pinnedChatsCountEl,
  pinnedChatsToggleButton,
  pinChatButton,
  documentObject: document,
  getActiveChatId: () => Number(activeChatId),
  getPinnedChatsCollapsed: () => pinnedChatsCollapsed,
  setPinnedChatsCollapsedState: (value) => {
    pinnedChatsCollapsed = Boolean(value);
  },
  getHasPinnedChatsCollapsePreference: () => hasPinnedChatsCollapsePreference,
  setHasPinnedChatsCollapsePreference: (value) => {
    hasPinnedChatsCollapsePreference = Boolean(value);
  },
});

const storedPinnedChatsCollapsed = chatTabsController.getStoredPinnedChatsCollapsed();
pinnedChatsCollapsed = storedPinnedChatsCollapsed ?? false;
hasPinnedChatsCollapsePreference = storedPinnedChatsCollapsed !== null;

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
const mobileQuoteMode = isCoarsePointer();
const draftByChat = new Map();
const DRAFT_STORAGE_KEY = "hermes_miniapp_chat_drafts_v1";
const RENDER_TRACE_STORAGE_KEY = "hermes_render_trace_debug";
const STREAM_RESUME_CURSOR_STORAGE_KEY = "hermes_miniapp_stream_resume_cursor_v1";
const PENDING_STREAM_SNAPSHOT_STORAGE_KEY = "hermes_miniapp_pending_stream_snapshot_v1";
const PENDING_STREAM_SNAPSHOT_MAX_AGE_MS = 15 * 60 * 1000;
const LATENCY_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
let renderTraceDebugEnabled = false;
loadLatencyByChatFromStorage();

const streamPersistenceController = streamStateHelpers.createPersistenceController({
  localStorageRef: localStorage,
  streamResumeCursorStorageKey: STREAM_RESUME_CURSOR_STORAGE_KEY,
  pendingStreamSnapshotStorageKey: PENDING_STREAM_SNAPSHOT_STORAGE_KEY,
  pendingStreamSnapshotMaxAgeMs: PENDING_STREAM_SNAPSHOT_MAX_AGE_MS,
  histories,
  chats,
});

const draftController = composerStateHelpers.createDraftController({
  localStorageRef: localStorage,
  draftStorageKey: DRAFT_STORAGE_KEY,
  draftByChat,
});

const toolTraceController = streamControllerHelpers.createToolTraceController({
  toolStreamEl,
  toolStreamLinesEl,
  histories,
  cleanDisplayText,
});

const renderTraceController = renderTraceHelpers.createController({
  windowObject: window,
  localStorageRef: localStorage,
  renderTraceBadge,
  storageKey: RENDER_TRACE_STORAGE_KEY,
  getRenderTraceDebugEnabled: () => renderTraceDebugEnabled,
  setRenderTraceDebugEnabledState: (value) => {
    renderTraceDebugEnabled = Boolean(value);
  },
  consoleRef: console,
});

const historyRenderController = renderTraceHelpers.createHistoryRenderController({
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
  historyCountEl: historyCount,
  virtualizeThreshold: VIRTUALIZE_THRESHOLD,
  estimatedMessageHeight: ESTIMATED_MESSAGE_HEIGHT,
  virtualOverscan: VIRTUAL_OVERSCAN,
  getActiveChatId: () => Number(activeChatId),
  getRenderedChatId: () => Number(renderedChatId),
  setRenderedChatId: (value) => {
    renderedChatId = value;
  },
  refreshTabNode,
  clearSelectionQuoteStateFn: clearSelectionQuoteState,
  syncLiveToolStreamForChatFn: syncLiveToolStreamForChat,
  appendMessagesFn: appendMessages,
  shouldUseAppendOnlyRenderFn: runtimeHelpers.shouldUseAppendOnlyRender,
  renderTraceLogFn: renderTraceLog,
  createSpacerElementFn: () => document.createElement("div"),
  createFragmentFn: () => document.createDocumentFragment(),
});

const filePreviewController = filePreviewHelpers.createController({
  documentObject: document,
  requestAnimationFrameFn: (callback) => requestAnimationFrame(callback),
  filePreviewModal,
  filePreviewPath,
  filePreviewStatus,
  filePreviewLines,
  filePreviewExpandUp,
  filePreviewLoadFull,
  filePreviewExpandDown,
  apiPost,
  getActiveChatId: () => activeChatId,
  getCurrentFilePreviewRequest: () => currentFilePreviewRequest,
  setCurrentFilePreviewRequest: (value) => {
    currentFilePreviewRequest = value || null;
  },
  getCurrentFilePreview: () => currentFilePreview,
  setCurrentFilePreview: (value) => {
    currentFilePreview = value || null;
  },
});

renderTraceDebugEnabled = renderTraceController.resolveRenderTraceDebugEnabled();

function parseBooleanFlag(rawValue) {
  return renderTraceHelpers.parseBooleanFlag(rawValue);
}

function resolveRenderTraceDebugEnabled() {
  return renderTraceController.resolveRenderTraceDebugEnabled();
}

function syncRenderTraceBadge() {
  return renderTraceController.syncRenderTraceBadge();
}

function setRenderTraceDebugEnabled(nextEnabled, options = {}) {
  return renderTraceController.setRenderTraceDebugEnabled(nextEnabled, options);
}

function handleRenderTraceBadgeClick() {
  return renderTraceController.handleRenderTraceBadgeClick();
}

function renderTraceLog(eventName, details = null) {
  return renderTraceController.renderTraceLog(eventName, details);
}

function streamDebugLog(eventName, details = null) {
  if (!streamDebugEnabled) return;
  if (details == null) {
    console.info(`[stream-debug] ${eventName}`);
    return;
  }
  console.info(`[stream-debug] ${eventName}`, details);
}

function runAfterUiMutation(callback) {
  return composerViewportController.runAfterUiMutation(callback);
}

function preserveViewportDuringUiMutation(mutator) {
  return composerViewportController.preserveViewportDuringUiMutation(mutator);
}

function setChatLatency(chatId, text) {
  const key = Number(chatId);
  const normalized = String(text || "").trim() || "--";
  const result = latencyViewController.setChatLatency(chatId, text);
  persistLatencyByChatToStorage();
  if (key > 0) {
    renderTraceLog("latency-update", {
      chatId: key,
      activeChatId: Number(activeChatId),
      hidden: document.visibilityState !== "visible",
      latency: normalized,
      chipText: String(latencyChip?.textContent || "").trim(),
    });
  }
  return result;
}

function syncActiveLatencyChip() {
  return latencyViewController.syncActiveLatencyChip();
}

const bootMetrics = (() => {
  const existing = window.__HERMES_BOOT_METRICS__;
  if (existing && typeof existing === "object") {
    return existing;
  }
  const next = {};
  window.__HERMES_BOOT_METRICS__ = next;
  return next;
})();
const bootPerf = typeof window.performance !== "undefined" ? window.performance : null;
function bootNowMs() {
  return bootPerf && typeof bootPerf.now === "function" ? bootPerf.now() : Date.now();
}
function recordBootMetric(name, value = bootNowMs()) {
  const normalized = Math.max(0, Math.round(Number(value) || 0));
  bootMetrics[name] = normalized;
  return normalized;
}
function syncBootLatencyChip(stage = "") {
  const startedAt = Number(bootMetrics.shellInlineStartMs || 0);
  if (!startedAt || !latencyChip) {
    return;
  }
  const elapsedMs = Math.max(0, Math.round(bootNowMs() - startedAt));
  setActivityChip(latencyChip, `open: ${elapsedMs}ms`);
  if (stage) {
    latencyChip.dataset.bootStage = stage;
  }
}
function logBootStage(stage, extra = {}) {
  const metricName = `${String(stage || "stage").replace(/[^a-z0-9]+/gi, "_")}Ms`;
  const elapsedMs = recordBootMetric(metricName);
  syncBootLatencyChip(stage);
  console.info("[miniapp/boot]", {
    stage,
    elapsedMs,
    ...extra,
  });
}
recordBootMetric("appScriptStartMs");
syncBootLatencyChip("app-script-start");

function revealShell() {
  document.documentElement?.setAttribute("data-shell-ready", "1");
  recordBootMetric("shellRevealMs");
  syncBootLatencyChip("shell-visible");
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

function setElementHidden(element, hidden) {
  if (!element) return;
  if (hidden) {
    element.setAttribute("hidden", "hidden");
    return;
  }
  element.removeAttribute("hidden");
}

function syncDebugOnlyPillVisibility() {
  const showDevAuthPill=Boolean(devConfig.devAuthEnabled && desktopTestingRequested);
  const showDebugPills = Boolean(devConfig.requestDebug && desktopTestingRequested);
  setElementHidden(devAuthControls, !showDevAuthPill);
  setElementHidden(devModeBadge, !showDebugPills);
}

function loadLatencyByChatFromStorage() {
  runtimeHelpers.loadLatencyByChatFromStorage?.({
    localStorageRef: localStorage,
    storageKey: "hermes_miniapp_latency_by_chat_v1",
    latencyByChat,
  });
}

function persistLatencyByChatToStorage() {
  runtimeHelpers.persistLatencyByChatToStorage?.({
    localStorageRef: localStorage,
    storageKey: "hermes_miniapp_latency_by_chat_v1",
    latencyByChat,
  });
}

function readStreamResumeCursorMap() {
  return streamPersistenceController.readStreamResumeCursorMap();
}

function writeStreamResumeCursorMap(nextMap) {
  return streamPersistenceController.writeStreamResumeCursorMap(nextMap);
}

function getStoredStreamCursor(chatId) {
  return streamPersistenceController.getStoredStreamCursor(chatId);
}

function setStoredStreamCursor(chatId, eventId) {
  return streamPersistenceController.setStoredStreamCursor(chatId, eventId);
}

function clearStoredStreamCursor(chatId) {
  return streamPersistenceController.clearStoredStreamCursor(chatId);
}

function readPendingStreamSnapshotMap() {
  return streamPersistenceController.readPendingStreamSnapshotMap();
}

function writePendingStreamSnapshotMap(nextMap) {
  return streamPersistenceController.writePendingStreamSnapshotMap(nextMap);
}

function clearPendingStreamSnapshot(chatId) {
  return streamPersistenceController.clearPendingStreamSnapshot(chatId);
}

function normalizeSnapshotLines(value) {
  return streamPersistenceController.normalizeSnapshotLines(value);
}

function mergeSnapshotToolJournalLines(existingLines, currentBody) {
  return streamPersistenceController.mergeSnapshotToolJournalLines(existingLines, currentBody);
}

function persistPendingStreamSnapshot(chatId) {
  return streamPersistenceController.persistPendingStreamSnapshot(chatId);
}

function restorePendingStreamSnapshot(chatId) {
  return streamPersistenceController.restorePendingStreamSnapshot(chatId);
}

function authPayload(extra = {}) {
  return bootstrapAuthController.authPayload(extra);
}

async function safeReadJson(response) {
  return bootstrapAuthController.safeReadJson(response);
}

function summarizeUiFailure(rawBody, { status = 0, fallback = "Request failed." } = {}) {
  return bootstrapAuthController.summarizeUiFailure(rawBody, { status, fallback });
}

function parseStreamErrorPayload(rawBody) {
  return bootstrapAuthController.parseStreamErrorPayload(rawBody);
}

function cloneFilePreviewRequest(previewRequest = {}) {
  return filePreviewController.cloneFilePreviewRequest(previewRequest);
}

function syncFilePreviewExpandControls(preview = null, options = {}) {
  return filePreviewController.syncFilePreviewExpandControls(preview, options);
}

function resetFilePreviewState() {
  return filePreviewController.resetFilePreviewState();
}

function closeFilePreviewModal() {
  return filePreviewController.closeFilePreviewModal();
}

function createFilePreviewLineNode(row, options = {}) {
  return filePreviewController.createFilePreviewLineNode(row, options);
}

function captureFilePreviewViewportAnchor() {
  return filePreviewController.captureFilePreviewViewportAnchor();
}

function restoreFilePreviewViewportAnchor(anchor) {
  return filePreviewController.restoreFilePreviewViewportAnchor(anchor);
}

function canIncrementallyExpandFilePreview(previousPreview, nextPreview) {
  return filePreviewController.canIncrementallyExpandFilePreview(previousPreview, nextPreview);
}

function expandFilePreviewInPlace(previousPreview, nextPreview) {
  return filePreviewController.expandFilePreviewInPlace(previousPreview, nextPreview);
}

function renderFilePreview(preview, options = {}) {
  return filePreviewController.renderFilePreview(preview, options);
}

function showFilePreviewStatus(message) {
  return filePreviewController.showFilePreviewStatus(message);
}

async function openFilePreview(previewRequest = {}, options = {}) {
  return filePreviewController.openFilePreview(previewRequest, options);
}

function openFilePreviewByRef(refId) {
  return filePreviewController.openFilePreviewByRef(refId);
}

function openFilePreviewByPath(pathText, options = {}) {
  return filePreviewController.openFilePreviewByPath(pathText, options);
}

function requestFilePreviewExpansion(direction) {
  return filePreviewController.requestFilePreviewExpansion(direction);
}

function requestFullFilePreview() {
  return filePreviewController.requestFullFilePreview();
}

function handleMessageFileRefTouchStart(event) {
  return filePreviewController.handleMessageFileRefTouchStart(event);
}

function handleMessageFileRefTouchMove(event) {
  return filePreviewController.handleMessageFileRefTouchMove(event);
}

function cancelPendingMessageFileRefTouch() {
  return filePreviewController.cancelPendingMessageFileRefTouch();
}

function handleMessageFileRefClick(event) {
  return filePreviewController.handleMessageFileRefClick(event);
}

const bootstrapAuthController = bootstrapAuthHelpers.createController({
  desktopTestingEnabled,
  devAuthSessionStorageKey: DEV_AUTH_SESSION_STORAGE_KEY,
  devAuthHashSecret,
  devAuthControls,
  devModeBadge,
  devSignInButton,
  getIsAuthenticated: () => isAuthenticated,
  setIsAuthenticated: (value) => {
    isAuthenticated = Boolean(value);
  },
  sessionStorageRef: window.sessionStorage,
  devAuthModal,
  devAuthForm,
  devAuthSecretInput,
  devAuthUserIdInput,
  devAuthDisplayNameInput,
  devAuthUsernameInput,
  devAuthCancelButton,
  authStatus,
  appendSystemMessage,
  fetchImpl: (...args) => fetch(...args),
  normalizeHandle,
  initData,
  parseSseEvent,
  fallbackHandleFromDisplayName,
  setOperatorDisplayName: (value) => {
    operatorDisplayName = String(value || "");
  },
  operatorName,
  refreshOperatorRoleLabels,
  setSkin,
  syncChats,
  syncPinnedChats,
  histories,
  setActiveChatMeta,
  renderPinnedChats,
  renderMessages,
  warmChatHistoryCache,
  chats,
  pendingChats,
  resumePendingChatStream,
  addLocalMessage,
});

function syncDevAuthUi() {
  const result = bootstrapAuthController.syncDevAuthUi();
  syncDebugOnlyPillVisibility();
  return result;
}

function readDevAuthDefaults() {
  return bootstrapAuthController.readDevAuthDefaults();
}

function writeDevAuthDefaults(value) {
  return bootstrapAuthController.writeDevAuthDefaults(value);
}

function applyAuthBootstrap(data, options = {}) {
  return bootstrapAuthController.applyAuthBootstrap(data, options);
}

async function askForDevAuth(defaults) {
  return bootstrapAuthController.askForDevAuth(defaults);
}

async function signInWithDevAuth(options = {}) {
  return bootstrapAuthController.signInWithDevAuth(options);
}

function syncClosingConfirmation() {
  return shellUiController.syncClosingConfirmation();
}

function syncTelegramChromeForSkin(skin) {
  return shellUiController.syncTelegramChromeForSkin(skin);
}

function shouldApplyDevReload() {
  return visibilitySkinController.shouldApplyDevReload();
}

function startDevAutoRefresh() {
  return visibilitySkinController.startDevAutoRefresh();
}

const incomingMessageHapticKeys = new Set();
const hapticUnreadController = runtimeHelpers.createHapticUnreadController({
  tg,
  histories,
  incomingMessageHapticKeys,
  chats,
  getActiveChatId: () => Number(activeChatId),
  isDocumentHidden: () => Boolean(document.hidden),
  nextUnreadCountFn: runtimeHelpers.nextUnreadCount,
});

function latestCompletedAssistantHapticKey(chatId) {
  return hapticUnreadController.latestCompletedAssistantHapticKey(chatId);
}

function triggerIncomingMessageHaptic(chatId, { messageKey = "", fallbackToLatestHistory = true } = {}) {
  return hapticUnreadController.triggerIncomingMessageHaptic(chatId, { messageKey, fallbackToLatestHistory });
}

function incrementUnread(chatId) {
  const key = Number(chatId);
  const beforeChat = chats.get(key);
  const beforeUnread = Math.max(0, Number(beforeChat?.unread_count || 0));
  const result = hapticUnreadController.incrementUnread(chatId);
  const afterChat = chats.get(key);
  const afterUnread = Math.max(0, Number(afterChat?.unread_count || 0));
  if (key > 0) {
    renderTraceLog("unread-increment", {
      chatId: key,
      activeChatId: Number(activeChatId),
      hidden: document.visibilityState !== "visible",
      beforeUnread,
      afterUnread,
      incremented: afterUnread > beforeUnread,
    });
  }
  return result;
}

function loadDraftsFromStorage() {
  return draftController.loadDraftsFromStorage();
}

function persistDraftsToStorage() {
  return draftController.persistDraftsToStorage();
}

function setDraft(chatId, value) {
  return draftController.setDraft(chatId, value);
}

function getDraft(chatId) {
  return draftController.getDraft(chatId);
}

function resetToolStream() {
  return toolTraceController.resetToolStream();
}

function syncLiveToolStreamForChat(_chatId) {
  resetToolStream();
  return false;
}

function findPendingToolTraceMessage(chatId) {
  return toolTraceController.findPendingToolTraceMessage(chatId);
}

function ensurePendingToolTraceMessage(chatId) {
  return toolTraceController.ensurePendingToolTraceMessage(chatId);
}

function appendInlineToolTrace(chatId, textOrPayload, payload = null) {
  const result = toolTraceController.appendInlineToolTrace(chatId, textOrPayload, payload);
  persistPendingStreamSnapshot(chatId);
  return result;
}

function finalizeInlineToolTrace(chatId) {
  const result = toolTraceController.finalizeInlineToolTrace(chatId);
  persistPendingStreamSnapshot(chatId);
  return result;
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

function parseTaggedChatTitle(rawTitle) {
  return chatAdminController.parseTaggedChatTitle(rawTitle);
}

function formatTaggedChatTitle(title, tag) {
  return chatAdminController.formatTaggedChatTitle(title, tag);
}

function setChatTitleSelectedTag(nextTag) {
  return chatAdminController.setChatTitleSelectedTag(nextTag);
}

async function askForChatTitle({ mode, currentTitle = "", defaultTitle = "New chat" }) {
  return chatAdminController.askForChatTitle({ mode, currentTitle, defaultTitle });
}

function unwrapLegacyQuoteBlock(text) {
  return interactionHelpers.unwrapLegacyQuoteBlock(text);
}

function normalizeQuoteSelection(rawText) {
  return interactionHelpers.normalizeQuoteSelection(rawText);
}

function splitGraphemes(text) {
  return interactionHelpers.splitGraphemes(text);
}

function wrapQuoteLine(line, width = 46) {
  return interactionHelpers.wrapQuoteLine(line, width);
}

function getQuoteWrapWidth() {
  return interactionHelpers.getQuoteWrapWidth({ promptInput, windowObject: window });
}

function formatQuoteBlock(rawText) {
  return interactionHelpers.formatQuoteBlock(rawText);
}

function isCoarsePointer() {
  return interactionHelpers.isCoarsePointer({ windowObject: window });
}

function clearSelectionQuoteState() {
  interactionHelpers.clearSelectionQuoteState({
    selectionQuoteState,
    selectionQuoteButton,
  });
}

function cancelSelectionQuoteTimer(name) {
  interactionHelpers.cancelSelectionQuoteTimer(name, { selectionQuoteState });
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
  interactionHelpers.scheduleSelectionQuoteClear(
    {
      selectionQuoteState,
      activeSelectionQuoteFn: activeSelectionQuote,
      clearSelectionQuoteStateFn: clearSelectionQuoteState,
    },
    delayMs,
  );
}

function scheduleSelectionQuoteSync(delayMs = 120) {
  interactionHelpers.scheduleSelectionQuoteSync(
    {
      selectionQuoteState,
      cancelSelectionQuoteSyncFn: cancelSelectionQuoteSync,
      cancelSelectionQuoteSettleFn: cancelSelectionQuoteSettle,
      syncSelectionQuoteActionFn: syncSelectionQuoteAction,
    },
    delayMs,
  );
}

function applyQuoteIntoPrompt(text) {
  interactionHelpers.applyQuoteIntoPrompt(text, {
    promptEl,
    formatQuoteBlockFn: formatQuoteBlock,
    ensureComposerVisible,
  });
}

function activeSelectionQuote() {
  return interactionHelpers.activeSelectionQuote({
    messagesEl,
    windowObject: window,
    normalizeQuoteSelectionFn: normalizeQuoteSelection,
    textNodeType: Node.TEXT_NODE,
  });
}

function quotePlacementKey({ text, rect }) {
  return interactionHelpers.quotePlacementKey({ text, rect });
}

function showSelectionQuoteAction({ text, rect }, { lockPlacement = false } = {}) {
  interactionHelpers.showSelectionQuoteAction(
    { text, rect },
    {
      selectionQuoteButton,
      selectionQuoteState,
      mobileQuoteMode,
      windowObject: window,
      form,
      clearSelectionQuoteState,
    },
    { lockPlacement },
  );
}

function syncSelectionQuoteAction() {
  interactionHelpers.syncSelectionQuoteAction({
    activeSelectionQuoteFn: activeSelectionQuote,
    clearSelectionQuoteState,
    cancelSelectionQuoteClear,
    mobileQuoteMode,
    showSelectionQuoteActionFn: showSelectionQuoteAction,
    selectionQuoteButton,
    selectionQuoteState,
    cancelSelectionQuoteSettle,
    scheduleSelectionQuoteClear,
    scheduleSelectionQuoteSync,
  });
}

function renderBody(container, rawText, { fileRefs = null } = {}) {
  renderTraceHelpers.renderBody(container, rawText, {
    cleanDisplayTextFn: cleanDisplayText,
    escapeHtmlFn: escapeHtml,
    fileRefs,
    allowedRoots: filePreviewAllowedRoots,
  });
}

function renderToolTraceBody(container, message) {
  renderTraceHelpers.renderToolTraceBody(container, message, {
    cleanDisplayTextFn: cleanDisplayText,
    documentObject: document,
  });
}

function roleLabelForMessage(message) {
  return renderTraceHelpers.roleLabelForMessage(message, { operatorDisplayName });
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
  return renderTraceHelpers.messageVariantForRole(role);
}

function shouldSkipMessageRender({ role, renderedBody, pending }) {
  return renderTraceHelpers.shouldSkipMessageRender({ role, renderedBody, pending });
}

function applyMessageMeta(node, message, role, variant) {
  renderTraceHelpers.applyMessageMeta(node, message, {
    role,
    variant,
    roleLabelForMessageFn: roleLabelForMessage,
    formatMessageTimeFn: formatMessageTime,
  });
}

function renderMessageContent(node, message, renderedBody) {
  renderTraceHelpers.renderMessageContent(node, message, renderedBody, {
    renderToolTraceBodyFn: renderToolTraceBody,
    renderBodyFn: renderBody,
  });
}

function messageStableKey(message, index = 0) {
  return renderTraceHelpers.messageStableKey(message, index);
}

function upsertMessageNode(node, message) {
  return renderTraceHelpers.upsertMessageNode(node, message, {
    cleanDisplayTextFn: cleanDisplayText,
    shouldSkipMessageRenderFn: shouldSkipMessageRender,
    messageVariantForRoleFn: messageVariantForRole,
    applyMessageMetaFn: applyMessageMeta,
    renderMessageContentFn: renderMessageContent,
  });
}

function createMessageNode(message, { index = 0 } = {}) {
  return renderTraceHelpers.createMessageNode(message, {
    index,
    templateElement: template,
    upsertMessageNodeFn: upsertMessageNode,
    messageStableKeyFn: messageStableKey,
  });
}

function appendMessages(fragment, messages, startIndex = 0) {
  renderTraceHelpers.appendMessages(fragment, messages, {
    startIndex,
    createMessageNodeFn: createMessageNode,
  });
}

function isNearBottom(element, threshold = 24) {
  return historyRenderController.isNearBottom(element, threshold);
}

function shouldVirtualizeHistory(historyLength) {
  return historyRenderController.shouldVirtualizeHistory(historyLength);
}

function getEstimatedMessageHeight(chatId) {
  return historyRenderController.getEstimatedMessageHeight(chatId);
}

function updateVirtualMetrics(chatId) {
  return historyRenderController.updateVirtualMetrics(chatId);
}

function updateJumpLatestVisibility() {
  return historyRenderController.updateJumpLatestVisibility();
}

function markStreamUpdate(chatId) {
  return historyRenderController.markStreamUpdate(chatId);
}

function computeVirtualRange({ total, scrollTop, viewportHeight, forceBottom, estimatedHeight }) {
  return historyRenderController.computeVirtualRange({
    total,
    scrollTop,
    viewportHeight,
    forceBottom,
    estimatedHeight,
  });
}

function renderVirtualizedHistory(targetChatId, history, {
  prevScrollTop,
  preserveViewport,
  forceBottom,
  shouldStick,
  estimatedHeight,
}) {
  return historyRenderController.renderVirtualizedHistory(targetChatId, history, {
    prevScrollTop,
    preserveViewport,
    forceBottom,
    shouldStick,
    estimatedHeight,
  });
}

function renderFullHistory(targetChatId, history) {
  return historyRenderController.renderFullHistory(targetChatId, history);
}

function tryAppendOnlyRender(targetChatId, history, {
  preserveViewport,
  forceBottom,
  isSameRenderedChat,
  shouldVirtualize,
  prevScrollTop,
  wasNearBottom,
}) {
  return historyRenderController.tryAppendOnlyRender(targetChatId, history, {
    preserveViewport,
    forceBottom,
    isSameRenderedChat,
    shouldVirtualize,
    prevScrollTop,
    wasNearBottom,
  });
}

function restoreMessageViewport(targetChatId, {
  forceBottom,
  preserveViewport,
  isSameRenderedChat,
  shouldStick,
  prevScrollTop,
}) {
  return historyRenderController.restoreMessageViewport(targetChatId, {
    forceBottom,
    preserveViewport,
    isSameRenderedChat,
    shouldStick,
    prevScrollTop,
  });
}

function finalizeRenderMessages(targetChatId, history, { shouldVirtualize, forceBottom }) {
  return historyRenderController.finalizeRenderMessages(targetChatId, history, { shouldVirtualize, forceBottom });
}

function renderMessages(chatId, { preserveViewport = false, forceBottom = false } = {}) {
  return historyRenderController.renderMessages(chatId, { preserveViewport, forceBottom });
}

function normalizeChat(chat, { forcePinned = null } = {}) {
  return chatTabsController.normalizeChat(chat, { forcePinned });
}

function suppressBlockedChatPending(chatId) {
  const key = Number(chatId);
  if (!key || !reconnectResumeBlockedChats.has(key)) return;
  pendingChats.delete(key);
  const chat = chats.get(key);
  if (chat) {
    chat.pending = false;
  }
}

function clearReconnectResumeBlock(chatId) {
  const key = Number(chatId);
  if (!key) return;
  reconnectResumeBlockedChats.delete(key);
}

function blockReconnectResume(chatId) {
  const key = Number(chatId);
  if (!key) return;
  reconnectResumeBlockedChats.add(key);
  suppressBlockedChatPending(key);
}

function upsertChat(chat) {
  const next = chatTabsController.upsertChat(chat);
  const chatIdValue = (next?.id ?? chat?.id ?? 0);
  const key = Number(chatIdValue);
  const cooldownUntil = Number(resumeCooldownUntilByChat.get(key) || 0);
  if (key > 0 && cooldownUntil > Date.now()) {
    const synced = chats.get(key);
    if (synced && typeof synced === 'object') {
      synced.pending = false;
    }
  }
  suppressBlockedChatPending(next?.id ?? chat?.id);
  return next;
}

function syncPinnedChats(chatList) {
  return chatTabsController.syncPinnedChats(chatList);
}

function syncChats(chatList) {
  const next = chatTabsController.syncChats(chatList);
  const now = Date.now();
  for (const [chatId, until] of resumeCooldownUntilByChat.entries()) {
    const key = Number(chatId);
    const cooldownUntil = Number(until || 0);
    if (!key || cooldownUntil <= now) continue;
    const chat = chats.get(key);
    if (chat && typeof chat === 'object') {
      chat.pending = false;
    }
  }
  for (const blockedChatId of reconnectResumeBlockedChats) {
    suppressBlockedChatPending(blockedChatId);
  }
  return next;
}

function getOrCreateTabNode(chatId) {
  return chatUiHelpers.getOrCreateTabNode({
    tabNodes,
    tabTemplate,
    chatId,
  });
}

function getTabBadgeState(chat) {
  const badgeState = chatUiHelpers.getTabBadgeState({
    chat,
    pendingChats,
    unseenStreamChats,
  });
  const chatId = Number(chat?.id || 0);
  if (chatId > 0) {
    const unread = Math.max(0, Number(chat?.unread_count || 0));
    const pending = pendingChats.has(chatId) || Boolean(chat?.pending);
    const unseen = unseenStreamChats.has(chatId);
    if (pending || unread > 0 || unseen || chatId === Number(activeChatId)) {
      renderTraceLog("tab-badge-state", {
        chatId,
        activeChatId: Number(activeChatId),
        pending,
        unread,
        unseen,
        badgeText: String(badgeState?.text || ""),
        badgeClasses: Array.isArray(badgeState?.classes) ? badgeState.classes.slice() : [],
      });
    }
  }
  return badgeState;
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

function getStoredPinnedChatsCollapsed() {
  return chatTabsController.getStoredPinnedChatsCollapsed();
}

function persistPinnedChatsCollapsed() {
  return chatTabsController.persistPinnedChatsCollapsed();
}

function syncPinnedChatsCollapseUi() {
  return chatTabsController.syncPinnedChatsCollapseUi();
}

function maybeAutoCollapsePinnedChats() {
  return chatTabsController.maybeAutoCollapsePinnedChats();
}

function setPinnedChatsCollapsed(nextCollapsed, { persist = true } = {}) {
  return chatTabsController.setPinnedChatsCollapsed(nextCollapsed, { persist });
}

function togglePinnedChatsCollapsed() {
  return chatTabsController.togglePinnedChatsCollapsed();
}

function renderPinnedChats() {
  return chatTabsController.renderPinnedChats();
}

function syncPinChatButton() {
  return chatTabsController.syncPinChatButton();
}

function refreshTabNode(chatId) {
  const key = Number(chatId);
  const chat = chats.get(key);
  renderTraceLog("tab-refresh-request", {
    chatId: key,
    activeChatId: Number(activeChatId),
    pendingLocal: pendingChats.has(key),
    pendingServer: Boolean(chat?.pending),
    unread: Math.max(0, Number(chat?.unread_count || 0)),
    unseen: unseenStreamChats.has(key),
  });
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
  return visibilitySkinController.normalizeSkin(value);
}

function getStoredSkin() {
  return visibilitySkinController.getStoredSkin();
}

function setSkin(skin, options = {}) {
  return visibilitySkinController.setSkin(skin, options);
}

function syncSkinFromStorage() {
  return visibilitySkinController.syncSkinFromStorage();
}

function syncActivePendingStatus() {
  return streamActivityController.syncActivePendingStatus();
}

const activeChatMetaController = chatHistoryHelpers.createMetaController({
  getActiveChatId: () => activeChatId,
  setActiveChatId: (value) => {
    activeChatId = value == null ? null : Number(value);
  },
  getRenderedChatId: () => renderedChatId,
  setRenderedChatId: (value) => {
    renderedChatId = value == null ? null : Number(value);
  },
  chatScrollTop,
  chatStickToBottom,
  messagesEl,
  isNearBottomFn: isNearBottom,
  setDraft,
  promptEl,
  activeChatName,
  panelTitle,
  template,
  nowStamp,
  renderBody,
  historyCount,
  updateComposerState,
  syncPinChatButton,
  renderTabs,
  syncActiveTabSelection,
  syncLiveToolStreamForChat,
  syncActivePendingStatus,
  syncActiveLatencyChip,
  updateJumpLatestVisibility,
  getDraft,
  chats,
  scheduleTimeout: (...args) => setTimeout(...args),
});

function setActiveChatMeta(chatId, options = {}) {
  return activeChatMetaController.setActiveChatMeta(chatId, options);
}

function setNoActiveChatMeta() {
  return activeChatMetaController.setNoActiveChatMeta();
}

function updateComposerState() {
  const state = composerStateHelpers.deriveComposerState({
    activeChatId,
    pendingChats,
    chats,
    isAuthenticated,
  });
  composerStateHelpers.applyComposerState({
    state,
    sendButton,
    promptEl,
    removeChatButton,
    pinChatButton,
  });
}

function setStreamAbortController(chatId, controller) {
  streamController.setStreamAbortController(chatId, controller);
}

function clearStreamAbortController(chatId, controller) {
  streamController.clearStreamAbortController(chatId, controller);
}

function setStreamFocusRestoreEligibility(chatId, eligible) {
  streamController.setFocusRestoreEligibility(chatId, eligible);
}

function hasLiveStreamController(chatId) {
  return streamController.hasLiveStreamController(chatId);
}

function abortStreamController(chatId) {
  return streamController.abortStreamController(chatId);
}

function getStreamAbortControllers() {
  return streamController.getAbortControllers();
}

async function apiPost(url, payload) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(authPayload(payload)),
  });
  const data = await safeReadJson(response);
  if (!response.ok || !data?.ok) {
    const fallbackText = data?.error || summarizeUiFailure("", {
      status: response.status,
      fallback: `Request failed: ${response.status}`,
    });
    const message = summarizeUiFailure(data?.error || "", {
      status: response.status,
      fallback: fallbackText,
    });
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
  return chatHistoryController.refreshChats();
}

const chatHistoryController = chatHistoryHelpers.createController({
  apiPost,
  histories,
  chats,
  prefetchingHistories,
  upsertChat,
  setActiveChatMeta,
  renderMessages,
  hasLiveStreamController,
  abortStreamController,
  mergeHydratedHistory: runtimeHelpers.mergeHydratedHistory,
  refreshTabNode,
  getActiveChatId: () => Number(activeChatId),
  resumePendingChatStream,
  appendSystemMessage,
  getLastOpenChatRequestId: () => lastOpenChatRequestId,
  setLastOpenChatRequestId: (value) => {
    lastOpenChatRequestId = Number(value) || 0;
  },
  scheduleTimeout: (callback, delay) => window.setTimeout(callback, delay),
  requestIdle: typeof window.requestIdleCallback === 'function'
    ? (callback, options) => window.requestIdleCallback(callback, options)
    : null,
  runAfterUiMutation,
  getIsAuthenticated: () => Boolean(isAuthenticated),
  isNearBottomFn: isNearBottom,
  messagesContainer: messagesEl,
  unseenStreamChats,
  markReadInFlight,
  renderTabs,
  syncChats,
  syncPinnedChats,
  renderPinnedChats,
  syncActivePendingStatus,
  updateComposerState,
  pendingChats,
  finalizeHydratedPendingState: (chatId) => {
    finalizeStreamPendingState(chatId, false);
  },
  restorePendingStreamSnapshot,
  shouldResumeOnVisibilityChange: (args = {}) => {
    if (reconnectResumeBlockedChats.has(Number(args?.activeChatId))) {
      return false;
    }
    return runtimeHelpers.shouldResumeOnVisibilityChange(args);
  },
});

const chatAdminController = chatAdminHelpers.createController({
  windowObject: window,
  settingsModal,
  chatTitleModal,
  chatTitleForm,
  chatTitleHint,
  chatTitleInput,
  chatTitleCancel,
  chatTitleConfirm,
  chatTitleTagLabel,
  chatTitleTagRow,
  chatTitleTagButtons,
  chatTabContextMenu,
  chatTabContextFork,
  apiPost,
  chats,
  pinnedChats,
  histories,
  pendingChats,
  latencyByChat,
  streamPhaseByChat,
  unseenStreamChats,
  normalizeChat,
  clearChatStreamState,
  upsertChat,
  syncChats,
  syncPinnedChats,
  setActiveChatMeta,
  setNoActiveChatMeta,
  renderMessages,
  renderTabs,
  renderPinnedChats,
  syncPinChatButton,
  chatLabel,
  getActiveChatId: () => Number(activeChatId),
  openChat,
  onLatencyByChatMutated: persistLatencyByChatToStorage,
});

const shellUiController = shellUiHelpers.createController({
  tg,
  pendingChats,
  fullscreenAppTopButton,
  appendSystemMessage,
  scheduleTimeout: (callback, delay) => window.setTimeout(callback, delay),
});

const composerViewportController = composerViewportHelpers.createController({
  windowObject: window,
  documentObject: document,
  tg,
  promptEl,
  form,
  messagesEl,
  tabsEl,
  toolStreamEl,
  mobileQuoteMode,
  isNearBottomFn: isNearBottom,
  getActiveChatId: () => Number(activeChatId),
  chatScrollTop,
  chatStickToBottom,
  updateJumpLatestVisibility,
});

const latencyViewController = runtimeHelpers.createLatencyController({
  latencyByChat,
  getActiveChatId: () => Number(activeChatId),
  setActivityChip,
  preserveViewportDuringUiMutation,
  latencyChip,
  streamDebugLog,
});

const streamActivityController = runtimeHelpers.createStreamActivityController({
  chats,
  getActiveChatId: () => Number(activeChatId),
  hasLiveStreamController,
  chatLabel,
  compactChatLabel,
  setStreamStatus,
  setActivityChip,
  streamChip,
  latencyChip,
  setChatLatency,
  syncActiveLatencyChip,
});

const visibilitySkinController = visibilitySkinHelpers.createController({
  windowObject: window,
  documentObject: document,
  localStorageRef: localStorage,
  fetchImpl: (...args) => fetch(...args),
  devConfig,
  pendingChats,
  skinStorageKey: SKIN_STORAGE_KEY,
  allowedSkins: ALLOWED_SKINS,
  skinSyncChannel,
  body,
  skinName,
  panelHint,
  skinButtons,
  getCurrentSkin: () => currentSkin,
  setCurrentSkin: (value) => {
    currentSkin = String(value || "");
  },
  syncTelegramChromeForSkin,
  getIsAuthenticated: () => isAuthenticated,
  getActiveChatId: () => Number(activeChatId),
  refreshChats,
  syncVisibleActiveChat,
  syncActiveMessageView,
  getStreamAbortControllers,
});

const startupBindingsController = startupBindingsHelpers.createController({
  windowObject: window,
  documentObject: document,
  tabsEl,
  pinnedChatsEl,
  pinnedChatsToggleButton,
  messagesEl,
  jumpLatestButton,
  jumpLastStartButton,
  skinButtons,
  newChatButton,
  renameChatButton,
  pinChatButton,
  removeChatButton,
  fullscreenAppTopButton,
  closeAppTopButton,
  renderTraceBadge,
  settingsButton,
  devSignInButton,
  settingsClose,
  settingsModal,
  authStatusEl: authStatus,
  getActiveChatId: () => Number(activeChatId),
  getRenderedChatId: () => Number(renderedChatId),
  isNearBottomFn: isNearBottom,
  chatScrollTop,
  chatStickToBottom,
  unseenStreamChats,
  histories,
  shouldVirtualizeHistoryFn: shouldVirtualizeHistory,
  scheduleActiveMessageView,
  refreshTabNode,
  maybeMarkRead,
  updateJumpLatestVisibility,
  syncActiveMessageView,
  cancelSelectionQuoteSync,
  cancelSelectionQuoteSettle,
  cancelSelectionQuoteClear,
  clearSelectionQuoteState,
  handleTabClick,
  handlePinnedChatClick,
  togglePinnedChatsCollapsed,
  handleGlobalTabCycle,
  handleGlobalArrowJump,
  handleGlobalComposerFocusShortcut,
  handleGlobalChatActionShortcut,
  handleGlobalControlEnterDefuse,
  handleGlobalControlMouseDownFocusGuard,
  handleGlobalControlClickFocusCleanup,
  handleFullscreenToggle,
  handleCloseApp,
  handleRenderTraceBadgeClick,
  openSettingsModal,
  closeSettingsModal,
  signInWithDevAuth,
  appendSystemMessage,
  syncDevAuthUi,
  reportUiError,
  getIsAuthenticated: () => isAuthenticated,
  saveSkinPreference,
  createChat,
  renameActiveChat,
  toggleActiveChatPin,
  removeActiveChat,
});

function historiesDiffer(currentHistory, incomingHistory) {
  return chatHistoryController.historiesDiffer(currentHistory, incomingHistory);
}

async function hydrateChatFromServer(targetChatId, requestId, hadCachedHistory) {
  return chatHistoryController.hydrateChatFromServer(targetChatId, requestId, hadCachedHistory);
}

async function openChat(chatId) {
  return chatHistoryController.openChat(chatId);
}

async function markRead(chatId) {
  return chatHistoryController.markRead(chatId);
}

function getStreamPhase(chatId) {
  return getStreamPhaseFromState({ streamPhaseByChat, chatId });
}

function setStreamPhase(chatId, phase) {
  const key = Number(chatId);
  if (!key) return STREAM_PHASES.IDLE;
  const next = setStreamPhaseInState({ streamPhaseByChat, chatId: key, phase });
  renderTraceLog("stream-phase", { chatId: key, phase: next });
  return next;
}

function messageStableKeyForPendingState(message, index = 0, pendingState = false) {
  return renderTraceHelpers.messageStableKeyForPendingState(message, index, pendingState);
}

function findLatestHistoryMessageByRole(chatId, role, { pendingOnly = null } = {}) {
  return renderTraceHelpers.findLatestHistoryMessageByRole(histories.get(Number(chatId)) || [], role, {
    pendingOnly,
    messageStableKeyFn: messageStableKey,
    messageStableKeyForPendingStateFn: messageStableKeyForPendingState,
  });
}

function findLatestAssistantHistoryMessage(chatId, { pendingOnly = null } = {}) {
  return renderTraceHelpers.findLatestAssistantHistoryMessage(histories.get(Number(chatId)) || [], {
    pendingOnly,
    messageStableKeyFn: messageStableKey,
    messageStableKeyForPendingStateFn: messageStableKeyForPendingState,
  });
}

function findMessageNodeByKey(selector, messageKey, alternateMessageKey = "") {
  return renderTraceHelpers.findMessageNodeByKey(messagesEl, selector, messageKey, alternateMessageKey);
}

function patchVisiblePendingAssistant(chatId, nextBody, pendingState = true) {
  return renderTraceHelpers.patchVisiblePendingAssistant({
    chatId,
    activeChatId,
    phase: getStreamPhase(chatId),
    nextBody,
    pendingState,
    messagesContainer: messagesEl,
    history: histories.get(Number(chatId)) || [],
  }, {
    isPatchPhaseAllowedFn: isPatchPhaseAllowed,
    findLatestAssistantHistoryMessageFn: renderTraceHelpers.findLatestAssistantHistoryMessage,
    findMessageNodeByKeyFn: renderTraceHelpers.findMessageNodeByKey,
    renderTraceLogFn: renderTraceLog,
    preserveViewportDuringUiMutationFn: preserveViewportDuringUiMutation,
    renderBodyFn: renderBody,
  });
}

function patchVisibleToolTrace(chatId) {
  return renderTraceHelpers.patchVisibleToolTrace({
    chatId,
    activeChatId,
    phase: getStreamPhase(chatId),
    messagesContainer: messagesEl,
    history: histories.get(Number(chatId)) || [],
  }, {
    isPatchPhaseAllowedFn: isPatchPhaseAllowed,
    findLatestHistoryMessageByRoleFn: renderTraceHelpers.findLatestHistoryMessageByRole,
    findMessageNodeByKeyFn: renderTraceHelpers.findMessageNodeByKey,
    renderTraceLogFn: renderTraceLog,
    preserveViewportDuringUiMutationFn: preserveViewportDuringUiMutation,
    renderToolTraceBodyFn: renderToolTraceBody,
    formatMessageTimeFn: formatMessageTime,
  });
}

function maybeMarkRead(chatId, options = {}) {
  return chatHistoryController.maybeMarkRead(chatId, options);
}

async function createChat() {
  return chatAdminController.createChat();
}

async function renameActiveChat() {
  return chatAdminController.renameActiveChat();
}

function ensureSilentCloseTabAllowed(chatId) {
  // Product intent: closing a chat tab is intentionally silent.
  // Keep this non-interactive (no modal/toast confirmations) and rely on
  // server-side guards + pending-state checks for safety.
  return chatAdminController.ensureSilentCloseTabAllowed(chatId);
}

async function removeActiveChat() {
  return chatAdminController.removeActiveChat();
}

async function openPinnedChat(chatId) {
  return chatAdminController.openPinnedChat(chatId);
}

async function toggleActiveChatPin() {
  return chatAdminController.toggleActiveChatPin();
}

function addLocalMessage(chatId, message) {
  return chatHistoryController.addLocalMessage(chatId, message);
}

function updatePendingAssistant(chatId, nextBody, pendingState = true) {
  const result = chatHistoryController.updatePendingAssistant(chatId, nextBody, pendingState);
  persistPendingStreamSnapshot(chatId);
  if (!pendingState) {
    clearPendingStreamSnapshot(chatId);
  }
  return result;
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
  return chatHistoryController.syncActiveMessageView(chatId, options);
}

function scheduleActiveMessageView(chatId) {
  return chatHistoryController.scheduleActiveMessageView(chatId);
}

async function loadChatHistory(chatId, options = {}) {
  return chatHistoryController.loadChatHistory(chatId, options);
}

function prefetchChatHistory(chatId) {
  if (!isAuthenticated) return;
  return chatHistoryController.prefetchChatHistory(chatId);
}

function warmChatHistoryCache() {
  return chatHistoryController.warmChatHistoryCache();
}

function getMissingBootstrapBindings() {
  const requiredBindings = [
    ["status chip", authStatus, "#auth-status"],
    ["operator name", operatorName, "#operator-name"],
    ["chat tabs", tabsEl, "#chat-tabs"],
    ["message log", messagesEl, "#messages"],
    ["composer form", form, "#chat-form"],
    ["composer input", promptEl, "#prompt"],
    ["send button", sendButton, "#send-button"],
    ["message template", template, "#message-template"],
  ];
  return requiredBindings
    .filter(([, node]) => !node)
    .map(([label, , selector]) => `${label} (${selector})`);
}

function reportBootstrapMismatch(reason, details = []) {
  const suffix = Array.isArray(details) && details.length ? ` Missing: ${details.join(", ")}.` : "";
  const message = `${reason}.${suffix} Reload the mini app to refresh assets.`;
  if (authStatus) {
    authStatus.textContent = "Client bootstrap mismatch";
    authStatus.title = message;
  }
  if (messagesEl && template) {
    appendSystemMessage(message);
    return;
  }
  console.error("[miniapp/bootstrap]", message);
}

const RESUME_RECOVERY_MAX_ATTEMPTS = 3;
const RESUME_RECOVERY_BASE_DELAY_MS = 900;
const RESUME_REATTACH_MIN_INTERVAL_MS = 1200;
const RESUME_COMPLETE_SETTLE_MS = 2500;
const RESUME_RECOVERY_TRANSIENT_ERROR_RE = /load failed|failed to fetch|network(?:error| failure| request failed)?|the network connection was lost|fetch failed|temporarily unavailable/i;

function delayMs(ms) {
  return new Promise((resolve) => window.setTimeout(resolve, Math.max(0, Number(ms) || 0)));
}

function isTransientResumeRecoveryError(error) {
  const message = String(error?.message || error || "").trim();
  return RESUME_RECOVERY_TRANSIENT_ERROR_RE.test(message);
}

function nextResumeRecoveryDelayMs(attempt) {
  const normalizedAttempt = Math.max(1, Number(attempt) || 1);
  const jitterMs = Math.floor(Math.random() * 180);
  return RESUME_RECOVERY_BASE_DELAY_MS * normalizedAttempt + jitterMs;
}

function isRetryableAuthBootstrapFailure(response, data) {
  const status = Number(response?.status || 0);
  if (!status) return true;
  if (AUTH_BOOTSTRAP_RETRYABLE_STATUS.has(status)) return true;
  const text = String(data?.error || "");
  return /temporarily unavailable|try again|timeout/i.test(text);
}

async function fetchAuthBootstrapWithRetry() {
  let lastResponse = null;
  let lastData = null;
  let lastError = null;

  recordBootMetric("authBootstrapStartMs");
  syncBootLatencyChip("auth-request");

  for (let attempt = 1; attempt <= AUTH_BOOTSTRAP_MAX_ATTEMPTS; attempt += 1) {
    try {
      const response = await fetch("/api/auth", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ init_data: initData, allow_empty: true }),
      });
      const data = await safeReadJson(response);
      if (response.ok && data?.ok) {
        recordBootMetric("authBootstrapSuccessMs");
        logBootStage("auth-bootstrap-ok", { attempt, status: response.status });
        return { response, data };
      }
      lastResponse = response;
      lastData = data;
      if (!isRetryableAuthBootstrapFailure(response, data) || attempt >= AUTH_BOOTSTRAP_MAX_ATTEMPTS) {
        recordBootMetric("authBootstrapFailureMs");
        logBootStage("auth-bootstrap-failed", { attempt, status: response.status, retryable: false });
        return { response, data };
      }
    } catch (error) {
      lastError = error;
      if (attempt >= AUTH_BOOTSTRAP_MAX_ATTEMPTS) {
        break;
      }
    }

    const jitterMs = Math.floor(Math.random() * 120);
    const backoffMs = AUTH_BOOTSTRAP_BASE_DELAY_MS * attempt + jitterMs;
    await delayMs(backoffMs);
  }

  if (lastResponse) {
    return { response: lastResponse, data: lastData };
  }
  if (lastError) {
    recordBootMetric("authBootstrapErrorMs");
    throw lastError;
  }
  recordBootMetric("authBootstrapErrorMs");
  throw new Error("Session bootstrap failed before response.");
}

async function maybeRefreshForBootstrapVersionMismatch() {
  if (!bootBootstrapVersion) return false;

  try {
    const response = await fetch("/api/state", {
      method: "GET",
      cache: "no-store",
      headers: { "Cache-Control": "no-cache" },
    });
    const data = await safeReadJson(response);
    if (!response.ok || !data?.ok) {
      return false;
    }
    const serverVersion = String(data?.bootstrap_version || "").trim();
    if (!serverVersion || serverVersion === bootBootstrapVersion) {
      if (window.sessionStorage) {
        window.sessionStorage.removeItem(BOOTSTRAP_VERSION_RELOAD_STORAGE_KEY);
      }
      return false;
    }

    const reloadMarker = `${bootBootstrapVersion}->${serverVersion}`;
    const priorMarker = window.sessionStorage?.getItem(BOOTSTRAP_VERSION_RELOAD_STORAGE_KEY) || "";
    if (priorMarker === reloadMarker) {
      return false;
    }
    window.sessionStorage?.setItem(BOOTSTRAP_VERSION_RELOAD_STORAGE_KEY, reloadMarker);

    if (authStatus) {
      authStatus.textContent = "Refreshing app…";
      authStatus.title = "Detected a newer app build. Reloading once to sync assets.";
    }
    const target = `${window.location.pathname}?v=${encodeURIComponent(serverVersion)}`;
    window.location.replace(target);
    return true;
  } catch {
    return false;
  }
}

async function bootstrap() {
  logBootStage("bootstrap-start", { hasTelegram: Boolean(tg) });
  if (authStatus) {
    authStatus.textContent = tg ? "Opening Hermes…" : "Waiting for Telegram…";
  }
  syncBootLatencyChip("bootstrap-start");

  if (tg) {
    try {
      tg.ready?.();
      tg.expand?.();
      logBootStage("telegram-webapp-ready");
    } catch {
      // Non-fatal: proceed with auth even when client WebApp helpers partially fail.
    }
  }

  syncRenderTraceBadge();
  loadDraftsFromStorage();
  syncClosingConfirmation();
  syncFullscreenControlState();
  syncDevAuthUi();
  try {
    tg.onEvent?.("fullscreenChanged", syncFullscreenControlState);
    tg.onEvent?.("fullscreenFailed", () => appendSystemMessage("Fullscreen request was denied by Telegram client."));
  } catch {
    // Optional event hooks vary across Telegram clients.
  }
  initData = tg?.initData || "";
  renderTraceLog("debug-enabled", {
    enabled: renderTraceDebugEnabled,
    toggleHint: "Open Settings and tap Render Trace to toggle logging",
  });

  const missingBindings = getMissingBootstrapBindings();
  if (missingBindings.length) {
    reportBootstrapMismatch("Required startup bindings are missing", missingBindings);
    syncDevAuthUi();
    updateComposerState();
    revealShell();
    return;
  }

  if (await maybeRefreshForBootstrapVersionMismatch()) {
    revealShell();
    return;
  }

  try {
    const { response, data } = await fetchAuthBootstrapWithRetry();

    if (!response.ok || !data?.ok) {
      if (desktopTestingEnabled) {
        const autoSignedIn = await signInWithDevAuth({ interactive: false });
        if (autoSignedIn) {
          return;
        }
        authStatus.textContent = "Desktop testing ready";
        appendSystemMessage(data?.error || "Use /app#dev-auth to open Dev sign-in outside Telegram.");
        return;
      }
      if (desktopTestingRequested && !Boolean(devConfig.devAuthEnabled)) {
        authStatus.textContent = "Debug sign-in unavailable";
        appendSystemMessage("Dev auth is currently disabled. Enable the bypass flag, then reload /app#dev-auth.");
        return;
      }
      authStatus.textContent = "Sign-in failed";
      appendSystemMessage(data?.error || (tg ? "Sign-in failed." : "Open this mini app from Telegram."));
      return;
    }

    applyAuthBootstrap(data, { preferredUsername: tg?.initDataUnsafe?.user?.username || "" });
    logBootStage("auth-bootstrap-applied", {
      activeChatId: Number(data?.active_chat_id || 0),
      chatCount: Array.isArray(data?.chats) ? data.chats.length : 0,
    });
    const restoredPendingSnapshot = Number(data?.active_chat_id || 0) > 0 && Boolean(data?.chats?.find?.((chat) => Number(chat?.id) === Number(data.active_chat_id))?.pending)
      ? restorePendingStreamSnapshot(Number(data.active_chat_id))
      : false;
    if (restoredPendingSnapshot && Number(data?.active_chat_id || 0) > 0) {
      renderMessages(Number(data.active_chat_id), { preserveViewport: true });
    }
  } catch (error) {
    recordBootMetric("bootstrapErrorMs");
    authStatus.textContent = "Sign-in error";
    appendSystemMessage(`Could not start the app: ${error.message}`);
  } finally {
    syncDevAuthUi();
    updateComposerState();
    revealShell();
    logBootStage("bootstrap-finished", { authenticated: Boolean(isAuthenticated) });
  }
}

async function saveSkinPreference(skin) {
  const data = await apiPost("/api/preferences/skin", { skin });
  setSkin(data.skin);
}

const streamController = streamControllerHelpers.createController({
  parseSseEvent,
  formatLatency,
  STREAM_PHASES,
  getStreamPhase,
  setStreamPhase,
  isPatchPhaseAllowed,
  chats,
  pendingChats,
  chatLabel,
  compactChatLabel,
  setStreamStatus,
  setActivityChip,
  streamChip,
  latencyChip,
  finalizeInlineToolTrace,
  updatePendingAssistant,
  markStreamUpdate,
  patchVisiblePendingAssistant,
  patchVisibleToolTrace,
  renderTraceLog,
  syncActiveMessageView,
  scheduleActiveMessageView,
  setChatLatency,
  incrementUnread,
  getActiveChatId: () => Number(activeChatId),
  triggerIncomingMessageHaptic,
  messagesEl,
  promptEl,
  isMobileQuoteMode: () => mobileQuoteMode,
  isDesktopViewport,
  maybeMarkRead,
  refreshChats,
  renderTabs,
  updateComposerState,
  syncClosingConfirmation,
  appendSystemMessage,
  appendInlineToolTrace,
  streamDebugLog,
  finalizeStreamPendingState,
  loadChatHistory,
  upsertChat,
  histories,
  mergeHydratedHistory: runtimeHelpers.mergeHydratedHistory,
  renderMessages,
  persistStreamCursor: setStoredStreamCursor,
  clearStreamCursor: clearStoredStreamCursor,
  clearPendingStreamSnapshot,
});

function finalizeStreamPendingState(chatId, wasAborted) {
  const key = Number(chatId);
  const beforeChat = chats.get(key);
  renderTraceLog("stream-pending-finalize-before", {
    chatId: key,
    wasAborted: Boolean(wasAborted),
    activeChatId: Number(activeChatId),
    pendingLocal: pendingChats.has(key),
    pendingServer: Boolean(beforeChat?.pending),
    unread: Math.max(0, Number(beforeChat?.unread_count || 0)),
    unseen: unseenStreamChats.has(key),
  });
  finalizeChatStreamState({
    chatId,
    wasAborted,
    pendingChats,
    chats,
    setStreamPhase,
  });
  const afterChat = chats.get(key);
  renderTraceLog("stream-pending-finalize-after", {
    chatId: key,
    wasAborted: Boolean(wasAborted),
    activeChatId: Number(activeChatId),
    pendingLocal: pendingChats.has(key),
    pendingServer: Boolean(afterChat?.pending),
    unread: Math.max(0, Number(afterChat?.unread_count || 0)),
    unseen: unseenStreamChats.has(key),
  });
  refreshTabNode(key);
}

function applyDonePayload(chatId, payload, builtReplyRef, options = {}) {
  return streamController.applyDonePayload(chatId, payload, builtReplyRef, options);
}

function handleStreamEvent(chatId, eventName, payload, builtReplyRef) {
  return streamController.handleStreamEvent(chatId, eventName, payload, builtReplyRef);
}

function applyEarlyStreamCloseFallback(chatId, builtReplyRef, fallbackTraceEvent) {
  return streamController.applyEarlyStreamCloseFallback(chatId, builtReplyRef, fallbackTraceEvent);
}

async function consumeStreamResponse(chatId, response, builtReplyRef, options = {}) {
  return streamController.consumeStreamResponse(chatId, response, builtReplyRef, options);
}

async function finalizeStreamLifecycle(chatId, controller, { wasAborted }) {
  return streamController.finalizeStreamLifecycle(chatId, controller, { wasAborted });
}

async function hydrateChatAfterGracefulResumeCompletion(chatId) {
  return streamController.hydrateChatAfterGracefulResumeCompletion(chatId);
}

async function consumeStreamWithReconnect(chatId, response, builtReplyRef, options = {}) {
  return streamController.consumeStreamWithReconnect(chatId, response, builtReplyRef, options);
}

function focusMessagesPaneIfActiveChat(chatId) {
  if (!messagesEl) return;
  if (Number(activeChatId) !== Number(chatId) || document.visibilityState !== "visible") {
    return;
  }
  if (mobileQuoteMode || !isDesktopViewport()) return;
  try {
    messagesEl.focus({ preventScroll: true });
  } catch {
    messagesEl.focus();
  }
}

async function sendPrompt(message) {
  if (!isAuthenticated || !activeChatId) {
    appendSystemMessage("Still signing you in. Try again in a moment.");
    return;
  }

  const cleaned = message.trim();
  if (!cleaned) return;

  const chatId = Number(activeChatId);
  if (reconnectResumeBlockedChats.has(chatId)) {
    clearReconnectResumeBlock(chatId);
    suppressBlockedChatPending(chatId);
  }
  const serverPending = Boolean(chats.get(chatId)?.pending);
  if (pendingChats.has(chatId) || serverPending) {
    appendSystemMessage(`Still replying in '${chatLabel(chatId)}'.`);
    return;
  }

  markChatStreamPending({
    chatId,
    pendingChats,
    chats,
    setStreamPhase,
  });
  syncClosingConfirmation();
  renderTabs();
  updateComposerState();

  addLocalMessage(chatId, { role: "operator", body: cleaned, created_at: new Date().toISOString() });
  if (chatId === Number(activeChatId)) {
    promptEl.value = "";
    setDraft(chatId, "");
  }
  syncActiveMessageView(chatId, { preserveViewport: true });
  focusMessagesPaneIfActiveChat(chatId);

  clearStoredStreamCursor(chatId);
  clearPendingStreamSnapshot(chatId);
  resetToolStream();
  streamActivityController.markStreamActive(chatId);

  const builtReplyRef = { value: "" };
  let wasAborted = false;
  const streamController = new AbortController();
  const shouldRestoreFocusOnComplete = Boolean(
    Number(activeChatId) === chatId
    && document.activeElement === promptEl
    && isNearBottom(messagesEl, 40),
  );
  setStreamFocusRestoreEligibility(chatId, shouldRestoreFocusOnComplete);
  setStreamAbortController(chatId, streamController);

  try {
    const response = await fetch("/api/chat/stream", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(authPayload({ chat_id: chatId, message: cleaned })),
      signal: streamController.signal,
    });

    if (!response.ok || !response.body) {
      const fallback = await response.text();
      const parsedError = parseStreamErrorPayload(fallback);
      const alreadyWorking = response.status === 409;
      const sanitizedFallbackMessage = summarizeUiFailure(parsedError.error || fallback, {
        status: response.status,
        fallback: "Hermes call failed.",
      });
      if (alreadyWorking) {
        await resumePendingChatStream(chatId, { force: true });
        return;
      }

      setStreamPhase(chatId, STREAM_PHASES.ERROR);
      if (/Telegram init data is too old/i.test(parsedError.error || fallback || "")) {
        isAuthenticated = false;
        authStatus.textContent = "Session expired";
        updatePendingAssistant(chatId, "Telegram session expired. Close and reopen the mini app to refresh auth.", false);
        updateComposerState();
      } else {
        updatePendingAssistant(chatId, sanitizedFallbackMessage, false);
      }
      syncActiveMessageView(chatId, { preserveViewport: true });
      streamActivityController.markStreamError();
      return;
    }

    const resumed = await consumeStreamWithReconnect(chatId, response, builtReplyRef, {
      fallbackTraceEvent: "stream-fallback-patch",
      resetReplayCursor: true,
      onEarlyClose: async () => {
        await resumePendingChatStream(chatId, { force: true });
      },
    });
    if (resumed) return;
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
    streamActivityController.markNetworkFailure();
  } finally {
    await finalizeStreamLifecycle(chatId, streamController, { wasAborted });
  }
}

async function resumePendingChatStream(chatId, { force = false } = {}) {
  const key = Number(chatId);
  if (!key || !isAuthenticated) return;
  try {
  if (reconnectResumeBlockedChats.has(key)) {
    suppressBlockedChatPending(key);
    renderTabs();
    updateComposerState();
    syncActivePendingStatus();
    return;
  }
  const now = Date.now();
  const cooldownUntil = Number(resumeCooldownUntilByChat.get(key) || 0);
  if (cooldownUntil > now) {
    return;
  }
  if (resumeInFlightByChat.has(key)) {
    return;
  }
  const hasLiveController = hasLiveStreamController(key);
  if (hasLiveController && !force) return;
  const lastAttemptAt = Number(resumeAttemptedAtByChat.get(key) || 0);
  if (lastAttemptAt > 0 && (now - lastAttemptAt) < RESUME_REATTACH_MIN_INTERVAL_MS) {
    return;
  }
  const chatPending = Boolean(chats.get(key)?.pending);
  if (!chatPending && !force) return;

  resumeInFlightByChat.add(key);
  resumeAttemptedAtByChat.set(key, now);

  if (force && hasLiveController) {
    abortStreamController(key);
  }

  markChatStreamPending({
    chatId: key,
    pendingChats,
    chats,
    setStreamPhase,
  });
  syncClosingConfirmation();
  renderTabs();
  updateComposerState();

  if (Number(activeChatId) === key) {
    streamActivityController.markStreamReconnecting(key, {
      attempt: 1,
      maxAttempts: RESUME_RECOVERY_MAX_ATTEMPTS,
    });
  }

  const builtReplyRef = { value: "" };

  for (let attempt = 1; attempt <= RESUME_RECOVERY_MAX_ATTEMPTS; attempt += 1) {
    let wasAborted = false;
    const streamController = new AbortController();
    setStreamFocusRestoreEligibility(key, false);
    setStreamAbortController(key, streamController);

    try {
      const response = await fetch("/api/chat/stream/resume", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(authPayload({ chat_id: key, after_event_id: getStoredStreamCursor(key) })),
        signal: streamController.signal,
      });

      if (!response.ok || !response.body) {
        const fallback = await response.text();
        const sanitizedResumeFailure = summarizeUiFailure(fallback, {
          status: response.status,
          fallback: `Resume failed: ${response.status}`,
        });
        const noActiveJob = response.status === 409;
        if (noActiveJob) {
          resumeCooldownUntilByChat.set(key, Date.now() + RESUME_COMPLETE_SETTLE_MS);
          setStreamPhase(key, STREAM_PHASES.FINALIZED);
          await hydrateChatAfterGracefulResumeCompletion(key);
          triggerIncomingMessageHaptic(key, { fallbackToLatestHistory: true });
          streamActivityController.markResumeAlreadyComplete(key);
          return;
        }
        throw new Error(sanitizedResumeFailure);
      }

      const resumed = await consumeStreamWithReconnect(key, response, builtReplyRef, {
        fallbackTraceEvent: "stream-resume-fallback-patch",
        onEarlyClose: async () => {
          // Resume stream segments can early-close without terminal state on mobile/WebView.
          // Reconnect instead of finalizing local pending state.
          await resumePendingChatStream(Number(key), { force: true });
        },
      });
      if (resumed) return;
      return;
    } catch (error) {
      if (error?.name === "AbortError") {
        wasAborted = true;
        return;
      }
      const transientReconnectFailure = isTransientResumeRecoveryError(error);
      const hasAttemptsRemaining = transientReconnectFailure && attempt < RESUME_RECOVERY_MAX_ATTEMPTS;
      if (hasAttemptsRemaining) {
        console.warn(`[W_STREAM_RECONNECT_RETRY] chat=${key} attempt=${attempt}/${RESUME_RECOVERY_MAX_ATTEMPTS}`, error);
        if (Number(activeChatId) === key) {
          streamActivityController.markStreamReconnecting(key, {
            attempt: attempt + 1,
            maxAttempts: RESUME_RECOVERY_MAX_ATTEMPTS,
          });
        }
        await delayMs(nextResumeRecoveryDelayMs(attempt));
        continue;
      }

      if (transientReconnectFailure) {
        await hydrateChatAfterGracefulResumeCompletion(key);
        const stillPending = Boolean(chats.get(key)?.pending) || pendingChats.has(key);
        if (!stillPending) {
          resumeCooldownUntilByChat.set(key, Date.now() + RESUME_COMPLETE_SETTLE_MS);
          setStreamPhase(key, STREAM_PHASES.FINALIZED);
          triggerIncomingMessageHaptic(key, { fallbackToLatestHistory: true });
          streamActivityController.markResumeAlreadyComplete(key);
          return;
        }
      }

      blockReconnectResume(key);
      setStreamPhase(key, STREAM_PHASES.ERROR);
      finalizeInlineToolTrace(key);
      console.warn(`[E_STREAM_RECONNECT_FAILED] chat=${key}`, error);
      appendSystemMessage(`Could not reconnect '${chatLabel(key)}': ${error.message}`);
      appendSystemMessage(`Reconnect recovery is paused for '${chatLabel(key)}'. Send a new message to try again.`);
      renderTabs();
      updateComposerState();
      syncActivePendingStatus();
      if (Number(activeChatId) === key) {
        streamActivityController.markReconnectFailed(key);
      }
      return;
    } finally {
      await finalizeStreamLifecycle(key, streamController, { wasAborted });
    }
  }
  } finally {
    resumeInFlightByChat.delete(key);
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

function handleComposerSubmitShortcut(event) {
  interactionHelpers.handleComposerSubmitShortcut(event, {
    mobileQuoteMode,
    activeChatId,
    focusMessagesPaneIfActiveChat,
    submitPromptWithUiError,
  });
}

promptEl.addEventListener("keydown", handleComposerSubmitShortcut);

promptEl.addEventListener("input", () => {
  if (!activeChatId) return;
  setDraft(activeChatId, promptEl.value || "");
});

function createSelectionQuoteController() {
  return interactionHelpers.createSelectionQuoteController({
    mobileQuoteMode,
    windowObject: window,
    documentObject: document,
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
}

const selectionQuoteController = createSelectionQuoteController();

const messageCopyState = messageActionsHelpers.createMessageCopyState();

// Use click (not pointerdown) for clipboard writes.
// Some Telegram WebView variants reject clipboard operations on pointerdown
// but allow them on click as a trusted user activation.
messageActionsHelpers.bindMessageCopyHandler({
  messagesEl,
  messageCopyState,
  normalizeText: normalizeQuoteSelection,
  copyTextToClipboard,
});
messagesEl?.addEventListener("click", handleMessageFileRefClick);
messagesEl?.addEventListener("touchstart", handleMessageFileRefTouchStart, { passive: true });
messagesEl?.addEventListener("touchmove", handleMessageFileRefTouchMove, { passive: true });
messagesEl?.addEventListener("touchend", handleMessageFileRefClick, { passive: false });
messagesEl?.addEventListener("touchcancel", cancelPendingMessageFileRefTouch);
messagesEl?.addEventListener("scroll", cancelPendingMessageFileRefTouch, { passive: true });
filePreviewExpandUp?.addEventListener("click", () => requestFilePreviewExpansion("up"));
filePreviewLoadFull?.addEventListener("click", requestFullFilePreview);
filePreviewExpandDown?.addEventListener("click", () => requestFilePreviewExpansion("down"));
filePreviewClose?.addEventListener("click", closeFilePreviewModal);
filePreviewModal?.addEventListener?.("cancel", (event) => {
  event.preventDefault();
  closeFilePreviewModal();
});
selectionQuoteController.bind();

const keyboardShortcutsController = keyboardShortcutsHelpers.createController({
  windowObject: window,
  documentObject: document,
  messagesEl,
  promptEl,
  settingsModal,
  jumpLatestButton,
  jumpLastStartButton,
  chats,
  getActiveChatId: () => Number(activeChatId),
  getMobileQuoteMode: () => mobileQuoteMode,
  openChat,
  openPinnedChat,
  getNextChatTabId: runtimeHelpers.getNextChatTabId,
  handleJumpLatest,
  handleJumpLastStart,
  focusMessagesPaneIfActiveChat,
  createChat,
  removeActiveChat,
});

function closeChatTabContextMenu() {
  return chatAdminController.closeChatTabContextMenu();
}

function openChatTabContextMenu(chatId, clientX, clientY) {
  return chatAdminController.openChatTabContextMenu(chatId, clientX, clientY);
}

function handleTabOverflowTriggerClick(event) {
  return chatAdminController.handleTabOverflowTriggerClick(event);
}

async function handleTabContextForkClick(event) {
  return chatAdminController.handleTabContextForkClick(event);
}

function handleGlobalChatContextMenuDismiss(event) {
  return chatAdminController.handleGlobalChatContextMenuDismiss(event);
}

function getOrderedChatIds() {
  return keyboardShortcutsController.getOrderedChatIds();
}

function isTextEntryElement(element) {
  return keyboardShortcutsController.isTextEntryElement(element);
}

function isDesktopViewport() {
  return keyboardShortcutsController.isDesktopViewport();
}

function handleTabClick(event) {
  return keyboardShortcutsController.handleTabClick(event);
}

function handlePinnedChatClick(event) {
  return keyboardShortcutsController.handlePinnedChatClick(event);
}

function handleGlobalTabCycle(event) {
  return keyboardShortcutsController.handleGlobalTabCycle(event);
}

function scrollMessagesByArrow(direction) {
  return keyboardShortcutsController.scrollMessagesByArrow(direction);
}

function handleGlobalArrowJump(event) {
  return keyboardShortcutsController.handleGlobalArrowJump(event);
}

function handleGlobalComposerFocusShortcut(event) {
  return keyboardShortcutsController.handleGlobalComposerFocusShortcut(event);
}

function handleGlobalChatActionShortcut(event) {
  return keyboardShortcutsController.handleGlobalChatActionShortcut(event);
}

function shouldReleaseControlFocusAfterClick(target) {
  return keyboardShortcutsController.shouldReleaseControlFocusAfterClick(target);
}

function releaseStickyControlFocus() {
  return keyboardShortcutsController.releaseStickyControlFocus();
}

function handleGlobalControlClickFocusCleanup(event) {
  return keyboardShortcutsController.handleGlobalControlClickFocusCleanup(event);
}

function handleGlobalControlMouseDownFocusGuard(event) {
  return keyboardShortcutsController.handleGlobalControlMouseDownFocusGuard(event);
}

function handleGlobalControlEnterDefuse(event) {
  return keyboardShortcutsController.handleGlobalControlEnterDefuse(event);
}

function handleMessagesScroll() {
  return startupBindingsController.handleMessagesScroll();
}

function handleJumpLatest() {
  return startupBindingsController.handleJumpLatest();
}

function handleJumpLastStart() {
  return startupBindingsController.handleJumpLastStart();
}

function bindAsyncClick(button, action) {
  return startupBindingsController.bindAsyncClick(button, action);
}

function installCoreEventBindings() {
  return startupBindingsController.installCoreEventBindings();
}

function installActionButtonBindings() {
  return startupBindingsController.installActionButtonBindings();
}

function syncFullscreenControlState() {
  return shellUiController.syncFullscreenControlState();
}

function handleFullscreenToggle() {
  return shellUiController.handleFullscreenToggle();
}

function handleCloseApp() {
  return shellUiController.handleCloseApp();
}

function openSettingsModal() {
  return chatAdminController.openSettingsModal();
}

function closeSettingsModal() {
  return chatAdminController.closeSettingsModal();
}

function ensureComposerVisible(options = {}) {
  return composerViewportController.ensureComposerVisible(options);
}

function dismissKeyboard() {
  return composerViewportController.dismissKeyboard();
}

function installTapToDismissKeyboard() {
  return composerViewportController.installTapToDismissKeyboard();
}

function installKeyboardViewportSync() {
  return composerViewportController.installKeyboardViewportSync();
}

function installShellModalBindings() {
  return startupBindingsController.installShellModalBindings();
}

async function syncVisibleActiveChat(options = {}) {
  return chatHistoryController.syncVisibleActiveChat(options);
}

async function handleVisibilityChange() {
  return visibilitySkinController.handleVisibilityChange();
}

function installVisibilitySkinLifecycle() {
  return visibilitySkinController.installLifecycleListeners();
}

function installPendingCompletionWatchdog() {
  const intervalMs = 8000;
  window.setInterval(() => {
    if (!isAuthenticated || pendingChats.size === 0) return;
    void (async () => {
      try {
        await refreshChats();
        if (Number(activeChatId) > 0 && pendingChats.has(Number(activeChatId))) {
          await syncVisibleActiveChat({
            hidden: document.visibilityState !== "visible",
            streamAbortControllers: streamController.getAbortControllers(),
          });
        }
      } catch {
        // Best-effort watchdog: healthy streams still finalize through normal SSE handling.
      }
    })();
  }, intervalMs);
}

tabsEl?.addEventListener?.("click", handleTabOverflowTriggerClick, true);
chatTabContextFork?.addEventListener?.("click", (event) => {
  void handleTabContextForkClick(event);
});
document?.addEventListener?.("pointerdown", handleGlobalChatContextMenuDismiss, true);
document?.addEventListener?.("click", handleGlobalChatContextMenuDismiss, true);
window?.addEventListener?.("blur", closeChatTabContextMenu);
window?.addEventListener?.("resize", closeChatTabContextMenu);
window?.addEventListener?.("scroll", closeChatTabContextMenu, true);
document?.addEventListener?.("keydown", (event) => {
  if (event.key === "Escape") {
    closeChatTabContextMenu();
  }
});

installCoreEventBindings();
installActionButtonBindings();
installShellModalBindings();
installVisibilitySkinLifecycle();
installPendingCompletionWatchdog();
startDevAutoRefresh();
installTapToDismissKeyboard();
installKeyboardViewportSync();
syncPinnedChatsCollapseUi();
void bootstrap();
