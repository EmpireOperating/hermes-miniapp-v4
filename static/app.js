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

let initData = tg?.initData || "";
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
const MAX_AUTO_RESUME_CYCLES_PER_CHAT = 6;
const resumeCycleCountByChat = new Map();
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
  tabTemplate,
  tabsEl,
  clearChatStreamState,
  chatUiHelpers,
  pinnedChatsWrap,
  pinnedChatsEl,
  pinnedChatsCountEl,
  pinnedChatsToggleButton,
  pinChatButton,
  documentObject: document,
  renderTraceLog,
  getActiveChatId: () => Number(activeChatId),
  getPinnedChatsCollapsed: () => pinnedChatsCollapsed,
  setPinnedChatsCollapsedState: (value) => {
    pinnedChatsCollapsed = Boolean(value);
  },
  getHasPinnedChatsCollapsePreference: () => hasPinnedChatsCollapsePreference,
  setHasPinnedChatsCollapsePreference: (value) => {
    hasPinnedChatsCollapsePreference = Boolean(value);
  },
  resumeCooldownUntilByChat,
  reconnectResumeBlockedChats,
  resumeCycleCountByChat,
  maxAutoResumeCyclesPerChat: MAX_AUTO_RESUME_CYCLES_PER_CHAT,
  nowFn: () => Date.now(),
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
const LATENCY_STORAGE_KEY = "hermes_miniapp_latency_by_chat_v1";
let renderTraceDebugEnabled = false;

const latencyPersistenceController = runtimeHelpers.createLatencyPersistenceController({
  localStorageRef: localStorage,
  storageKey: LATENCY_STORAGE_KEY,
  latencyByChat,
  maxAgeMs: LATENCY_MAX_AGE_MS,
});
latencyPersistenceController.loadLatencyByChatFromStorage();

const streamPersistenceController = streamStateHelpers.createPersistenceController({
  localStorageRef: localStorage,
  streamResumeCursorStorageKey: STREAM_RESUME_CURSOR_STORAGE_KEY,
  pendingStreamSnapshotStorageKey: PENDING_STREAM_SNAPSHOT_STORAGE_KEY,
  pendingStreamSnapshotMaxAgeMs: PENDING_STREAM_SNAPSHOT_MAX_AGE_MS,
  histories,
  chats,
  nowFn: nowStamp,
});

const streamPhaseController = streamStateHelpers.createPhaseController({
  streamPhaseByChat,
  renderTraceLog,
});

const streamLifecycleController = streamStateHelpers.createLifecycleController({
  chats,
  pendingChats,
  unseenStreamChats,
  getActiveChatId: () => Number(activeChatId),
  setStreamPhase,
  refreshTabNode,
  renderTraceLog,
});

const draftController = composerStateHelpers.createDraftController({
  localStorageRef: localStorage,
  draftStorageKey: DRAFT_STORAGE_KEY,
  draftByChat,
});

const toolTraceController = streamControllerHelpers.createToolTraceController({
  histories,
  cleanDisplayText,
  persistPendingStreamSnapshot,
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

const messageRenderController = renderTraceHelpers.createMessageRenderController({
  cleanDisplayTextFn: cleanDisplayText,
  escapeHtmlFn: escapeHtml,
  getAllowedRoots: () => filePreviewAllowedRoots,
  documentObject: document,
  windowObject: window,
  getOperatorDisplayName: () => operatorDisplayName,
  formatMessageTimeFn: formatMessageTime,
  templateElement: template,
  getHistory: (chatId) => histories.get(Number(chatId)) || [],
  getMessagesContainer: () => messagesEl,
  getActiveChatId: () => activeChatId,
  getStreamPhase,
  isPatchPhaseAllowedFn: isPatchPhaseAllowed,
  renderTraceLogFn: renderTraceLog,
  preserveViewportDuringUiMutationFn: preserveViewportDuringUiMutation,
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
  filePreviewClose,
  messagesEl,
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

function focusComposerForNewChat(chatId) {
  return composerViewportController.focusComposerForNewChat(chatId);
}

function setChatLatency(chatId, text) {
  return latencyViewController.setChatLatency(chatId, text);
}

function syncActiveLatencyChip() {
  return latencyViewController.syncActiveLatencyChip();
}

const startupMetricsHelpers = window.HermesMiniappStartupMetrics;
if (!startupMetricsHelpers?.createController) {
  throw new Error("HermesMiniappStartupMetrics.createController is required before app bootstrap");
}

let bootMetrics = {};
let recordBootMetric = () => 0;
let syncBootLatencyChip = () => {};
let logBootStage = () => 0;
let summarizeBootMetrics = () => ({});
let revealShell = () => {};

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

const startupMetricsController = startupMetricsHelpers.createController({
  windowObject: window,
  documentObject: document,
  latencyChip,
  setActivityChip,
  formatLatency,
  consoleObject: console,
});
bootMetrics = startupMetricsController.bootMetrics;
recordBootMetric = startupMetricsController.recordBootMetric;
syncBootLatencyChip = startupMetricsController.syncBootLatencyChip;
logBootStage = startupMetricsController.logBootStage;
summarizeBootMetrics = startupMetricsController.summarizeBootMetrics;
revealShell = startupMetricsController.revealShell;
recordBootMetric("appScriptStartMs");
syncBootLatencyChip("app-script-start");

function setStreamStatus(text) {
  if (!streamStatus) return;
  streamStatus.textContent = String(text || "");
}

function setElementHidden(element, hidden) {
  return shellUiController.setElementHidden(element, hidden);
}

function syncDebugOnlyPillVisibility() {
  return shellUiController.syncDebugOnlyPillVisibility();
}

function loadLatencyByChatFromStorage() {
  return latencyPersistenceController.loadLatencyByChatFromStorage();
}

function persistLatencyByChatToStorage() {
  return latencyPersistenceController.persistLatencyByChatToStorage();
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

function hasFreshPendingStreamSnapshot(chatId) {
  return streamPersistenceController.hasFreshPendingStreamSnapshot(chatId);
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

async function apiPost(url, payload) {
  return bootstrapAuthController.apiPost(url, payload);
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
  initData,
  parseSseEvent,
  setOperatorDisplayName: (value) => {
    operatorDisplayName = String(value || "");
  },
  getOperatorDisplayName: () => operatorDisplayName,
  operatorName,
  messagesEl,
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
  hasFreshPendingStreamSnapshot,
  restorePendingStreamSnapshot,
  ensureActivationReadThreshold: (chatId, unreadCount) => chatHistoryController.ensureActivationReadThreshold(chatId, unreadCount),
  windowObject: window,
  authBootstrapMaxAttempts: AUTH_BOOTSTRAP_MAX_ATTEMPTS,
  authBootstrapBaseDelayMs: AUTH_BOOTSTRAP_BASE_DELAY_MS,
  authBootstrapRetryableStatus: AUTH_BOOTSTRAP_RETRYABLE_STATUS,
  bootBootstrapVersion,
  bootstrapVersionReloadStorageKey: BOOTSTRAP_VERSION_RELOAD_STORAGE_KEY,
  recordBootMetric,
  syncBootLatencyChip,
  updateComposerState,
  isMobileQuoteMode: () => mobileQuoteMode,
  onBootstrapStage: (stage, details = {}) => {
    logBootStage(stage, details);
  },
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
  getActiveChatId: () => activeChatId,
  isDocumentHidden: () => document.visibilityState !== "visible",
  renderTraceLog,
});

function latestCompletedAssistantHapticKey(chatId) {
  return hapticUnreadController.latestCompletedAssistantHapticKey(chatId);
}

function triggerIncomingMessageHaptic(chatId, { messageKey = "", fallbackToLatestHistory = true } = {}) {
  return hapticUnreadController.triggerIncomingMessageHaptic(chatId, { messageKey, fallbackToLatestHistory });
}

function incrementUnread(chatId) {
  return hapticUnreadController.incrementUnread(chatId);
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
  return toolTraceController.appendInlineToolTrace(chatId, textOrPayload, payload);
}

function dropPendingToolTraceMessages(chatId) {
  return toolTraceController.dropPendingToolTraceMessages(chatId);
}

function finalizeInlineToolTrace(chatId) {
  return toolTraceController.finalizeInlineToolTrace(chatId);
}

async function confirmAction(message) {
  return shellUiController.confirmAction(message);
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
  return messageRenderController.renderBody(container, rawText, { fileRefs });
}

function renderToolTraceBody(container, message) {
  return messageRenderController.renderToolTraceBody(container, message);
}

function roleLabelForMessage(message) {
  return messageRenderController.roleLabelForMessage(message);
}

function normalizeHandle(value) {
  return bootstrapAuthController.normalizeHandle(value);
}

function fallbackHandleFromDisplayName(value) {
  return bootstrapAuthController.fallbackHandleFromDisplayName(value);
}

function refreshOperatorRoleLabels() {
  return bootstrapAuthController.refreshOperatorRoleLabels();
}

function messageVariantForRole(role) {
  return messageRenderController.messageVariantForRole(role);
}

function shouldSkipMessageRender({ role, renderedBody, pending }) {
  return messageRenderController.shouldSkipMessageRender({ role, renderedBody, pending });
}

function applyMessageMeta(node, message, options = {}) {
  return messageRenderController.applyMessageMeta(node, message, options);
}

function renderMessageContent(node, message, renderedBody) {
  return messageRenderController.renderMessageContent(node, message, renderedBody);
}

function messageStableKey(message, index = 0) {
  return messageRenderController.messageStableKey(message, index);
}

function upsertMessageNode(node, message) {
  return messageRenderController.upsertMessageNode(node, message);
}

function createMessageNode(message, { index = 0 } = {}) {
  return messageRenderController.createMessageNode(message, { index });
}

function appendMessages(fragment, messages, options = {}) {
  return messageRenderController.appendMessages(fragment, messages, options);
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
  return chatTabsController.suppressBlockedChatPending(chatId);
}

function clearReconnectResumeBlock(chatId) {
  return chatTabsController.clearReconnectResumeBlock(chatId);
}

function resetReconnectResumeBudget(chatId) {
  return chatTabsController.resetReconnectResumeBudget(chatId);
}

function consumeReconnectResumeBudget(chatId) {
  return chatTabsController.consumeReconnectResumeBudget(chatId);
}

function blockReconnectResume(chatId) {
  return chatTabsController.blockReconnectResume(chatId);
}

function isReconnectResumeBlocked(chatId) {
  return chatTabsController.isReconnectResumeBlocked(chatId);
}

function upsertChat(chat) {
  return chatTabsController.upsertChat(chat);
}

function syncPinnedChats(chatList) {
  return chatTabsController.syncPinnedChats(chatList);
}

function syncChats(chatList) {
  return chatTabsController.syncChats(chatList);
}

function getOrCreateTabNode(chatId) {
  return chatTabsController.getOrCreateTabNode(chatId);
}

function getTabBadgeState(chat) {
  return chatTabsController.getTabBadgeState(chat);
}

function applyTabBadgeState(badge, badgeState) {
  return chatTabsController.applyTabBadgeState(badge, badgeState);
}

function applyTabNodeState(node, chat) {
  return chatTabsController.applyTabNodeState(node, chat);
}

function removeMissingTabNodes(nextIds) {
  return chatTabsController.removeMissingTabNodes(nextIds);
}

function renderTabs() {
  return chatTabsController.renderTabs();
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
  return chatTabsController.refreshTabNode(chatId);
}

function syncActiveTabSelection(previousChatId, nextChatId) {
  return chatTabsController.syncActiveTabSelection(previousChatId, nextChatId);
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

const composerStateController = composerStateHelpers.createController({
  getActiveChatId: () => activeChatId,
  pendingChats,
  chats,
  getIsAuthenticated: () => isAuthenticated,
  sendButton,
  promptEl,
  removeChatButton,
  pinChatButton,
});

function updateComposerState() {
  return composerStateController.updateComposerState();
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
  messagesEl,
  template,
  nowStamp,
  renderBody,
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
  hasFreshPendingStreamSnapshot,
  persistPendingStreamSnapshot,
  clearPendingStreamSnapshot,
  shouldResumeOnVisibilityChange: (args = {}) => {
    if (reconnectResumeBlockedChats.has(Number(args?.activeChatId))) {
      return false;
    }
    return runtimeHelpers.shouldResumeOnVisibilityChange(args);
  },
  shouldDeferNonCriticalCachedOpen: () => !mobileQuoteMode && document.visibilityState === 'visible',
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
  focusComposerForNewChat,
});

const shellUiController = shellUiHelpers.createController({
  tg,
  pendingChats,
  fullscreenAppTopButton,
  devAuthControls,
  devModeBadge,
  devConfig,
  desktopTestingRequested,
  appendSystemMessage,
  scheduleTimeout: (callback, delay) => window.setTimeout(callback, delay),
  windowObject: window,
});


const composerViewportController = composerViewportHelpers.createController({
  windowObject: window,
  documentObject: document,
  tg,
  promptEl,
  form,
  messagesEl,
  tabsEl,
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
  hasLiveStreamController,
  setActivityChip,
  preserveViewportDuringUiMutation,
  latencyChip,
  streamDebugLog,
  onLatencyMapMutated: () => latencyPersistenceController.persistLatencyByChatToStorage(),
  renderTraceLog,
  getDocumentVisibilityState: () => document.visibilityState,
});

const streamActivityController = runtimeHelpers.createStreamActivityController({
  chats,
  getActiveChatId: () => Number(activeChatId),
  hasLiveStreamController,
  getChatLatencyText: (chatId) => latencyByChat.get(Number(chatId)) || '',
  chatLabel,
  compactChatLabel,
  setStreamStatus,
  setActivityChip,
  streamChip,
  latencyChip,
  setChatLatency,
  syncActiveLatencyChip,
  formatLatency,
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
  apiPost,
  syncTelegramChromeForSkin,
  getIsAuthenticated: () => isAuthenticated,
  getActiveChatId: () => Number(activeChatId),
  refreshChats,
  syncVisibleActiveChat,
  syncActiveMessageView,
  getStreamAbortControllers,
  maybeRefreshForBootstrapVersionMismatch,
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
  operatorNameEl: operatorName,
  formEl: form,
  promptEl,
  sendButton,
  templateEl: template,
  tg,
  getActiveChatId: () => Number(activeChatId),
  getRenderedChatId: () => Number(renderedChatId),
  isNearBottomFn: isNearBottom,
  chatScrollTop,
  chatStickToBottom,
  unseenStreamChats,
  histories,
  chats,
  pendingChats,
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
  syncRenderTraceBadge,
  loadDraftsFromStorage,
  syncClosingConfirmation,
  syncFullscreenControlState,
  setInitData: (value) => {
    initData = String(value || "");
  },
  getInitData: () => initData,
  getRenderTraceDebugEnabled: () => renderTraceDebugEnabled,
  renderTraceLog,
  maybeRefreshForBootstrapVersionMismatch,
  isMobileBootstrapPath: () => mobileQuoteMode,
  logBootStage,
  syncBootLatencyChip,
  fetchAuthBootstrapWithRetry,
  desktopTestingEnabled,
  desktopTestingRequested,
  devConfig,
  applyAuthBootstrap,
  hasFreshPendingStreamSnapshot,
  restorePendingStreamSnapshot,
  renderMessages,
  updateComposerState,
  revealShell,
  recordBootMetric,
  summarizeBootMetrics,
  getChatsSize: () => chats.size,
  isActiveChatPending: () => Boolean(activeChatId && chats.get(Number(activeChatId))?.pending),
  refreshChats,
  syncVisibleActiveChat,
  getStreamAbortControllers: () => streamController.getAbortControllers(),
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
  return streamPhaseController.getStreamPhase(chatId);
}

function setStreamPhase(chatId, phase) {
  return streamPhaseController.setStreamPhase(chatId, phase);
}

function messageStableKeyForPendingState(message, index = 0, pendingState = false) {
  return messageRenderController.messageStableKeyForPendingState(message, index, pendingState);
}

function findLatestHistoryMessageByRole(chatId, role, { pendingOnly = null } = {}) {
  return messageRenderController.findLatestHistoryMessageByRole(chatId, role, { pendingOnly });
}

function findLatestAssistantHistoryMessage(chatId, { pendingOnly = null } = {}) {
  return messageRenderController.findLatestAssistantHistoryMessage(chatId, { pendingOnly });
}

function findMessageNodeByKey(selector, messageKey, alternateMessageKey = "") {
  return messageRenderController.findMessageNodeByKey(selector, messageKey, alternateMessageKey);
}

function patchVisiblePendingAssistant(chatId, nextBody, pendingState = true) {
  return messageRenderController.patchVisiblePendingAssistant(chatId, nextBody, pendingState);
}

function patchVisibleToolTrace(chatId) {
  return messageRenderController.patchVisibleToolTrace(chatId);
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
  return chatHistoryController.updatePendingAssistant(chatId, nextBody, pendingState);
}

function appendSystemMessage(text, chatIdOverride = null) {
  return chatHistoryController.appendSystemMessage(text, chatIdOverride);
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
  return startupBindingsController.getMissingBootstrapBindings();
}

function reportBootstrapMismatch(reason, details = []) {
  return startupBindingsController.reportBootstrapMismatch(reason, details);
}

const resumeRecoveryPolicy = streamControllerHelpers.createResumeRecoveryPolicy({
  setTimeoutFn: (callback, delay) => window.setTimeout(callback, delay),
  randomFn: () => Math.random(),
});

function fetchAuthBootstrapWithRetry() {
  return bootstrapAuthController.fetchAuthBootstrapWithRetry();
}

async function maybeRefreshForBootstrapVersionMismatch() {
  return bootstrapAuthController.maybeRefreshForBootstrapVersionMismatch();
}

async function bootstrap() {
  return startupBindingsController.bootstrap();
}

async function saveSkinPreference(skin) {
  return visibilitySkinController.saveSkinPreference(skin);
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
  streamDebugLog,
  finalizeStreamPendingState,
  appendInlineToolTrace,
  loadChatHistory,
  upsertChat,
  histories,
  mergeHydratedHistory: runtimeHelpers.mergeHydratedHistory,
  renderMessages,
  persistStreamCursor: setStoredStreamCursor,
  clearStreamCursor: clearStoredStreamCursor,
  clearPendingStreamSnapshot,
  authPayload,
  parseStreamErrorPayload,
  summarizeUiFailure,
  getIsAuthenticated: () => isAuthenticated,
  setIsAuthenticated: (value) => {
    isAuthenticated = Boolean(value);
  },
  authStatusEl: authStatus,
  dropPendingToolTraceMessages,
  addLocalMessage,
  setDraft,
  resetToolStream,
  clearReconnectResumeBlock,
  resetReconnectResumeBudget,
  consumeReconnectResumeBudget,
  suppressBlockedChatPending,
  blockReconnectResume,
  isReconnectResumeBlocked,
  MAX_AUTO_RESUME_CYCLES_PER_CHAT,
  resumeAttemptedAtByChat,
  resumeCooldownUntilByChat,
  resumeInFlightByChat,
  RESUME_RECOVERY_MAX_ATTEMPTS: resumeRecoveryPolicy.RESUME_RECOVERY_MAX_ATTEMPTS,
  RESUME_REATTACH_MIN_INTERVAL_MS: resumeRecoveryPolicy.RESUME_REATTACH_MIN_INTERVAL_MS,
  RESUME_COMPLETE_SETTLE_MS: resumeRecoveryPolicy.RESUME_COMPLETE_SETTLE_MS,
  isTransientResumeRecoveryError: resumeRecoveryPolicy.isTransientResumeRecoveryError,
  nextResumeRecoveryDelayMs: resumeRecoveryPolicy.nextResumeRecoveryDelayMs,
  delayMs: resumeRecoveryPolicy.delayMs,
  markChatStreamPending,
  getStoredStreamCursor,
  isNearBottom,
});

function finalizeStreamPendingState(chatId, wasAborted) {
  return streamLifecycleController.finalizeStreamPendingState(chatId, wasAborted);
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

async function hydrateChatAfterGracefulResumeCompletion(chatId, options = {}) {
  return streamController.hydrateChatAfterGracefulResumeCompletion(chatId, options);
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
  return streamController.sendPrompt(message);
}

async function resumePendingChatStream(chatId, options = {}) {
  return streamController.resumePendingChatStream(chatId, options);
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

const interactionController = interactionHelpers.createController({
  mobileQuoteMode,
  activeChatId: Number(activeChatId),
  getActiveChatId: () => Number(activeChatId),
  focusMessagesPaneIfActiveChat,
  submitPromptWithUiError,
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

function handleComposerSubmitShortcut(event) {
  return interactionController.handleComposerSubmitShortcut(event);
}

promptEl.addEventListener("keydown", handleComposerSubmitShortcut);

promptEl.addEventListener("input", () => {
  if (!activeChatId) return;
  setDraft(activeChatId, promptEl.value || "");
});

function installSelectionQuoteBindings() {
  return interactionController.bindSelectionQuoteBindings();
}

const messageActionsController = messageActionsHelpers.createController({
  messagesEl,
  normalizeText: normalizeQuoteSelection,
  copyTextToClipboard,
});

function installMessageActionBindings() {
  return messageActionsController.bindMessageCopyBindings();
}

function installFilePreviewBindings() {
  return filePreviewController.bindFilePreviewBindings();
}

installSelectionQuoteBindings();
installMessageActionBindings();
installFilePreviewBindings();

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
  return visibilitySkinController.syncVisibleActiveChat(options);
}

async function handleVisibilityChange() {
  return visibilitySkinController.handleVisibilityChange();
}

function installVisibilitySkinLifecycle() {
  return visibilitySkinController.installLifecycleListeners();
}

function installPendingCompletionWatchdog() {
  return startupBindingsController.installPendingCompletionWatchdog();
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
