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

function safeDecodeUriComponent(value) {
  try {
    return decodeURIComponent(String(value || ""));
  } catch {
    return "";
  }
}

const devAuthRevealHash = String(devConfig.devAuthRevealHash || "#dev-auth").trim() || "#dev-auth";
const currentLocationHash = typeof window?.location?.hash === "string" ? window.location.hash : "";
const desktopTestingRequested = currentLocationHash === devAuthRevealHash || currentLocationHash.startsWith(`${devAuthRevealHash}:`);
const desktopTestingEnabled = Boolean(devConfig.devAuthEnabled) && desktopTestingRequested;
const devAuthHashSecret = desktopTestingRequested && currentLocationHash.startsWith(`${devAuthRevealHash}:`)
  ? safeDecodeUriComponent(currentLocationHash.slice(devAuthRevealHash.length + 1))
  : "";
const filePreviewConfig = window.__HERMES_FILE_PREVIEW__ || { enabled: false, allowedRoots: [] };
const filePreviewFeatureEnabled = Boolean(filePreviewConfig.enabled);
const featureConfig = window.__HERMES_FEATURES__ || { mobileTabCarousel: false, tabActionsMenu: false };
const mobileTabCarouselFeatureEnabled = Boolean(featureConfig.mobileTabCarousel);
const tabActionsMenuFeatureEnabled = Boolean(featureConfig.tabActionsMenu);
const filePreviewAllowedRoots = filePreviewFeatureEnabled && Array.isArray(filePreviewConfig.allowedRoots)
  ? filePreviewConfig.allowedRoots
      .map((value) => String(value || "").trim())
      .filter((value) => value.startsWith("/"))
  : [];
const sharedUtils = window.HermesMiniappSharedUtils;

function createDeferredGlobalFacade({ windowObject = window, globalKey, facadeApi, handleSet = null }) {
  Object.defineProperty(windowObject, globalKey, {
    configurable: true,
    enumerable: true,
    get() {
      return facadeApi;
    },
    set(value) {
      handleSet?.(value);
    },
  });
}

function createDeferredControllerFacadeApi({ controllerStates, attachResolvedController, shouldReplayMethod }) {
  return {
    createController(deps) {
      const state = {
        deps,
        realController: null,
        pendingCalls: [],
      };
      controllerStates.add(state);
      attachResolvedController(state);
      return new Proxy({}, {
        get(_target, prop) {
          if (prop === '__lateBound') {
            return true;
          }
          return (...args) => {
            attachResolvedController(state);
            const method = state.realController?.[prop];
            if (typeof method === 'function') {
              return method(...args);
            }
            if (shouldReplayMethod(prop)) {
              state.pendingCalls.push({ prop, args });
            }
            return undefined;
          };
        },
      });
    },
  };
}

function createDeferredControllerHelper(globalKey) {
  const existing = window[globalKey];
  if (existing) {
    return existing;
  }

  let resolvedApi = null;
  const controllerStates = new Set();
  const shouldReplayMethod = (prop) => /^(bind|bootstrap|install|sync|start|set|save|handle|report)/.test(String(prop || ''));

  function attachResolvedController(state) {
    if (!state || state.realController || !resolvedApi || typeof resolvedApi.createController !== 'function') {
      return;
    }
    try {
      state.realController = resolvedApi.createController(state.deps) || null;
    } catch {
      state.realController = null;
      return;
    }
    if (!state.realController || !Array.isArray(state.pendingCalls) || !state.pendingCalls.length) {
      return;
    }
    const pendingCalls = state.pendingCalls.splice(0);
    pendingCalls.forEach(({ prop, args }) => {
      const method = state.realController?.[prop];
      if (typeof method === 'function') {
        method(...args);
      }
    });
  }

  const facadeApi = createDeferredControllerFacadeApi({
    controllerStates,
    attachResolvedController,
    shouldReplayMethod,
  });

  createDeferredGlobalFacade({
    windowObject: window,
    globalKey,
    facadeApi,
    handleSet(value) {
      resolvedApi = value;
      controllerStates.forEach((state) => attachResolvedController(state));
    },
  });

  return facadeApi;
}

function createDeferredApiHelper(globalKey, fallbackApi = {}) {
  const existing = window[globalKey];
  if (existing) {
    return existing;
  }

  let resolvedApi = null;
  const deferredControllerGlobalKey = `${globalKey}__deferred_controller__`;
  const deferredControllerHelper = createDeferredControllerHelper(deferredControllerGlobalKey);

  const facadeApi = new Proxy({}, {
    get(_target, prop) {
      if (prop === '__lateBound') {
        return true;
      }
      return (...args) => {
        const method = resolvedApi?.[prop];
        if (typeof method === 'function') {
          return method(...args);
        }
        const fallback = fallbackApi?.[prop];
        if (typeof fallback === 'function') {
          return fallback(...args);
        }
        if (prop === 'createController') {
          return deferredControllerHelper.createController(...args);
        }
        return fallback;
      };
    },
  });

  createDeferredGlobalFacade({
    windowObject: window,
    globalKey,
    facadeApi,
    handleSet(value) {
      resolvedApi = value;
      if (value && typeof value.createController === 'function') {
        window[deferredControllerGlobalKey] = value;
      }
    },
  });

  return facadeApi;
}

function createDeferredRenderTraceApiHelper(globalKey) {
  const existing = window[globalKey];
  if (existing) {
    return existing;
  }

  const deferredDebugControllerHelper = createDeferredControllerHelper(`${globalKey}__debug_controller__`);
  const deferredMessageControllerHelper = createDeferredControllerHelper(`${globalKey}__message_controller__`);
  const deferredHistoryControllerHelper = createDeferredControllerHelper(`${globalKey}__history_controller__`);

  return createDeferredApiHelper(globalKey, {
    parseBooleanFlag() {
      return null;
    },
    createController(...args) {
      return deferredDebugControllerHelper.createController(...args);
    },
    createMessageRenderController(...args) {
      return deferredMessageControllerHelper.createController(...args);
    },
    createHistoryRenderController(...args) {
      return deferredHistoryControllerHelper.createController(...args);
    },
  });
}

const deferredInteractionFallbacks = {
  unwrapLegacyQuoteBlock(text) {
    return String(text || '');
  },
  normalizeQuoteSelection(rawText) {
    return String(rawText || '')
      .replace(/\r\n?/g, '\n')
      .replace(/[\u2028\u2029]/g, '\n')
      .replace(/\u00a0/g, ' ')
      .split('\n')
      .map((line) => line.replace(/\s+$/g, ''))
      .join('\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  },
  splitGraphemes(text) {
    return Array.from(String(text || ''));
  },
  wrapQuoteLine(line, width = 46) {
    const text = String(line || '');
    if (!text) return [''];
    const safeWidth = Math.max(8, Number(width) || 46);
    const chunks = [];
    for (let index = 0; index < text.length; index += safeWidth) {
      chunks.push(text.slice(index, index + safeWidth).trimEnd());
    }
    return chunks.length ? chunks : [''];
  },
  getQuoteWrapWidth({ promptInput, windowObject = window } = {}) {
    try {
      if (!promptInput || !windowObject) return 46;
      const style = windowObject.getComputedStyle?.(promptInput);
      const fontSize = Number.parseFloat(style?.fontSize || '') || 16;
      const inputWidth = promptInput.clientWidth || promptInput.offsetWidth || 0;
      if (!inputWidth) return 46;
      const usableWidth = Math.max(120, inputWidth - 28);
      const charWidth = Math.max(fontSize * 0.58, 7);
      const estimatedChars = Math.floor(usableWidth / charWidth);
      return Math.max(22, Math.min(46, estimatedChars - 2));
    } catch {
      return 46;
    }
  },
  formatQuoteBlock(rawText) {
    const clean = deferredInteractionFallbacks.normalizeQuoteSelection(rawText);
    if (!clean) return '';
    const lines = clean.split('\n').map((line) => (line ? `│ ${line}` : '│'));
    return `┌ Quote\n${lines.join('\n')}\n└\n\n\n`;
  },
  isCoarsePointer({ windowObject = window } = {}) {
    if (!windowObject) return false;
    try {
      if (windowObject.matchMedia?.('(pointer: coarse)')?.matches) {
        return true;
      }
    } catch {
      // Fall through.
    }
    return 'ontouchstart' in windowObject;
  },
  clearSelectionQuoteState() {},
  cancelSelectionQuoteTimer() {},
  scheduleSelectionQuoteClear() {},
  scheduleSelectionQuoteSync() {},
  applyQuoteIntoPrompt() {},
  activeSelectionQuote() { return null; },
  quotePlacementKey({ text = '', rect = {} } = {}) {
    return [text, Math.round(rect.left || 0), Math.round(rect.top || 0), Math.round(rect.width || 0), Math.round(rect.height || 0)].join('|');
  },
  showSelectionQuoteAction() {},
  syncSelectionQuoteAction() {},
};

function requireHelperGlobal(windowObject, globalKey) {
  const value = windowObject?.[globalKey];
  if (!value) {
    throw new Error(`${globalKey} is required before app.js`);
  }
  return value;
}

function createDeferredHelperRegistry({
  windowObject = window,
  interactionFallbacks = deferredInteractionFallbacks,
} = {}) {
  return {
    bootstrapAuthHelpers: requireHelperGlobal(windowObject, 'HermesMiniappBootstrapAuth'),
    chatHistoryHelpers: requireHelperGlobal(windowObject, 'HermesMiniappChatHistory'),
    chatUiHelpers: requireHelperGlobal(windowObject, 'HermesMiniappChatUI'),
    chatTabsHelpers: requireHelperGlobal(windowObject, 'HermesMiniappChatTabs'),
    composerStateHelpers: requireHelperGlobal(windowObject, 'HermesMiniappComposerState'),
    chatAdminHelpers: windowObject.HermesMiniappChatAdmin || createDeferredControllerHelper('HermesMiniappChatAdmin'),
    messageActionsHelpers: windowObject.HermesMiniappMessageActions || createDeferredControllerHelper('HermesMiniappMessageActions'),
    keyboardShortcutsHelpers: windowObject.HermesMiniappKeyboardShortcuts || createDeferredControllerHelper('HermesMiniappKeyboardShortcuts'),
    interactionHelpers: windowObject.HermesMiniappInteraction || createDeferredApiHelper('HermesMiniappInteraction', interactionFallbacks),
    shellUiHelpers: windowObject.HermesMiniappShellUI || createDeferredControllerHelper('HermesMiniappShellUI'),
    composerViewportHelpers: windowObject.HermesMiniappComposerViewport || createDeferredControllerHelper('HermesMiniappComposerViewport'),
    visibilitySkinHelpers: windowObject.HermesMiniappVisibilitySkin || createDeferredControllerHelper('HermesMiniappVisibilitySkin'),
    startupBindingsHelpers: windowObject.HermesMiniappStartupBindings || createDeferredApiHelper('HermesMiniappStartupBindings'),
    renderTraceHelpers: windowObject.HermesMiniappRenderTrace || createDeferredRenderTraceApiHelper('HermesMiniappRenderTrace'),
    filePreviewHelpers: windowObject.HermesMiniappFilePreview || createDeferredControllerHelper('HermesMiniappFilePreview'),
  };
}

if (!sharedUtils) {
  throw new Error("HermesMiniappSharedUtils is required before app.js");
}
const {
  bootstrapAuthHelpers,
  chatHistoryHelpers,
  chatUiHelpers,
  chatTabsHelpers,
  composerStateHelpers,
  chatAdminHelpers,
  messageActionsHelpers,
  keyboardShortcutsHelpers,
  interactionHelpers,
  shellUiHelpers,
  composerViewportHelpers,
  visibilitySkinHelpers,
  startupBindingsHelpers,
  renderTraceHelpers,
  filePreviewHelpers,
} = createDeferredHelperRegistry({
  windowObject: window,
  interactionFallbacks: deferredInteractionFallbacks,
});
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
const PREFERRED_ACTIVE_CHAT_SESSION_STORAGE_KEY = "hermes_preferred_active_chat_id";
const PRESENCE_INSTANCE_ID_SESSION_STORAGE_KEY = "hermes_presence_instance_id";
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
if (body) {
  body.dataset.tabActionsMenu = tabActionsMenuFeatureEnabled ? "true" : "false";
}
const messagesEl = document.getElementById("messages");
const tabsEl = document.getElementById("chat-tabs");
const tabOverviewEl = document.getElementById("chat-tabs-overview");
const hiddenUnreadLeftEl = document.getElementById("chat-tabs-hidden-left");
const hiddenUnreadRightEl = document.getElementById("chat-tabs-hidden-right");
const hiddenUnreadSummaryEl = document.getElementById("chat-tabs-hidden-unread");
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
const keyboardShortcutsTopButton = document.getElementById("keyboard-shortcuts-top-button");
const keyboardShortcutsButton = document.getElementById("keyboard-shortcuts-button");
const devAuthControls = document.getElementById("dev-auth-controls");
const devModeBadge = document.getElementById("dev-mode-badge");
const devSignInButton = document.getElementById("dev-signin-button");
const renderTraceBadge = document.getElementById("render-trace-badge");
const settingsModal = document.getElementById("settings-modal");
const keyboardShortcutsModal = document.getElementById("keyboard-shortcuts-modal");
const settingsClose = document.getElementById("settings-close");
const keyboardShortcutsClose = document.getElementById("keyboard-shortcuts-close");
const telegramUnreadNotificationsToggle = document.getElementById("telegram-unread-notifications-toggle");
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
const chatTabContextRename = document.getElementById("chat-tab-context-rename");
const chatTabContextPin = document.getElementById("chat-tab-context-pin");
const chatTabContextClose = document.getElementById("chat-tab-context-close");
const chatTabContextFork = document.getElementById("chat-tab-context-fork");
const pinnedChatContextMenu = document.getElementById("pinned-chat-context-menu");
const pinnedChatContextRemove = document.getElementById("pinned-chat-context-remove");

let initData = tg?.initData || "";
let isAuthenticated = false;
let currentSkin = bootSkin;
let telegramUnreadNotificationsEnabled = false;
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
// Guard/reference markers preserved for meta tests during controller-deps refactors:
// HermesMiniappComposerState is required before app.js
// const streamPhaseController = streamStateHelpers.createPhaseController({
// const streamPersistenceController = streamStateHelpers.createPersistenceController({
// const toolTraceController = streamControllerHelpers.createToolTraceController({
// bootstrapAuthHelpers.createController(createBootstrapAuthControllerDeps({
// runtimeHelpers.createLatencyPersistenceController({
// shellUiHelpers.createController({
// composerViewportHelpers.createController({
// visibilitySkinHelpers.createController({
// startupBindingsHelpers.createController(createStartupBindingsControllerDeps({
// renderTraceHelpers.createController({
// renderTraceHelpers.createMessageRenderController({
// filePreviewHelpers.createController({

const prefetchingHistories = new Set();
const tabNodes = new Map();
const chatScrollTop = new Map();
const chatStickToBottom = new Map();
const virtualizationRanges = new Map();
const virtualMetrics = new Map();
const renderedHistoryLength = new Map();
const renderedHistoryVirtualized = new Map();
const renderedTranscriptSignatureByChat = new Map();
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

let chatHistoryController = null;

function createChatTabsControllerStateDeps({
  localStorageRef,
  pinnedChatsCollapsedStorageKey,
  pinnedChatsAutoCollapseThreshold,
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
}) {
  return {
    localStorageRef,
    pinnedChatsCollapsedStorageKey,
    pinnedChatsAutoCollapseThreshold,
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
  };
}

function createChatTabsControllerUiDeps({
  tabTemplate,
  tabsEl,
  hiddenUnreadLeftEl,
  hiddenUnreadRightEl,
  hiddenUnreadSummaryEl,
  tabOverviewEl,
  mobileTabCarouselEnabled,
  getIsMobileCarouselViewport,
  getCurrentUnreadCount,
  openChat,
  clearChatStreamState,
  chatUiHelpers,
  pinnedChatsWrap,
  pinnedChatsEl,
  pinnedChatsCountEl,
  pinnedChatsToggleButton,
  pinChatButton,
  documentObject,
  renderTraceLog,
}) {
  return {
    tabTemplate,
    tabsEl,
    hiddenUnreadLeftEl,
    hiddenUnreadRightEl,
    hiddenUnreadSummaryEl,
    tabOverviewEl,
    mobileTabCarouselEnabled,
    getIsMobileCarouselViewport,
    getCurrentUnreadCount,
    openChat,
    clearChatStreamState,
    chatUiHelpers,
    pinnedChatsWrap,
    pinnedChatsEl,
    pinnedChatsCountEl,
    pinnedChatsToggleButton,
    pinChatButton,
    documentObject,
    renderTraceLog,
  };
}

function createChatTabsControllerPolicyDeps({
  getActiveChatId,
  getPinnedChatsCollapsed,
  setPinnedChatsCollapsedState,
  getHasPinnedChatsCollapsePreference,
  setHasPinnedChatsCollapsePreference,
  resumeCooldownUntilByChat,
  reconnectResumeBlockedChats,
  resumeCycleCountByChat,
  maxAutoResumeCyclesPerChat,
  nowFn,
}) {
  return {
    getActiveChatId,
    getPinnedChatsCollapsed,
    setPinnedChatsCollapsedState,
    getHasPinnedChatsCollapsePreference,
    setHasPinnedChatsCollapsePreference,
    resumeCooldownUntilByChat,
    reconnectResumeBlockedChats,
    resumeCycleCountByChat,
    maxAutoResumeCyclesPerChat,
    nowFn,
  };
}

function createChatTabsControllerDeps(args) {
  return {
    ...createChatTabsControllerStateDeps(args),
    ...createChatTabsControllerUiDeps(args),
    ...createChatTabsControllerPolicyDeps(args),
  };
}

function applyStoredPinnedChatsCollapsePreference({
  chatTabsController,
  setPinnedChatsCollapsed,
  setHasPinnedChatsCollapsePreference,
}) {
  const storedPinnedChatsCollapsed = chatTabsController.getStoredPinnedChatsCollapsed();
  setPinnedChatsCollapsed(storedPinnedChatsCollapsed ?? false);
  setHasPinnedChatsCollapsePreference(storedPinnedChatsCollapsed !== null);
}

function createChatTabsController() {
  return chatTabsHelpers.createController(createChatTabsControllerDeps({
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
  hiddenUnreadLeftEl,
  hiddenUnreadRightEl,
  hiddenUnreadSummaryEl,
  tabOverviewEl,
  mobileTabCarouselEnabled: mobileTabCarouselFeatureEnabled,
  getIsMobileCarouselViewport: () => isCoarsePointer(),
  getCurrentUnreadCount,
  openChat: (chatId) => openChat(chatId),
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
}));
}

const chatTabsController = createChatTabsController();

applyStoredPinnedChatsCollapsePreference({
  chatTabsController,
  setPinnedChatsCollapsed: (value) => {
    pinnedChatsCollapsed = Boolean(value);
  },
  setHasPinnedChatsCollapsePreference: (value) => {
    hasPinnedChatsCollapsePreference = Boolean(value);
  },
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

let latencyPersistenceControllerInstance = null;
let latencyStorageLoaded = false;

function createLatencyPersistenceControllerDeps() {
  return {
    localStorageRef: localStorage,
    storageKey: LATENCY_STORAGE_KEY,
    latencyByChat,
    maxAgeMs: LATENCY_MAX_AGE_MS,
  };
}

function createLatencyPersistenceController() {
  return runtimeHelpers.createLatencyPersistenceController(createLatencyPersistenceControllerDeps());
}

function getLatencyPersistenceController() {
  if (!latencyPersistenceControllerInstance) {
    latencyPersistenceControllerInstance = createLatencyPersistenceController();
  }
  return latencyPersistenceControllerInstance;
}

function ensureLatencyStorageLoaded() {
  const controller = getLatencyPersistenceController();
  if (!latencyStorageLoaded) {
    controller.loadLatencyByChatFromStorage();
    latencyStorageLoaded = true;
  }
  return controller;
}

function createStreamPersistenceControllerDeps() {
  return {
    localStorageRef: localStorage,
    streamResumeCursorStorageKey: STREAM_RESUME_CURSOR_STORAGE_KEY,
    pendingStreamSnapshotStorageKey: PENDING_STREAM_SNAPSHOT_STORAGE_KEY,
    pendingStreamSnapshotMaxAgeMs: PENDING_STREAM_SNAPSHOT_MAX_AGE_MS,
    histories,
    chats,
    nowFn: nowStamp,
  };
}

function createStreamPersistenceController() {
  return streamStateHelpers.createPersistenceController(createStreamPersistenceControllerDeps());
}

const streamPersistenceController = createStreamPersistenceController();

function createStreamPhaseControllerDeps() {
  return {
    streamPhaseByChat,
    renderTraceLog,
  };
}

function createStreamPhaseController() {
  return streamStateHelpers.createPhaseController(createStreamPhaseControllerDeps());
}

const streamPhaseController = createStreamPhaseController();

function createStreamLifecycleControllerDeps() {
  return {
    chats,
    pendingChats,
    unseenStreamChats,
    getActiveChatId: () => Number(activeChatId),
    setStreamPhase,
    refreshTabNode,
    renderTraceLog,
  };
}

function createStreamLifecycleController() {
  return streamStateHelpers.createLifecycleController(createStreamLifecycleControllerDeps());
}

const streamLifecycleController = createStreamLifecycleController();

function createDraftControllerDeps() {
  return {
    localStorageRef: localStorage,
    draftStorageKey: DRAFT_STORAGE_KEY,
    draftByChat,
  };
}

function createDraftController() {
  return composerStateHelpers.createDraftController(createDraftControllerDeps());
}

const draftController = createDraftController();

function createToolTraceControllerDeps() {
  return {
    histories,
    cleanDisplayText,
    persistPendingStreamSnapshot,
  };
}

function createToolTraceController() {
  return streamControllerHelpers.createToolTraceController(createToolTraceControllerDeps());
}

const toolTraceController = createToolTraceController();

let renderTraceControllerInstance = null;
let messageRenderControllerInstance = null;
let historyRenderControllerInstance = null;
let filePreviewControllerInstance = null;

function createLazyControllerProxy(getController) {
  return new Proxy({}, {
    get(_target, prop) {
      const controller = getController();
      const value = controller?.[prop];
      return typeof value === 'function' ? value.bind(controller) : value;
    },
  });
}

function createRenderTraceControllerDeps() {
  return {
    windowObject: window,
    localStorageRef: localStorage,
    renderTraceBadge,
    storageKey: RENDER_TRACE_STORAGE_KEY,
    getRenderTraceDebugEnabled: () => renderTraceDebugEnabled,
    setRenderTraceDebugEnabledState: (value) => {
      renderTraceDebugEnabled = Boolean(value);
    },
    consoleRef: console,
  };
}

function createRenderTraceController() {
  return renderTraceHelpers.createController(createRenderTraceControllerDeps());
}

function getRenderTraceController() {
  if (!renderTraceControllerInstance) {
    renderTraceControllerInstance = createRenderTraceController();
    renderTraceDebugEnabled = renderTraceControllerInstance.resolveRenderTraceDebugEnabled();
  }
  return renderTraceControllerInstance;
}

function createMessageRenderControllerDeps() {
  return {
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
  };
}

function createMessageRenderController() {
  return renderTraceHelpers.createMessageRenderController(createMessageRenderControllerDeps());
}

function getMessageRenderController() {
  if (!messageRenderControllerInstance) {
    messageRenderControllerInstance = createMessageRenderController();
  }
  return messageRenderControllerInstance;
}

function createHistoryRenderControllerDeps({
  getActiveChatId,
  getRenderedChatId,
  setRenderedChatId,
} = {}) {
  return {
    messagesEl,
    jumpLatestButton,
    jumpLastStartButton,
    histories,
    virtualizationRanges,
    virtualMetrics,
    renderedHistoryLength,
    renderedHistoryVirtualized,
    renderedTranscriptSignatureByChat,
    unseenStreamChats,
    chatScrollTop,
    chatStickToBottom,
    historyCountEl: historyCount,
    virtualizeThreshold: VIRTUALIZE_THRESHOLD,
    estimatedMessageHeight: ESTIMATED_MESSAGE_HEIGHT,
    virtualOverscan: VIRTUAL_OVERSCAN,
    getActiveChatId,
    getRenderedChatId,
    setRenderedChatId,
    refreshTabNode,
    syncActiveStreamUnseenState: (chatId, options = {}) => chatHistoryController.syncActiveStreamUnseenState(chatId, options),
    syncActiveViewportReadState: (chatId, options = {}) => chatHistoryController.syncActiveViewportReadState(chatId, options),
    clearSelectionQuoteStateFn: clearSelectionQuoteState,
    syncLiveToolStreamForChatFn: syncLiveToolStreamForChat,
    appendMessagesFn: appendMessages,
    shouldUseAppendOnlyRenderFn: runtimeHelpers.shouldUseAppendOnlyRender,
    renderTraceLogFn: renderTraceLog,
    createSpacerElementFn: () => document.createElement("div"),
    createFragmentFn: () => document.createDocumentFragment(),
  };
}

function createHistoryRenderControllerArgs() {
  return {
    getActiveChatId: () => Number(activeChatId),
    getRenderedChatId: () => Number(renderedChatId),
    setRenderedChatId: (value) => {
      renderedChatId = value;
    },
  };
}

function createHistoryRenderController() {
  return renderTraceHelpers.createHistoryRenderController(createHistoryRenderControllerDeps(createHistoryRenderControllerArgs()));
}

function getHistoryRenderController() {
  if (!historyRenderControllerInstance) {
    historyRenderControllerInstance = createHistoryRenderController();
  }
  return historyRenderControllerInstance;
}

function createFilePreviewControllerDeps() {
  return {
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
  };
}

function createFilePreviewController() {
  return filePreviewHelpers.createController(createFilePreviewControllerDeps());
}

function getFilePreviewController() {
  if (!filePreviewControllerInstance) {
    filePreviewControllerInstance = createFilePreviewController();
  }
  return filePreviewControllerInstance;
}

const renderTraceController = createLazyControllerProxy(getRenderTraceController);
const messageRenderController = createLazyControllerProxy(getMessageRenderController);
const historyRenderController = createLazyControllerProxy(getHistoryRenderController);
const filePreviewController = createLazyControllerProxy(getFilePreviewController);

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
  return getLatencyViewController().setChatLatency(chatId, text);
}

function syncActiveLatencyChip() {
  return getLatencyViewController().syncActiveLatencyChip();
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
let flushPendingBootSummaries = async () => false;
let markBackgrounded = () => ({});
let markVisibilityResume = () => ({});
let markVersionSyncReloadIntent = () => ({});

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
  navigatorObject: navigator,
  latencyChip,
  setActivityChip,
  formatLatency,
  consoleObject: console,
});
bootMetrics = startupMetricsController.bootMetrics;
recordBootMetric = startupMetricsController.recordBootMetric;
const recordBootMeta = startupMetricsController.recordBootMeta;
syncBootLatencyChip = startupMetricsController.syncBootLatencyChip;
logBootStage = startupMetricsController.logBootStage;
summarizeBootMetrics = startupMetricsController.summarizeBootMetrics;
revealShell = startupMetricsController.revealShell;
flushPendingBootSummaries = startupMetricsController.flushPendingBootSummaries || flushPendingBootSummaries;
markBackgrounded = startupMetricsController.markBackgrounded || markBackgrounded;
markVisibilityResume = startupMetricsController.markVisibilityResume || markVisibilityResume;
markVersionSyncReloadIntent = startupMetricsController.markVersionSyncReloadIntent || markVersionSyncReloadIntent;
recordBootMetric("appScriptStartMs");
void flushPendingBootSummaries();
recordBootMeta?.({
  authBootstrapAttempts: 0,
  authBootstrapRetryCount: 0,
  authBootstrapRetryBackoffMsTotal: 0,
  mobileBootstrapPath: Boolean(mobileQuoteMode),
});
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
  latencyStorageLoaded = false;
  return ensureLatencyStorageLoaded();
}

function persistLatencyByChatToStorage() {
  return getLatencyPersistenceController().persistLatencyByChatToStorage();
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

function mergePendingSnapshotIntoHistory(history, snapshot) {
  return streamPersistenceController.mergePendingSnapshotIntoHistory(history, snapshot);
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

function openFilePreviewByRef(refId, options = {}) {
  return filePreviewController.openFilePreviewByRef(refId, options);
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

function createBootstrapAuthStageReporter({
  recordBootMeta,
  getBootMeta,
  logBootStage,
}) {
  return (stage, details = {}) => {
    const normalized = details && typeof details === 'object' ? details : {};
    const bootMeta = getBootMeta?.() || {};
    if (stage === 'auth-bootstrap-attempt-start') {
      recordBootMeta?.('authBootstrapAttempts', Math.max(Number(normalized.attempt) || 0, Number(bootMeta?.authBootstrapAttempts || 0)));
    } else if (stage === 'auth-bootstrap-retry-scheduled') {
      const currentCount = Number(bootMeta?.authBootstrapRetryCount || 0);
      const currentBackoff = Number(bootMeta?.authBootstrapRetryBackoffMsTotal || 0);
      recordBootMeta?.({
        authBootstrapRetryCount: currentCount + 1,
        authBootstrapRetryBackoffMsTotal: currentBackoff + Math.max(0, Number(normalized.backoffMs) || 0),
        authBootstrapLastBackoffMs: Math.max(0, Number(normalized.backoffMs) || 0),
      });
    } else if (stage === 'auth-bootstrap-ok' || stage === 'auth-bootstrap-failed') {
      recordBootMeta?.({
        authBootstrapFinalStatus: Number(normalized.status || 0),
        authBootstrapSucceeded: stage === 'auth-bootstrap-ok',
      });
    } else if (stage === 'auth-bootstrap-attempt-error') {
      recordBootMeta?.('authBootstrapLastError', String(normalized.message || ''));
    } else if (stage === 'auth-bootstrap-applied-start') {
      recordBootMeta?.({
        bootstrapChatCount: Number(normalized.chatCount || 0),
        bootstrapActiveChatId: Number(normalized.activeChatId || 0),
      });
    } else if (stage === 'initial-render-start') {
      recordBootMeta?.({
        bootstrapHistoryCount: Number(normalized.historyCount || 0),
        restoredPendingSnapshot: Boolean(normalized.restoredPendingSnapshot),
      });
    } else if (stage === 'warm-history-cache-triggered') {
      recordBootMeta?.('warmedHistoryOnOpen', true);
    } else if (stage === 'warm-history-cache-deferred-pending-resume') {
      recordBootMeta?.('warmHistoryDeferredForPendingResumeOnOpen', true);
    } else if (stage === 'pending-stream-resume-triggered') {
      recordBootMeta?.('resumedPendingStreamOnOpen', true);
    } else if (stage === 'auth-bootstrap-applied-finished') {
      recordBootMeta?.('pendingResumeTriggered', Boolean(normalized.pendingResumeTriggered));
    }
    logBootStage(stage, normalized);
  };
}

function createBootstrapAuthControllerSessionDeps({
  desktopTestingEnabled,
  devAuthSessionStorageKey,
  devAuthHashSecret,
  devAuthControls,
  devModeBadge,
  devSignInButton,
  getIsAuthenticated,
  setIsAuthenticated,
  sessionStorageRef,
  devAuthModal,
  devAuthForm,
  devAuthSecretInput,
  devAuthUserIdInput,
  devAuthDisplayNameInput,
  devAuthUsernameInput,
  devAuthCancelButton,
  authStatus,
  appendSystemMessage,
  fetchImpl,
  initData,
  parseSseEvent,
  setOperatorDisplayName,
  getOperatorDisplayName,
  operatorName,
  messagesEl,
}) {
  return {
    desktopTestingEnabled,
    devAuthSessionStorageKey,
    devAuthHashSecret,
    devAuthControls,
    devModeBadge,
    devSignInButton,
    getIsAuthenticated,
    setIsAuthenticated,
    sessionStorageRef,
    devAuthModal,
    devAuthForm,
    devAuthSecretInput,
    devAuthUserIdInput,
    devAuthDisplayNameInput,
    devAuthUsernameInput,
    devAuthCancelButton,
    authStatus,
    appendSystemMessage,
    fetchImpl,
    initData,
    parseSseEvent,
    setOperatorDisplayName,
    getOperatorDisplayName,
    operatorName,
    messagesEl,
  };
}

function createBootstrapAuthControllerAppDeps({
  setSkin,
  setTelegramUnreadNotificationsEnabled,
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
  hasFreshPendingStreamSnapshot,
  restorePendingStreamSnapshot,
  restoreActiveBootstrapPendingState,
  syncBootstrapActivationReadState,
  windowObject,
}) {
  return {
    setSkin,
    setTelegramUnreadNotificationsEnabled,
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
    hasFreshPendingStreamSnapshot,
    restorePendingStreamSnapshot,
    restoreActiveBootstrapPendingState,
    syncBootstrapActivationReadState,
    windowObject,
  };
}

function createBootstrapAuthControllerBootstrapDeps({
  authBootstrapMaxAttempts,
  authBootstrapBaseDelayMs,
  authBootstrapRetryableStatus,
  bootBootstrapVersion,
  bootstrapVersionReloadStorageKey,
  recordBootMetric,
  syncBootLatencyChip,
  updateComposerState,
  isMobileQuoteMode,
  markVersionSyncReloadIntent,
  onBootstrapStage,
}) {
  return {
    authBootstrapMaxAttempts,
    authBootstrapBaseDelayMs,
    authBootstrapRetryableStatus,
    bootBootstrapVersion,
    bootstrapVersionReloadStorageKey,
    recordBootMetric,
    syncBootLatencyChip,
    updateComposerState,
    isMobileQuoteMode,
    markVersionSyncReloadIntent,
    onBootstrapStage,
  };
}

function createBootstrapAuthControllerDeps(args) {
  return {
    ...createBootstrapAuthControllerSessionDeps(args),
    ...createBootstrapAuthControllerAppDeps(args),
    ...createBootstrapAuthControllerBootstrapDeps(args),
  };
}

function readSessionStorageKey(key) {
  try {
    return window.sessionStorage?.getItem?.(key) || null;
  } catch {
    return null;
  }
}

function writeSessionStorageKey(key, value) {
  try {
    if (value == null || value === '') {
      window.sessionStorage?.removeItem?.(key);
      return;
    }
    window.sessionStorage?.setItem?.(key, String(value));
  } catch {
    // best effort only
  }
}

function getPresenceInstanceId() {
  const existing = readSessionStorageKey(PRESENCE_INSTANCE_ID_SESSION_STORAGE_KEY);
  if (existing) return existing;
  const nextId = `miniapp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  writeSessionStorageKey(PRESENCE_INSTANCE_ID_SESSION_STORAGE_KEY, nextId);
  return nextId;
}

function persistPreferredActiveChatId(chatId) {
  const normalizedChatId = Number(chatId || 0);
  if (normalizedChatId > 0) {
    writeSessionStorageKey(PREFERRED_ACTIVE_CHAT_SESSION_STORAGE_KEY, normalizedChatId);
    return normalizedChatId;
  }
  writeSessionStorageKey(PREFERRED_ACTIVE_CHAT_SESSION_STORAGE_KEY, null);
  return null;
}

function createBootstrapAuthControllerStateArgs() {
  return {
    desktopTestingEnabled,
    devAuthSessionStorageKey: DEV_AUTH_SESSION_STORAGE_KEY,
    preferredActiveChatSessionStorageKey: PREFERRED_ACTIVE_CHAT_SESSION_STORAGE_KEY,
    devAuthHashSecret,
    devAuthControls,
    devModeBadge,
    devSignInButton,
    getIsAuthenticated: () => isAuthenticated,
    setIsAuthenticated: (value) => {
      isAuthenticated = Boolean(value);
      syncTelegramUnreadNotificationsToggle();
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
  };
}

function createBootstrapAuthControllerAppArgs() {
  return {
    setSkin,
    setTelegramUnreadNotificationsEnabled: (value) => {
      setTelegramUnreadNotificationsEnabled(value);
    },
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
    hasFreshPendingStreamSnapshot,
    restorePendingStreamSnapshot,
    restoreActiveBootstrapPendingState: (chatId, options = {}) => (
      typeof chatHistoryController?.restoreActiveBootstrapPendingState === 'function'
        ? chatHistoryController.restoreActiveBootstrapPendingState(chatId, options)
        : null
    ),
    syncBootstrapActivationReadState: (chatId, options = {}) => (
      typeof chatHistoryController?.syncBootstrapActivationReadState === 'function'
        ? chatHistoryController.syncBootstrapActivationReadState(chatId, options)
        : false
    ),
    getActiveChatId: () => Number(activeChatId),
    windowObject: window,
  };
}

function createBootstrapAuthControllerBootstrapArgs() {
  return {
    authBootstrapMaxAttempts: AUTH_BOOTSTRAP_MAX_ATTEMPTS,
    authBootstrapBaseDelayMs: AUTH_BOOTSTRAP_BASE_DELAY_MS,
    authBootstrapRetryableStatus: AUTH_BOOTSTRAP_RETRYABLE_STATUS,
    bootBootstrapVersion,
    bootstrapVersionReloadStorageKey: BOOTSTRAP_VERSION_RELOAD_STORAGE_KEY,
    recordBootMetric,
    syncBootLatencyChip,
    updateComposerState,
    isMobileQuoteMode: () => mobileQuoteMode,
    markVersionSyncReloadIntent,
    onBootstrapStage: createBootstrapAuthStageReporter({
      recordBootMeta,
      getBootMeta: () => startupMetricsController.bootMeta,
      logBootStage,
    }),
  };
}

function createBootstrapAuthControllerArgs() {
  return {
    ...createBootstrapAuthControllerStateArgs(),
    ...createBootstrapAuthControllerAppArgs(),
    ...createBootstrapAuthControllerBootstrapArgs(),
  };
}

function createBootstrapAuthController() {
  return bootstrapAuthHelpers.createController(createBootstrapAuthControllerDeps(createBootstrapAuthControllerArgs()));
}

const bootstrapAuthController = createBootstrapAuthController();

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
let attentionEffectsControllerInstance = null;

function getAttentionEffectsController() {
  if (!attentionEffectsControllerInstance) {
    attentionEffectsControllerInstance = runtimeHelpers.createAttentionEffectsController({
      tg,
      histories,
      incomingMessageHapticKeys,
      chats,
      getActiveChatId: () => activeChatId,
      isDocumentHidden: () => document.visibilityState !== "visible",
      renderTraceLog,
    });
  }
  return attentionEffectsControllerInstance;
}

function latestCompletedAssistantHapticKey(chatId) {
  return getAttentionEffectsController().latestCompletedAssistantHapticKey(chatId);
}

function triggerIncomingMessageHaptic(chatId, { messageKey = "", fallbackToLatestHistory = true } = {}) {
  return getAttentionEffectsController().triggerIncomingMessageHaptic(chatId, { messageKey, fallbackToLatestHistory });
}

function incrementUnread(chatId) {
  return getAttentionEffectsController().incrementUnread(chatId);
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

function closeChatTabContextMenu() {
  return chatAdminController.closeChatTabContextMenu();
}

function openChatTabContextMenu(chatId, clientX, clientY) {
  return chatAdminController.openChatTabContextMenu(chatId, clientX, clientY);
}

function closePinnedChatContextMenu() {
  return chatAdminController.closePinnedChatContextMenu();
}

function openPinnedChatContextMenu(chatId, clientX, clientY) {
  return chatAdminController.openPinnedChatContextMenu(chatId, clientX, clientY);
}

function handleTabOverflowTriggerClick(event) {
  return chatAdminController.handleTabOverflowTriggerClick(event);
}

function handlePinnedOverflowTriggerClick(event) {
  return chatAdminController.handlePinnedOverflowTriggerClick(event);
}

async function handleTabContextRenameClick(event) {
  return chatAdminController.handleTabContextRenameClick(event);
}

async function handleTabContextPinClick(event) {
  return chatAdminController.handleTabContextPinClick(event);
}

async function handleTabContextCloseClick(event) {
  return chatAdminController.handleTabContextCloseClick(event);
}

async function handleTabContextForkClick(event) {
  return chatAdminController.handleTabContextForkClick(event);
}

async function handlePinnedContextRemoveClick(event) {
  return chatAdminController.handlePinnedContextRemoveClick(event);
}

function handleGlobalChatContextMenuDismiss(event) {
  return chatAdminController.handleGlobalChatContextMenuDismiss(event);
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
    focusComposerAfterQuoteInsertionFn: (caretPosition) => composerViewportController.focusComposerAfterQuoteInsertion(caretPosition),
    mobileQuoteMode,
    documentObject: document,
    windowObject: window,
  });
}

function activeSelectionQuote() {
  return interactionHelpers.activeSelectionQuote({
    messagesEl,
    windowObject: window,
    documentObject: document,
    normalizeQuoteSelectionFn: normalizeQuoteSelection,
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
      messagesEl,
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

async function syncUnreadNotificationPresence(options = {}) {
  return visibilitySkinController.syncUnreadNotificationPresence(options);
}

function syncTelegramUnreadNotificationsToggle() {
  if (!telegramUnreadNotificationsToggle) return;
  telegramUnreadNotificationsToggle.checked = Boolean(telegramUnreadNotificationsEnabled);
  telegramUnreadNotificationsToggle.disabled = !isAuthenticated;
}

function setTelegramUnreadNotificationsEnabled(value) {
  telegramUnreadNotificationsEnabled = Boolean(value);
  syncTelegramUnreadNotificationsToggle();
}

function getTelegramUnreadNotificationsEnabled() {
  return Boolean(telegramUnreadNotificationsEnabled);
}

function syncActivePendingStatus() {
  return getStreamActivityController().syncActivePendingStatus();
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
  const result = activeChatMetaController.setActiveChatMeta(chatId, options);
  persistPreferredActiveChatId(chatId);
  return result;
}

function setNoActiveChatMeta() {
  const result = activeChatMetaController.setNoActiveChatMeta();
  persistPreferredActiveChatId(null);
  return result;
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

chatHistoryController = chatHistoryHelpers.createController({
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
  readPendingStreamSnapshotMap,
  mergePendingSnapshotIntoHistory,
  persistPendingStreamSnapshot,
  clearPendingStreamSnapshot,
  shouldResumeOnVisibilityChange: (args = {}) => {
    if (reconnectResumeBlockedChats.has(Number(args?.activeChatId))) {
      return false;
    }
    return runtimeHelpers.shouldResumeOnVisibilityChange(args);
  },
  shouldDeferNonCriticalCachedOpen: () => !mobileQuoteMode && document.visibilityState === 'visible',
  shouldUseIdleForDeferredCachedHydration: () => !mobileQuoteMode,
  triggerIncomingMessageHaptic,
  getRenderedTranscriptSignature: (chatId) => {
    const key = Number(chatId);
    if (!key || key !== Number(renderedChatId)) return '';
    return String(renderedTranscriptSignatureByChat.get(key) || '');
  },
  renderTraceLog,
  nowMs: () => (typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now()),
});

const chatAdminController = chatAdminHelpers.createController({
  windowObject: window,
  tabActionsMenuEnabled: tabActionsMenuFeatureEnabled,
  settingsModal,
  keyboardShortcutsModal,
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
  chatTabContextRename,
  chatTabContextPin,
  chatTabContextClose,
  chatTabContextFork,
  pinnedChatContextMenu,
  pinnedChatContextRemove,
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
  moveChatToEnd: (chatId) => chatTabsController.moveChatToEnd(chatId),
  getOrderedChatIds: () => chatTabsController.getOrderedChatIds(),
  chatLabel,
  getActiveChatId: () => Number(activeChatId),
  openChat,
  onLatencyByChatMutated: persistLatencyByChatToStorage,
  buildChatPreservingUnread: (chat, options = {}) => chatHistoryController.buildChatPreservingUnread(chat, options),
  focusComposerForNewChat,
});

function createShellUiControllerDeps() {
  return {
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
  };
}

function createShellUiController() {
  return shellUiHelpers.createController(createShellUiControllerDeps());
}

const shellUiController = createShellUiController();

function createComposerViewportControllerDeps() {
  return {
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
  };
}

function createComposerViewportController() {
  return composerViewportHelpers.createController(createComposerViewportControllerDeps());
}

const composerViewportController = createComposerViewportController();

function createLatencyViewControllerDeps() {
  return {
    latencyByChat,
    getActiveChatId: () => Number(activeChatId),
    hasLiveStreamController,
    setActivityChip,
    preserveViewportDuringUiMutation,
    latencyChip,
    streamDebugLog,
    onLatencyMapMutated: () => persistLatencyByChatToStorage(),
    renderTraceLog,
    getDocumentVisibilityState: () => document.visibilityState,
  };
}

function createStreamActivityControllerDeps() {
  return {
    chats,
    getActiveChatId: () => Number(activeChatId),
    hasLiveStreamController,
    getChatLatencyText: (chatId) => latencyByChat.get(Number(chatId)) || '',
    getStreamPhase,
    streamPhases: STREAM_PHASES,
    chatLabel,
    compactChatLabel,
    setStreamStatus,
    setActivityChip,
    streamChip,
    latencyChip,
    setChatLatency,
    syncActiveLatencyChip,
    formatLatency,
  };
}

let latencyViewControllerInstance = null;
let streamActivityControllerInstance = null;

function getLatencyViewController() {
  if (!latencyViewControllerInstance) {
    ensureLatencyStorageLoaded();
    latencyViewControllerInstance = runtimeHelpers.createLatencyController(createLatencyViewControllerDeps());
  }
  return latencyViewControllerInstance;
}

function getStreamActivityController() {
  if (!streamActivityControllerInstance) {
    streamActivityControllerInstance = runtimeHelpers.createStreamActivityController(createStreamActivityControllerDeps());
  }
  return streamActivityControllerInstance;
}

function createVisibilitySkinControllerStateDeps() {
  return {
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
  };
}

function createVisibilitySkinControllerRuntimeDeps() {
  function historyContainsMessageId(history, messageId) {
    const targetId = Math.max(0, Number(messageId || 0));
    if (targetId <= 0 || !Array.isArray(history)) {
      return false;
    }
    return history.some((item) => Number(item?.id || 0) === targetId);
  }

  function shouldDeferImmediateActiveMessageView(chatId) {
    const key = Number(chatId || 0);
    if (key <= 0) {
      return false;
    }
    const activeChat = chats.get(key);
    const unreadAnchorMessageId = Math.max(0, Number(activeChat?.newest_unread_message_id || 0));
    if (unreadAnchorMessageId <= 0) {
      return false;
    }
    const history = histories.get(key) || [];
    return !historyContainsMessageId(history, unreadAnchorMessageId);
  }

  return {
    apiPost,
    syncTelegramChromeForSkin,
    getIsAuthenticated: () => isAuthenticated,
    getActiveChatId: () => Number(activeChatId),
    getPresenceInstanceId,
    refreshChats,
    syncVisibleActiveChat,
    syncActiveMessageView,
    getStreamAbortControllers,
    shouldDeferImmediateActiveMessageView,
    maybeRefreshForBootstrapVersionMismatch,
    markBackgrounded,
    markVisibilityResume,
  };
}

function createVisibilitySkinControllerDeps() {
  return {
    ...createVisibilitySkinControllerStateDeps(),
    ...createVisibilitySkinControllerRuntimeDeps(),
  };
}

function createVisibilitySkinController() {
  return visibilitySkinHelpers.createController(createVisibilitySkinControllerDeps());
}

const visibilitySkinController = createVisibilitySkinController();

function createStartupBindingsControllerElementDeps({
  getActiveChatId,
  getRenderedChatId,
  getIsAuthenticated,
  setInitData,
  getInitData,
  getRenderTraceDebugEnabled,
  isMobileBootstrapPath,
  getChatsSize,
  isActiveChatPending,
  getStreamAbortControllers,
} = {}) {
  return {
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
    keyboardShortcutsTopButton,
    keyboardShortcutsButton,
    devSignInButton,
    settingsClose,
    keyboardShortcutsClose,
    settingsModal,
    keyboardShortcutsModal,
    telegramUnreadNotificationsToggle,
    authStatusEl: authStatus,
    operatorNameEl: operatorName,
    formEl: form,
    promptEl,
    sendButton,
    templateEl: template,
    tg,
  };
}

function createStartupBindingsControllerInteractionDeps({
  getActiveChatId,
  getRenderedChatId,
  getIsAuthenticated,
  setInitData,
  getInitData,
  getRenderTraceDebugEnabled,
  isMobileBootstrapPath,
  getChatsSize,
  isActiveChatPending,
  getStreamAbortControllers,
} = {}) {
  return {
    getActiveChatId,
    getRenderedChatId,
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
    syncActiveViewportReadState: (chatId, options = {}) => chatHistoryController.syncActiveViewportReadState(chatId, options),
    updateJumpLatestVisibility,
    syncActiveMessageView,
    cancelSelectionQuoteSync,
    cancelSelectionQuoteSettle,
    cancelSelectionQuoteClear,
    clearSelectionQuoteState,
    hasMessageSelectionFn: (selection) => interactionHelpers.hasMessageSelection(selection, { messagesEl }),
    scheduleSelectionQuoteSync,
    mobileQuoteMode,
    noteMobileCarouselInteraction: () => chatTabsController.noteMobileCarouselInteraction(),
    handleTabClick,
    handlePinnedChatClick,
    togglePinnedChatsCollapsed,
    handleGlobalTabCycle,
    handleGlobalArrowJump,
    handleGlobalComposerFocusShortcut,
    handleGlobalChatActionShortcut,
    handleGlobalShortcutsHelpShortcut,
    handleGlobalControlEnterDefuse,
    handleGlobalControlMouseDownFocusGuard,
    handleGlobalControlClickFocusCleanup,
    handleFullscreenToggle,
    handleCloseApp,
    handleRenderTraceBadgeClick,
    openSettingsModal,
    closeSettingsModal,
    openKeyboardShortcutsModal,
    closeKeyboardShortcutsModal,
    signInWithDevAuth,
    getIsAuthenticated,
    setInitData,
    getInitData,
    getRenderTraceDebugEnabled,
    isMobileBootstrapPath,
    getChatsSize,
    isActiveChatPending,
    getStreamAbortControllers,
  };
}

function createStartupBindingsControllerBootstrapDeps() {
  return {
    appendSystemMessage,
    syncDevAuthUi,
    reportUiError,
    getTelegramUnreadNotificationsEnabled,
    saveSkinPreference,
    saveTelegramUnreadNotificationsPreference,
    createChat,
    renameActiveChat,
    toggleActiveChatPin,
    removeActiveChat,
    syncRenderTraceBadge,
    loadDraftsFromStorage,
    syncClosingConfirmation,
    syncFullscreenControlState,
    maybeRefreshForBootstrapVersionMismatch,
    logBootStage,
    syncBootLatencyChip,
    fetchAuthBootstrapWithRetry,
    desktopTestingEnabled,
    desktopTestingRequested,
    devConfig,
    applyAuthBootstrap,
    hasFreshPendingStreamSnapshot,
    restorePendingStreamSnapshot,
    restoreActiveBootstrapPendingState: (chatId, options = {}) => (
      typeof chatHistoryController?.restoreActiveBootstrapPendingState === 'function'
        ? chatHistoryController.restoreActiveBootstrapPendingState(chatId, options)
        : null
    ),
    renderMessages,
    updateComposerState,
    syncUnreadNotificationPresence,
    revealShell,
    recordBootMetric,
    summarizeBootMetrics,
    refreshChats,
    syncVisibleActiveChat,
  };
}

function createStartupBindingsControllerDeps(args = {}) {
  return {
    ...createStartupBindingsControllerElementDeps(args),
    ...createStartupBindingsControllerInteractionDeps(args),
    ...createStartupBindingsControllerBootstrapDeps(args),
  };
}

function createStartupBindingsControllerStateArgs() {
  return {
    getActiveChatId: () => Number(activeChatId),
    getRenderedChatId: () => Number(renderedChatId),
    getIsAuthenticated: () => isAuthenticated,
    setInitData: (value) => {
      initData = String(value || "");
    },
    getInitData: () => initData,
    getRenderTraceDebugEnabled: () => renderTraceDebugEnabled,
  };
}

function createStartupBindingsControllerRuntimeArgs() {
  return {
    isMobileBootstrapPath: () => mobileQuoteMode,
    getChatsSize: () => chats.size,
    isActiveChatPending: () => Boolean(activeChatId && chats.get(Number(activeChatId))?.pending),
    getStreamAbortControllers: () => streamController.getAbortControllers(),
  };
}

function createStartupBindingsControllerArgs() {
  return {
    ...createStartupBindingsControllerStateArgs(),
    ...createStartupBindingsControllerRuntimeArgs(),
  };
}

function createStartupBindingsController() {
  return startupBindingsHelpers.createController(createStartupBindingsControllerDeps(createStartupBindingsControllerArgs()));
}

const startupBindingsController = createStartupBindingsController();

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

function getCurrentUnreadCount(chatId) {
  if (typeof chatHistoryController?.getCurrentUnreadCount === 'function') {
    return chatHistoryController.getCurrentUnreadCount(chatId);
  }
  return Math.max(0, Number(chats.get(Number(chatId))?.unread_count || 0));
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

async function saveTelegramUnreadNotificationsPreference(enabled) {
  const data = await apiPost('/api/preferences/telegram-unread-notifications', {
    enabled: Boolean(enabled),
  });
  setTelegramUnreadNotificationsEnabled(Boolean(data?.telegram_unread_notifications_enabled));
  return data;
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
  getRenderedChatId: () => Number(renderedChatId),
  triggerIncomingMessageHaptic,
  messagesEl,
  promptEl,
  isMobileQuoteMode: () => mobileQuoteMode,
  isDesktopViewport,
  maybeMarkRead,
  syncActiveViewportReadState: (chatId, options = {}) => chatHistoryController.syncActiveViewportReadState(chatId, options),
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
  getRenderedTranscriptSignature: (chatId) => {
    const key = Number(chatId);
    if (!key || key !== Number(renderedChatId)) return '';
    return String(renderedTranscriptSignatureByChat.get(key) || '');
  },
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

function createInteractionControllerDeps({
  activeChatIdProvider,
} = {}) {
  return {
    mobileQuoteMode,
    activeChatId: Number(activeChatId),
    getActiveChatId: activeChatIdProvider,
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
  };
}

const interactionController = interactionHelpers.createController(createInteractionControllerDeps({
  activeChatIdProvider: () => Number(activeChatId),
}));

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
  tabsEl,
  tabNodes,
  telegramUnreadNotificationsToggle,
  jumpLatestButton,
  jumpLastStartButton,
  chats,
  getOrderedChatIds: () => chatTabsController.getOrderedChatIds(),
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
  openKeyboardShortcutsModal,
});

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

function handleGlobalShortcutsHelpShortcut(event) {
  return keyboardShortcutsController.handleGlobalShortcutsHelpShortcut(event);
}

function openKeyboardShortcutsModal() {
  return chatAdminController.openKeyboardShortcutsModal();
}

function closeKeyboardShortcutsModal() {
  return chatAdminController.closeKeyboardShortcutsModal();
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

function closeAllChatContextMenus() {
  closeChatTabContextMenu();
  closePinnedChatContextMenu();
}

function runChatContextAction(action, event, { preventDefault = false } = {}) {
  if (preventDefault) {
    event?.preventDefault?.();
  }
  void (async () => {
    try {
      await action(event);
    } catch (error) {
      reportUiError(error);
    }
  })();
}

tabsEl?.addEventListener?.("click", handleTabOverflowTriggerClick, true);
pinnedChatsEl?.addEventListener?.("click", handlePinnedOverflowTriggerClick, true);
chatTabContextRename?.addEventListener?.("click", (event) => {
  runChatContextAction(handleTabContextRenameClick, event);
});
chatTabContextRename?.addEventListener?.("touchend", (event) => {
  runChatContextAction(handleTabContextRenameClick, event, { preventDefault: true });
}, { passive: false });
chatTabContextPin?.addEventListener?.("click", (event) => {
  runChatContextAction(handleTabContextPinClick, event);
});
chatTabContextPin?.addEventListener?.("touchend", (event) => {
  runChatContextAction(handleTabContextPinClick, event, { preventDefault: true });
}, { passive: false });
chatTabContextClose?.addEventListener?.("click", (event) => {
  runChatContextAction(handleTabContextCloseClick, event);
});
chatTabContextClose?.addEventListener?.("touchend", (event) => {
  runChatContextAction(handleTabContextCloseClick, event, { preventDefault: true });
}, { passive: false });
chatTabContextFork?.addEventListener?.("click", (event) => {
  runChatContextAction(handleTabContextForkClick, event);
});
chatTabContextFork?.addEventListener?.("touchend", (event) => {
  runChatContextAction(handleTabContextForkClick, event, { preventDefault: true });
}, { passive: false });
pinnedChatContextRemove?.addEventListener?.("click", (event) => {
  runChatContextAction(handlePinnedContextRemoveClick, event);
});
pinnedChatContextRemove?.addEventListener?.("touchend", (event) => {
  runChatContextAction(handlePinnedContextRemoveClick, event, { preventDefault: true });
}, { passive: false });
document?.addEventListener?.("pointerdown", handleGlobalChatContextMenuDismiss, true);
document?.addEventListener?.("click", handleGlobalChatContextMenuDismiss, true);
window?.addEventListener?.("blur", closeAllChatContextMenus);
window?.addEventListener?.("resize", closeAllChatContextMenus);
window?.addEventListener?.("scroll", closeAllChatContextMenus, true);
document?.addEventListener?.("keydown", (event) => {
  if (event.key === "Escape") {
    closeAllChatContextMenus();
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