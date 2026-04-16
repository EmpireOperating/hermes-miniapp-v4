import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const sharedUtils = require('../static/app_shared_utils.js');
const streamState = require('../static/stream_state_helpers.js');
const streamController = require('../static/stream_controller.js');

function buildControllerHarness(overrides = {}) {
  const phases = new Map();
  const pendingAssistantUpdates = [];
  const streamStatuses = [];
  const streamChipUpdates = [];
  const latencyUpdates = [];
  const chatsUpserted = [];
  const renderedMessages = [];
  const toolTraceLines = [];
  const streamDebugEvents = [];
  const finalizeCalls = [];
  const syncedActiveRenders = [];
  const scheduledActiveRenders = [];
  const persistedCursors = [];
  const clearedCursors = [];
  const incomingHaptics = [];
  const unreadIncrements = [];
  const syncActiveViewportReadStateCalls = [];
  const renderTabsCalls = [];
  const markStreamCompleteCalls = [];
  const markToolActivityCalls = [];
  const markStreamActiveCalls = [];
  const markStreamErrorCalls = [];
  const markStreamClosedEarlyCalls = [];
  const markNetworkFailureCalls = [];
  const markStreamReconnectingCalls = [];
  const markResumeAlreadyCompleteCalls = [];
  const markReconnectFailedCalls = [];
  const systemMessages = [];
  const localMessages = [];
  const draftUpdates = [];
  const droppedPendingToolTraceChats = [];
  const authPayloads = [];
  const fetchCalls = [];
  const pendingChatsMarked = [];
  const clearedReconnectBlocks = [];
  const suppressedBlockedChats = [];
  const blockedReconnectChats = [];
  const delayedMs = [];
  const timeoutCalls = [];
  const resumeAttemptedAtByChat = new Map();
  const resumeCooldownUntilByChat = new Map();
  const resumeInFlightByChat = new Set();
  const histories = new Map();
  let isAuthenticated = true;
  const authStatusEl = { textContent: '' };
  let promptFocusCalls = 0;
  const promptEl = {
    value: '',
    focus: () => {
      promptFocusCalls += 1;
    },
  };

  const deps = {
    parseSseEvent: sharedUtils.parseSseEvent,
    formatLatency: sharedUtils.formatLatency,
    STREAM_PHASES: streamState.STREAM_PHASES,
    getStreamPhase: (chatId) => phases.get(Number(chatId)) || streamState.STREAM_PHASES.IDLE,
    setStreamPhase: (chatId, phase) => phases.set(Number(chatId), phase),
    isPatchPhaseAllowed: () => false,
    chats: new Map(),
    pendingChats: new Set(),
    chatLabel: (chatId) => `chat-${chatId}`,
    compactChatLabel: (chatId) => `#${chatId}`,
    setStreamStatus: (value) => streamStatuses.push(String(value)),
    setActivityChip: (chip, value) => {
      if (chip === 'stream-chip') {
        streamChipUpdates.push(String(value));
      }
    },
    streamChip: 'stream-chip',
    latencyChip: 'latency-chip',
    finalizeInlineToolTrace: () => {},
    updatePendingAssistant: (chatId, text, isStreaming) => {
      pendingAssistantUpdates.push({ chatId: Number(chatId), text: String(text), isStreaming: Boolean(isStreaming) });
    },
    markStreamUpdate: () => {},
    patchVisiblePendingAssistant: () => false,
    patchVisibleToolTrace: () => false,
    renderTraceLog: () => {},
    syncActiveMessageView: (chatId) => { syncedActiveRenders.push(Number(chatId)); },
    scheduleActiveMessageView: (chatId) => { scheduledActiveRenders.push(Number(chatId)); },
    setChatLatency: (chatId, text) => latencyUpdates.push({ chatId: Number(chatId), text: String(text) }),
    incrementUnread: (chatId) => unreadIncrements.push(Number(chatId)),
    getActiveChatId: () => 9,
    triggerIncomingMessageHaptic: (chatId, options = {}) => {
      incomingHaptics.push({ chatId: Number(chatId), options });
    },
    messagesEl: null,
    promptEl,
    isMobileQuoteMode: () => false,
    isDesktopViewport: () => true,
    isNearBottom: () => true,
    maybeMarkRead: () => {},
    syncActiveViewportReadState: (chatId, options = {}) => {
      syncActiveViewportReadStateCalls.push([Number(chatId), { ...options }]);
    },
    refreshChats: async () => {},
    renderTabs: () => { renderTabsCalls.push(true); },
    updateComposerState: () => {},
    syncClosingConfirmation: () => {},
    appendSystemMessage: (message, chatId = null) => {
      systemMessages.push({ message: String(message || ''), chatId: chatId == null ? null : Number(chatId) });
    },
    streamDebugLog: (eventName, details = null) => {
      streamDebugEvents.push({ eventName: String(eventName || ''), details });
    },
    finalizeStreamPendingState: (chatId, wasAborted) => {
      finalizeCalls.push({ chatId: Number(chatId), wasAborted: Boolean(wasAborted) });
    },
    appendInlineToolTrace: (chatId, text) => {
      toolTraceLines.push({ chatId: Number(chatId), text: String(text || '') });
    },
    loadChatHistory: async (chatId, { activate } = {}) => ({
      chat: { id: Number(chatId), pending: false, title: `chat-${chatId}` },
      history: [{ role: 'assistant', body: 'hydrated', pending: false }],
      activate: Boolean(activate),
    }),
    upsertChat: (chat) => chatsUpserted.push(chat),
    histories,
    mergeHydratedHistory: ({ nextHistory }) => nextHistory,
    renderMessages: (chatId, options = {}) => renderedMessages.push({ chatId: Number(chatId), options }),
    persistStreamCursor: (chatId, eventId) => persistedCursors.push({ chatId: Number(chatId), eventId: Number(eventId) }),
    clearStreamCursor: (chatId) => clearedCursors.push(Number(chatId)),
    clearReconnectResumeBlock: (chatId) => clearedReconnectBlocks.push(Number(chatId)),
    resetReconnectResumeBudget: (chatId) => timeoutCalls.push({ type: 'reset-budget', chatId: Number(chatId) }),
    markStreamComplete: (chatId, latencyText) => {
      const key = Number(chatId);
      const normalizedLatency = String(latencyText);
      markStreamCompleteCalls.push({ chatId: key, latencyText: normalizedLatency });
      latencyUpdates.push({ chatId: key, text: normalizedLatency });
      streamStatuses.push(`Reply received in chat-${key}`);
      streamChipUpdates.push(`stream: complete · #${key}`);
    },
    markToolActivity: (chatId) => {
      const key = Number(chatId);
      markToolActivityCalls.push(key);
      streamStatuses.push(`Using tools in chat-${key}`);
      streamChipUpdates.push(`stream: tools active · #${key}`);
    },
    markStreamActive: (chatId, options = {}) => {
      const key = Number(chatId);
      markStreamActiveCalls.push({ chatId: key, options: { ...options } });
      if (Number.isFinite(Number(options?.elapsedMs)) && Number(options.elapsedMs) >= 0) {
        latencyUpdates.push({ chatId: key, text: `${sharedUtils.formatLatency(Number(options.elapsedMs))} · live` });
      }
    },
    markStreamError: (chatId) => {
      const key = Number(chatId);
      markStreamErrorCalls.push(key);
      latencyUpdates.push({ chatId: key, text: '--' });
      streamStatuses.push('Stream error');
      streamChipUpdates.push('stream: error');
    },
    markStreamClosedEarly: (chatId) => {
      const key = Number(chatId);
      markStreamClosedEarlyCalls.push(key);
      latencyUpdates.push({ chatId: key, text: '--' });
      streamStatuses.push('Stream closed early');
      streamChipUpdates.push('stream: closed early');
    },
    ...overrides,
  };

  const controller = streamController.createController(deps);
  return {
    controller,
    phases,
    pendingAssistantUpdates,
    streamStatuses,
    streamChipUpdates,
    latencyUpdates,
    chatsUpserted,
    renderedMessages,
    toolTraceLines,
    streamDebugEvents,
    finalizeCalls,
    syncedActiveRenders,
    scheduledActiveRenders,
    persistedCursors,
    clearedCursors,
    incomingHaptics,
    unreadIncrements,
    syncActiveViewportReadStateCalls,
    renderTabsCalls,
    markStreamCompleteCalls,
    markToolActivityCalls,
    markStreamActiveCalls,
    markStreamErrorCalls,
    markStreamClosedEarlyCalls,
    clearedReconnectBlocks,
    timeoutCalls,
    systemMessages,
    histories,
    getPromptFocusCalls: () => promptFocusCalls,
  };
}

function makeSseResponse(rawFrame) {
  const bytes = new TextEncoder().encode(rawFrame);
  let index = 0;
  let cancelCalls = 0;
  const reader = {
    async read() {
      if (index === 0) {
        index += 1;
        return { value: bytes, done: false };
      }
      return { value: undefined, done: true };
    },
    async cancel() {
      cancelCalls += 1;
    },
  };

  return {
    response: {
      body: {
        getReader: () => reader,
      },
    },
    getCancelCalls: () => cancelCalls,
  };
}

export { sharedUtils, streamState, streamController, buildControllerHarness, makeSseResponse };
