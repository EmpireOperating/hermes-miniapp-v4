const tg = window.Telegram?.WebApp;
const devConfig = window.__HERMES_DEV__ || {
  enabled: false,
  reloadStateUrl: "/dev/reload-state",
  intervalMs: 1200,
  version: "",
  requestDebug: false,
  devAuthEnabled: false,
};
const streamDebugEnabled = Boolean(devConfig.requestDebug);
const desktopTestingEnabled = Boolean(devConfig.devAuthEnabled);
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
const PINNED_CHATS_COLLAPSED_STORAGE_KEY = "hermes_pinned_chats_collapsed";
const DEV_AUTH_SESSION_STORAGE_KEY = "hermes_dev_auth_defaults";
const PINNED_CHATS_AUTO_COLLAPSE_THRESHOLD = 8;
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
const filePreviewClose = document.getElementById("file-preview-close");
const chatTabContextMenu = document.getElementById("chat-tab-context-menu");
const chatTabContextFork = document.getElementById("chat-tab-context-fork");

let initData = "";
let isAuthenticated = false;
let currentSkin = bootSkin;
let activeChatId = null;
let operatorDisplayName = "Operator";
const chats = new Map();
const pinnedChats = new Map();
const histories = new Map();
let pinnedChatsCollapsed = false;
let hasPinnedChatsCollapsePreference = false;
const pendingChats = new Set();
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
const LATENCY_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
let renderTraceDebugEnabled = false;
loadLatencyByChatFromStorage();

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
  const result = latencyViewController.setChatLatency(chatId, text);
  persistLatencyByChatToStorage();
  return result;
}

function syncActiveLatencyChip() {
  return latencyViewController.syncActiveLatencyChip();
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

function resetFilePreviewState() {
  if (filePreviewPath) filePreviewPath.textContent = "";
  if (filePreviewStatus) {
    filePreviewStatus.textContent = "";
    filePreviewStatus.hidden = true;
  }
  if (filePreviewLines) {
    filePreviewLines.innerHTML = "";
    filePreviewLines.scrollTop = 0;
  }
}

function closeFilePreviewModal() {
  if (!filePreviewModal) return;
  if (filePreviewModal.open) {
    filePreviewModal.close();
  }
  resetFilePreviewState();
}

function renderFilePreview(preview) {
  if (!filePreviewLines) return;
  const rows = Array.isArray(preview?.lines) ? preview.lines : [];
  const focusStart = Number(preview?.line_start || 0);
  const focusEnd = Number(preview?.line_end || 0);
  if (filePreviewPath) {
    filePreviewPath.textContent = String(preview?.path || "Preview");
  }
  filePreviewLines.innerHTML = "";
  const fragment = document.createDocumentFragment();
  let firstFocusLine = null;
  rows.forEach((row) => {
    const lineNumber = Number(row?.line || 0);
    const wrap = document.createElement("div");
    wrap.className = "file-preview-line";
    if (focusStart > 0 && lineNumber >= focusStart && lineNumber <= Math.max(focusStart, focusEnd)) {
      wrap.classList.add("is-focus");
      if (!firstFocusLine) {
        firstFocusLine = wrap;
      }
    }

    const numberEl = document.createElement("span");
    numberEl.className = "file-preview-line__number";
    numberEl.textContent = String(lineNumber || "");

    const textEl = document.createElement("span");
    textEl.className = "file-preview-line__text";
    textEl.textContent = String(row?.text || "");

    wrap.appendChild(numberEl);
    wrap.appendChild(textEl);
    fragment.appendChild(wrap);
  });
  filePreviewLines.appendChild(fragment);

  if (firstFocusLine) {
    requestAnimationFrame(() => {
      const targetTop = Math.max(
        0,
        firstFocusLine.offsetTop - Math.floor(filePreviewLines.clientHeight / 2) + Math.floor(firstFocusLine.offsetHeight / 2),
      );
      filePreviewLines.scrollTop = targetTop;
    });
  }
}

function showFilePreviewStatus(message) {
  if (!filePreviewStatus) return;
  filePreviewStatus.hidden = false;
  filePreviewStatus.textContent = String(message || "Preview unavailable");
}

async function openFilePreviewByRef(refId) {
  if (!filePreviewModal || !refId) return;
  resetFilePreviewState();
  showFilePreviewStatus("Loading preview…");
  if (!filePreviewModal.open) {
    filePreviewModal.showModal();
  }

  try {
    const data = await apiPost("/api/chats/file-preview", {
      chat_id: activeChatId,
      ref_id: refId,
    });
    const preview = data?.preview || null;
    if (!preview) {
      throw new Error("Preview unavailable");
    }
    if (filePreviewStatus) {
      filePreviewStatus.hidden = true;
      filePreviewStatus.textContent = "";
    }
    renderFilePreview(preview);
  } catch (error) {
    showFilePreviewStatus(error?.message || "Preview unavailable");
  }
}

function handleMessageFileRefClick(event) {
  const trigger = event?.target?.closest?.(".message-file-ref[data-file-ref-id]");
  if (!trigger) return;
  event.preventDefault();
  const refId = String(trigger.dataset.fileRefId || "").trim();
  if (!refId || !activeChatId) return;
  void openFilePreviewByRef(refId);
}

const bootstrapAuthController = bootstrapAuthHelpers.createController({
  desktopTestingEnabled,
  devAuthSessionStorageKey: DEV_AUTH_SESSION_STORAGE_KEY,
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
  safeReadJson,
  fetchImpl: (...args) => fetch(...args),
  normalizeHandle,
  fallbackHandleFromDisplayName,
  setOperatorDisplayName: (value) => {
    operatorDisplayName = String(value || "");
  },
  operatorName,
  refreshOperatorRoleLabels,
  setSkin,
  upsertChat,
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
  return bootstrapAuthController.syncDevAuthUi();
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

function findPendingToolTraceMessage(chatId) {
  return toolTraceController.findPendingToolTraceMessage(chatId);
}

function ensurePendingToolTraceMessage(chatId) {
  return toolTraceController.ensurePendingToolTraceMessage(chatId);
}

function appendInlineToolTrace(chatId, textOrPayload, payload = null) {
  return toolTraceController.appendInlineToolTrace(chatId, textOrPayload, payload);
}

function finalizeInlineToolTrace(chatId) {
  return toolTraceController.finalizeInlineToolTrace(chatId);
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
  return chatTabsController.normalizeChat(chat, { forcePinned });
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
  shouldResumeOnVisibilityChange: runtimeHelpers.shouldResumeOnVisibilityChange,
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
  return chatHistoryController.updatePendingAssistant(chatId, nextBody, pendingState);
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

async function bootstrap() {
  if (tg) {
    try {
      tg.ready?.();
      tg.expand?.();
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

  try {
    const response = await fetch("/api/auth", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ init_data: initData }),
    });
    const data = await safeReadJson(response);

    if (!response.ok || !data?.ok) {
      if (desktopTestingEnabled) {
        const autoSignedIn = await signInWithDevAuth({ interactive: false });
        if (autoSignedIn) {
          return;
        }
        authStatus.textContent = "Desktop testing ready";
        appendSystemMessage(data?.error || "Use Dev sign-in to test outside Telegram.");
        return;
      }
      authStatus.textContent = "Sign-in failed";
      appendSystemMessage(data?.error || (tg ? "Sign-in failed." : "Open this mini app from Telegram."));
      return;
    }

    applyAuthBootstrap(data, { preferredUsername: tg?.initDataUnsafe?.user?.username || "" });
  } catch (error) {
    authStatus.textContent = "Sign-in error";
    appendSystemMessage(`Could not start the app: ${error.message}`);
  } finally {
    syncDevAuthUi();
    updateComposerState();
    revealShell();
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
  sourceChip,
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
});

function finalizeStreamPendingState(chatId, wasAborted) {
  finalizeChatStreamState({
    chatId,
    wasAborted,
    pendingChats,
    chats,
    setStreamPhase,
  });
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

  resetToolStream();
  streamActivityController.markStreamActive(chatId);

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
      streamActivityController.markStreamError();
      return;
    }

    const resumed = await consumeStreamWithReconnect(chatId, response, builtReplyRef, {
      fallbackTraceEvent: "stream-fallback-patch",
      resetReplayCursor: true,
      onEarlyClose: async () => {
        wasAborted = true;
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
  const hasLiveController = hasLiveStreamController(key);
  if (hasLiveController && !force) return;
  if (!Boolean(chats.get(key)?.pending)) return;

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
    // Preserve the last visible latency value during reconnect instead of flashing
    // a placeholder like "recalculating...", which is visually disruptive.
    streamActivityController.markStreamReconnecting(key);
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
      const normalizedFallback = String(fallback || "").toLowerCase();
      const noActiveJob = response.status === 409 && normalizedFallback.includes("no active hermes job");
      if (noActiveJob) {
        setStreamPhase(key, STREAM_PHASES.FINALIZED);
        await hydrateChatAfterGracefulResumeCompletion(key);
        triggerIncomingMessageHaptic(key, { fallbackToLatestHistory: true });
        streamActivityController.markResumeAlreadyComplete(key);
        return;
      }
      throw new Error(fallback || `Resume failed: ${response.status}`);
    }

    const resumed = await consumeStreamWithReconnect(key, response, builtReplyRef, {
      fallbackTraceEvent: "stream-resume-fallback-patch",
      onEarlyClose: async () => {
        wasAborted = true;
        await resumePendingChatStream(key, { force: true });
      },
    });
    if (resumed) return;
  } catch (error) {
    if (error?.name === "AbortError") {
      wasAborted = true;
      return;
    }
    setStreamPhase(key, STREAM_PHASES.ERROR);
    finalizeInlineToolTrace(key);
    appendSystemMessage(`Stream reconnect failed for '${chatLabel(key)}': ${error.message}`);
    if (Number(activeChatId) === key) {
      streamActivityController.markReconnectFailed(key);
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
filePreviewClose?.addEventListener("click", closeFilePreviewModal);
filePreviewModal?.addEventListener?.("cancel", (event) => {
  event.preventDefault();
  closeFilePreviewModal();
});
selectionQuoteController.bind();

let tabContextTargetChatId = null;

function closeChatTabContextMenu() {
  tabContextTargetChatId = null;
  if (!chatTabContextMenu) return;
  chatTabContextMenu.hidden = true;
}

function openChatTabContextMenu(chatId, clientX, clientY) {
  if (!chatTabContextMenu) return;
  tabContextTargetChatId = Number(chatId) || null;
  if (!tabContextTargetChatId) {
    closeChatTabContextMenu();
    return;
  }

  const viewportWidth = Number(window.innerWidth || 0);
  const viewportHeight = Number(window.innerHeight || 0);
  const menuWidth = 172;
  const menuHeight = 44;
  const left = Math.max(8, Math.min(Number(clientX || 0), Math.max(8, viewportWidth - menuWidth - 8)));
  const top = Math.max(8, Math.min(Number(clientY || 0), Math.max(8, viewportHeight - menuHeight - 8)));

  chatTabContextMenu.style.left = `${left}px`;
  chatTabContextMenu.style.top = `${top}px`;
  chatTabContextMenu.hidden = false;
}

function handleTabOverflowTriggerClick(event) {
  const trigger = event?.target?.closest?.('[data-chat-tab-menu-trigger]');
  if (!trigger) return;

  const tab = trigger.closest('.chat-tab');
  const chatId = Number(tab?.dataset?.chatId || 0);
  if (!chatId || chatId !== Number(activeChatId)) {
    closeChatTabContextMenu();
    return;
  }

  event.preventDefault();
  event.stopPropagation();

  const existingTargetId = Number(tabContextTargetChatId || 0);
  const isAlreadyOpenForSameChat = !chatTabContextMenu?.hidden && existingTargetId === chatId;
  if (isAlreadyOpenForSameChat) {
    closeChatTabContextMenu();
    return;
  }

  const rect = trigger.getBoundingClientRect();
  openChatTabContextMenu(chatId, rect.right - 6, rect.bottom + 6);
}

async function handleTabContextForkClick(event) {
  event.preventDefault();
  const chatId = Number(tabContextTargetChatId || 0);
  closeChatTabContextMenu();
  if (!chatId) return;
  await chatAdminController.forkChatFrom(chatId);
}

function handleGlobalChatContextMenuDismiss(event) {
  if (chatTabContextMenu?.hidden) return;
  const target = event?.target || null;
  if (target && chatTabContextMenu?.contains?.(target)) return;
  closeChatTabContextMenu();
}

function getOrderedChatIds() {
  return keyboardShortcutsHelpers.getOrderedChatIds(chats);
}

function isTextEntryElement(element) {
  return keyboardShortcutsHelpers.isTextEntryElement(element);
}

function isDesktopViewport() {
  return keyboardShortcutsHelpers.isDesktopViewport(window);
}

function handleTabClick(event) {
  keyboardShortcutsHelpers.handleTabClick(event, {
    activeChatId,
    openChat,
  });
}

function handlePinnedChatClick(event) {
  keyboardShortcutsHelpers.handlePinnedChatClick(event, {
    activeChatId,
    chats,
    openPinnedChat,
  });
}

function handleGlobalTabCycle(event) {
  keyboardShortcutsHelpers.handleGlobalTabCycle(event, {
    mobileQuoteMode,
    isDesktopViewportFn: isDesktopViewport,
    settingsModal,
    isTextEntryElementFn: isTextEntryElement,
    activeChatId,
    chats,
    getNextChatTabId: runtimeHelpers.getNextChatTabId,
    openChat,
  });
}

function scrollMessagesByArrow(direction) {
  keyboardShortcutsHelpers.scrollMessagesByArrow(messagesEl, direction);
}

function handleGlobalArrowJump(event) {
  keyboardShortcutsHelpers.handleGlobalArrowJump(event, {
    mobileQuoteMode,
    isDesktopViewportFn: isDesktopViewport,
    settingsModal,
    isTextEntryElementFn: isTextEntryElement,
    jumpLatestButton,
    jumpLastStartButton,
    handleJumpLatest,
    handleJumpLastStart,
    scrollMessages: scrollMessagesByArrow,
  });
}

function handleGlobalComposerFocusShortcut(event) {
  keyboardShortcutsHelpers.handleGlobalComposerFocusShortcut(event, {
    mobileQuoteMode,
    isDesktopViewportFn: isDesktopViewport,
    settingsModal,
    isTextEntryElementFn: isTextEntryElement,
    activeChatId,
    messagesEl,
    promptEl,
    documentObject: document,
  });
}

function shouldReleaseControlFocusAfterClick(target) {
  return keyboardShortcutsHelpers.shouldReleaseControlFocusAfterClick(target, {
    isTextEntryElementFn: isTextEntryElement,
    settingsModal,
  });
}

function releaseStickyControlFocus() {
  keyboardShortcutsHelpers.releaseStickyControlFocus({
    mobileQuoteMode,
    isDesktopViewportFn: isDesktopViewport,
    documentObject: document,
    promptEl,
    messagesEl,
    activeChatId,
    settingsModal,
    focusMessagesPaneIfActiveChat,
  });
}

function handleGlobalControlClickFocusCleanup(event) {
  keyboardShortcutsHelpers.handleGlobalControlClickFocusCleanup(event, {
    shouldReleaseControlFocusAfterClickFn: shouldReleaseControlFocusAfterClick,
    releaseStickyControlFocusFn: releaseStickyControlFocus,
    windowObject: window,
  });
}

function handleGlobalControlMouseDownFocusGuard(event) {
  keyboardShortcutsHelpers.handleGlobalControlMouseDownFocusGuard(event, {
    mobileQuoteMode,
    isDesktopViewportFn: isDesktopViewport,
    shouldReleaseControlFocusAfterClickFn: shouldReleaseControlFocusAfterClick,
  });
}

function handleGlobalControlEnterDefuse(event) {
  keyboardShortcutsHelpers.handleGlobalControlEnterDefuse(event, {
    mobileQuoteMode,
    isDesktopViewportFn: isDesktopViewport,
    isTextEntryElementFn: isTextEntryElement,
    settingsModal,
    documentObject: document,
    promptEl,
    messagesEl,
    releaseStickyControlFocusFn: releaseStickyControlFocus,
  });
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
startDevAutoRefresh();
installTapToDismissKeyboard();
installKeyboardViewportSync();
syncPinnedChatsCollapseUi();
void bootstrap();
