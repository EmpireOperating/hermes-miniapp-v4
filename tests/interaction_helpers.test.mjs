import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const interaction = require('../static/interaction_helpers.js');

test('handleComposerSubmitShortcut submits on Enter without Shift in desktop mode', () => {
  let focusedChatId = null;
  let submitted = 0;
  let prevented = false;
  const event = {
    isComposing: false,
    key: 'Enter',
    shiftKey: false,
    preventDefault: () => {
      prevented = true;
    },
  };

  interaction.handleComposerSubmitShortcut(event, {
    mobileQuoteMode: false,
    activeChatId: '42',
    focusMessagesPaneIfActiveChat: (chatId) => {
      focusedChatId = chatId;
    },
    submitPromptWithUiError: () => {
      submitted += 1;
    },
  });

  assert.equal(prevented, true);
  assert.equal(focusedChatId, 42);
  assert.equal(submitted, 1);
});

test('handleComposerSubmitShortcut no-ops on mobile quote mode', () => {
  let submitted = 0;
  let prevented = false;
  const event = {
    isComposing: false,
    key: 'Enter',
    shiftKey: false,
    preventDefault: () => {
      prevented = true;
    },
  };

  interaction.handleComposerSubmitShortcut(event, {
    mobileQuoteMode: true,
    activeChatId: 42,
    focusMessagesPaneIfActiveChat: () => {
      throw new Error('should not focus');
    },
    submitPromptWithUiError: () => {
      submitted += 1;
    },
  });

  assert.equal(prevented, false);
  assert.equal(submitted, 0);
});

test('quoteSelectionTextForInsert prefers active mobile selection and falls back to state text', () => {
  assert.equal(
    interaction.quoteSelectionTextForInsert({
      mobileQuoteMode: true,
      activeSelectionQuote: () => ({ text: 'picked text' }),
      selectionQuoteState: { getText: () => 'state text' },
    }),
    'picked text',
  );

  assert.equal(
    interaction.quoteSelectionTextForInsert({
      mobileQuoteMode: true,
      activeSelectionQuote: () => null,
      selectionQuoteState: { getText: () => 'state text' },
    }),
    'state text',
  );
});

test('normalizeQuoteSelection unwraps legacy frame and normalizes whitespace/newlines', () => {
  const raw = [
    '╭─ Quote ─',
    '│ hello\u00a0world   ',
    '│ second line\r',
    '╰────',
  ].join('\n');

  assert.equal(interaction.unwrapLegacyQuoteBlock(raw), 'hello\u00a0world   \nsecond line\r');
  assert.equal(interaction.normalizeQuoteSelection(raw), 'hello world\nsecond line');
});

test('wrapQuoteLine hard-wraps long grapheme runs and formatQuoteBlock emits framed quote block', () => {
  const wrapped = interaction.wrapQuoteLine('abcdefghijk', 4);
  // wrapQuoteLine clamps to a minimum width of 8 for readability.
  assert.deepEqual(wrapped, ['abcdefgh', 'ijk']);

  const formatted = interaction.formatQuoteBlock('Line 1\n\nLine 2');
  assert.equal(formatted, '┌ Quote\n│ Line 1\n│\n│ Line 2\n└\n\n\n');
});

test('getQuoteWrapWidth computes bounded estimate and falls back on missing prompt', () => {
  const promptInput = { clientWidth: 420, offsetWidth: 0 };
  const width = interaction.getQuoteWrapWidth({
    promptInput,
    windowObject: { getComputedStyle: () => ({ fontSize: '16px' }) },
  });
  assert.equal(width, 40);
  assert.equal(interaction.getQuoteWrapWidth({ promptInput: null }), 46);
});

test('isCoarsePointer uses matchMedia when available and ontouchstart fallback', () => {
  assert.equal(
    interaction.isCoarsePointer({
      windowObject: { matchMedia: () => ({ matches: true }) },
    }),
    true,
  );
  assert.equal(interaction.isCoarsePointer({ windowObject: { ontouchstart: () => {} } }), true);
});

test('clearSelectionQuoteState resets state and hides quote button', () => {
  const calls = [];
  const selectionQuoteState = { reset: () => calls.push('reset') };
  const selectionQuoteButton = { hidden: false };

  interaction.clearSelectionQuoteState({ selectionQuoteState, selectionQuoteButton });
  assert.deepEqual(calls, ['reset']);
  assert.equal(selectionQuoteButton.hidden, true);
});

test('cancelSelectionQuoteTimer delegates to state cancelTimer', () => {
  const calls = [];
  interaction.cancelSelectionQuoteTimer('sync', {
    selectionQuoteState: {
      cancelTimer: (name) => calls.push(name),
    },
  });
  assert.deepEqual(calls, ['sync']);
});

test('scheduleSelectionQuoteClear clears only when selection is absent', () => {
  const callbacks = {};
  let cleared = 0;
  const selectionQuoteState = {
    scheduleTimer: (name, _delay, cb) => {
      callbacks[name] = cb;
    },
  };

  interaction.scheduleSelectionQuoteClear(
    {
      selectionQuoteState,
      activeSelectionQuoteFn: () => null,
      clearSelectionQuoteStateFn: () => {
        cleared += 1;
      },
    },
    220,
  );
  callbacks.clear();
  assert.equal(cleared, 1);

  interaction.scheduleSelectionQuoteClear(
    {
      selectionQuoteState,
      activeSelectionQuoteFn: () => ({ text: 'selected' }),
      clearSelectionQuoteStateFn: () => {
        cleared += 1;
      },
    },
    220,
  );
  callbacks.clear();
  assert.equal(cleared, 1);
});

test('scheduleSelectionQuoteSync cancels pending timers and schedules sync action', () => {
  const calls = [];
  const callbacks = {};
  interaction.scheduleSelectionQuoteSync(
    {
      selectionQuoteState: {
        scheduleTimer: (name, delay, cb) => {
          calls.push(`schedule:${name}:${delay}`);
          callbacks[name] = cb;
        },
      },
      cancelSelectionQuoteSyncFn: () => calls.push('cancel-sync'),
      cancelSelectionQuoteSettleFn: () => calls.push('cancel-settle'),
      syncSelectionQuoteActionFn: () => calls.push('sync-action'),
    },
    140,
  );

  callbacks.sync();
  assert.deepEqual(calls, ['cancel-sync', 'cancel-settle', 'schedule:sync:140', 'sync-action']);
});

test('applyQuoteIntoPrompt inserts quote block at cursor, dispatches input, and keeps caret in sync', () => {
  const dispatched = [];
  class FakeEvent {
    constructor(type, options = {}) {
      this.type = type;
      this.bubbles = Boolean(options.bubbles);
    }
  }
  const promptEl = {
    value: 'Hello world',
    maxLength: 6000,
    selectionStart: 6,
    selectionEnd: 11,
    ownerDocument: { defaultView: { Event: FakeEvent } },
    focus: () => {},
    dispatchEvent(event) {
      dispatched.push([event.type, event.bubbles]);
    },
    setSelectionRange(start, end) {
      this.selectionStart = start;
      this.selectionEnd = end;
    },
  };
  let visibleCalls = 0;
  interaction.applyQuoteIntoPrompt('quoted line', {
    promptEl,
    formatQuoteBlockFn: interaction.formatQuoteBlock,
    ensureComposerVisible: () => {
      visibleCalls += 1;
    },
  });

  assert.equal(promptEl.value.includes('┌ Quote\n│ quoted line\n└\n\n\n'), true);
  assert.equal(promptEl.selectionStart, promptEl.selectionEnd);
  assert.deepEqual(dispatched, [['input', true]]);
  assert.equal(visibleCalls, 1);
});

test('activeSelectionQuote and hasMessageSelection fall back to anchor nodes when range ancestor is a fragment', () => {
  const insideNode = {};
  const insideTextNode = { nodeType: 3, parentElement: insideNode };
  const fragmentLikeNode = { nodeType: 11, parentElement: null };
  const rect = { left: 12, top: 24, width: 80, height: 18 };
  const messagesEl = {
    contains: (node) => node === insideNode,
  };

  const selection = {
    rangeCount: 1,
    isCollapsed: false,
    anchorNode: insideTextNode,
    focusNode: insideTextNode,
    toString: () => 'quoted text',
    getRangeAt: () => ({
      commonAncestorContainer: fragmentLikeNode,
      getBoundingClientRect: () => rect,
    }),
  };

  assert.deepEqual(
    interaction.activeSelectionQuote({
      messagesEl,
      windowObject: { getSelection: () => selection },
    }),
    { text: 'quoted text', rect },
  );
  assert.equal(interaction.hasMessageSelection(selection, { messagesEl }), true);
});

test('getActiveSelection prefers window selection and falls back to document selection', () => {
  const windowSelection = { source: 'window' };
  const documentSelection = { source: 'document' };

  assert.equal(
    interaction.getActiveSelection({
      windowObject: { getSelection: () => windowSelection },
      documentObject: { getSelection: () => documentSelection },
    }),
    windowSelection,
  );

  assert.equal(
    interaction.getActiveSelection({
      windowObject: { getSelection: () => null },
      documentObject: { getSelection: () => documentSelection },
    }),
    documentSelection,
  );
});

test('hasMessageSelection only returns true when non-collapsed selection is within messages container', () => {
  const insideNode = {};
  const insideTextNode = { nodeType: 3, parentElement: insideNode };
  const outsideNode = {};
  const messagesEl = {
    contains: (node) => node === insideNode,
  };

  const validSelection = { rangeCount: 1, isCollapsed: false, anchorNode: insideNode };
  const validRangeSelection = {
    rangeCount: 1,
    isCollapsed: false,
    anchorNode: outsideNode,
    getRangeAt: () => ({ commonAncestorContainer: insideTextNode }),
  };
  const invalidSelection = { rangeCount: 1, isCollapsed: false, anchorNode: outsideNode };

  assert.equal(interaction.hasMessageSelection(validSelection, { messagesEl }), true);
  assert.equal(interaction.hasMessageSelection(validRangeSelection, { messagesEl }), true);
  assert.equal(interaction.hasMessageSelection(invalidSelection, { messagesEl }), false);
  assert.equal(interaction.hasMessageSelection(null, { messagesEl }), false);
});

test('selection quote controller schedules desktop live sync and clears when leaving messages', () => {
  const calls = [];
  let currentSelection = { rangeCount: 1, isCollapsed: false, anchorNode: {} };
  const messagesEl = {
    contains: () => true,
    addEventListener: () => {},
  };
  const promptEl = {};
  const documentObject = {
    activeElement: {},
    getSelection: () => currentSelection,
    addEventListener: () => {},
  };
  const windowObject = {
    getSelection: () => ({ ...currentSelection, removeAllRanges: () => {} }),
  };
  const controller = interaction.createSelectionQuoteController({
    mobileQuoteMode: false,
    windowObject,
    documentObject,
    promptEl,
    messagesEl,
    selectionQuoteButton: null,
    selectionQuoteState: { clearPlacement: () => calls.push('clear-placement') },
    activeSelectionQuote: () => null,
    cancelSelectionQuoteSync: () => calls.push('cancel-sync'),
    cancelSelectionQuoteSettle: () => calls.push('cancel-settle'),
    cancelSelectionQuoteClear: () => calls.push('cancel-clear'),
    scheduleSelectionQuoteSync: (delay) => calls.push(`sync:${delay}`),
    scheduleSelectionQuoteClear: (delay) => calls.push(`clear:${delay}`),
    applyQuoteIntoPrompt: () => calls.push('apply-quote'),
    clearSelectionQuoteState: () => calls.push('clear-state'),
  });

  controller.handleDocumentSelectionChange();
  assert.equal(calls.includes('sync:140'), true);

  calls.length = 0;
  messagesEl.contains = () => false;
  controller.handleDocumentSelectionChange();
  assert.deepEqual(calls, ['cancel-sync', 'clear-state']);

  calls.length = 0;
  messagesEl.contains = () => true;
  documentObject.activeElement = promptEl;
  controller.handleDocumentSelectionChange();
  assert.equal(calls.includes('sync:140'), true);

  calls.length = 0;
  messagesEl.contains = () => false;
  controller.handleDocumentSelectionChange();
  assert.deepEqual(calls, []);
});

test('selection quote controller re-syncs mobile selection changes even when touchend never arrives', () => {
  const calls = [];
  let inMessages = true;
  const messagesEl = {
    contains: () => inMessages,
    addEventListener: () => {},
  };
  const selectionQuoteButton = { hidden: false };
  const selectionQuoteState = {
    timers: { sync: null, settle: null },
    clearPlacement: () => calls.push('clear-placement'),
  };
  const documentObject = {
    activeElement: {},
    getSelection: () => ({ rangeCount: 1, isCollapsed: false, anchorNode: {} }),
    addEventListener: () => {},
  };
  const windowObject = {
    getSelection: () => null,
  };
  const controller = interaction.createSelectionQuoteController({
    mobileQuoteMode: true,
    windowObject,
    documentObject,
    promptEl: {},
    messagesEl,
    selectionQuoteButton,
    selectionQuoteState,
    activeSelectionQuote: () => null,
    cancelSelectionQuoteSync: () => calls.push('cancel-sync'),
    cancelSelectionQuoteSettle: () => calls.push('cancel-settle'),
    cancelSelectionQuoteClear: () => calls.push('cancel-clear'),
    scheduleSelectionQuoteSync: (delay) => calls.push(`sync:${delay}`),
    scheduleSelectionQuoteClear: (delay) => calls.push(`clear:${delay}`),
    applyQuoteIntoPrompt: () => calls.push('apply-quote'),
    clearSelectionQuoteState: () => calls.push('clear-state'),
  });

  controller.handleDocumentSelectionChange();

  assert.deepEqual(calls, ['cancel-clear', 'cancel-sync', 'cancel-settle', 'clear-placement', 'sync:220']);
  assert.equal(selectionQuoteButton.hidden, true);

  calls.length = 0;
  selectionQuoteState.timers.sync = 1;
  controller.handleDocumentSelectionChange();
  assert.deepEqual(calls, []);

  calls.length = 0;
  selectionQuoteState.timers.sync = null;
  inMessages = false;
  controller.handleDocumentSelectionChange();
  assert.deepEqual(calls, ['cancel-sync', 'cancel-settle', 'clear:220']);
});

test('selection quote controller uses window selection when document selection is unavailable', () => {
  const calls = [];
  const windowSelection = { rangeCount: 1, isCollapsed: false, anchorNode: {} };
  const messagesEl = {
    contains: () => true,
    addEventListener: () => {},
  };
  const selectionQuoteButton = { hidden: false };
  const controller = interaction.createSelectionQuoteController({
    mobileQuoteMode: true,
    windowObject: {
      getSelection: () => windowSelection,
    },
    documentObject: {
      activeElement: {},
      getSelection: () => null,
      addEventListener: () => {},
    },
    promptEl: {},
    messagesEl,
    selectionQuoteButton,
    selectionQuoteState: {
      timers: { sync: null, settle: null },
      clearPlacement: () => calls.push('clear-placement'),
    },
    activeSelectionQuote: () => null,
    cancelSelectionQuoteSync: () => calls.push('cancel-sync'),
    cancelSelectionQuoteSettle: () => calls.push('cancel-settle'),
    cancelSelectionQuoteClear: () => calls.push('cancel-clear'),
    scheduleSelectionQuoteSync: (delay) => calls.push(`sync:${delay}`),
    scheduleSelectionQuoteClear: (delay) => calls.push(`clear:${delay}`),
    applyQuoteIntoPrompt: () => calls.push('apply-quote'),
    clearSelectionQuoteState: () => calls.push('clear-state'),
  });

  controller.handleDocumentSelectionChange();

  assert.deepEqual(calls, ['cancel-clear', 'cancel-sync', 'cancel-settle', 'clear-placement', 'sync:220']);
  assert.equal(selectionQuoteButton.hidden, true);
});

test('selection quote controller dismisses mobile quote popup on external touchstart', () => {
  const calls = [];
  let inMessages = true;
  const messagesEl = {
    contains: () => inMessages,
    addEventListener: () => {},
  };
  const selectionQuoteButton = {
    hidden: false,
    contains: () => false,
  };
  const documentObject = {
    activeElement: {},
    getSelection: () => ({
      rangeCount: 1,
      isCollapsed: false,
      anchorNode: {},
      getRangeAt: () => ({ commonAncestorContainer: {} }),
    }),
    addEventListener: () => {},
  };
  const controller = interaction.createSelectionQuoteController({
    mobileQuoteMode: true,
    windowObject: { getSelection: () => ({ removeAllRanges: () => calls.push('remove-ranges') }) },
    documentObject,
    promptEl: {},
    messagesEl,
    selectionQuoteButton,
    selectionQuoteState: { clearPlacement: () => calls.push('clear-placement') },
    activeSelectionQuote: () => null,
    cancelSelectionQuoteSync: () => calls.push('cancel-sync'),
    cancelSelectionQuoteSettle: () => calls.push('cancel-settle'),
    cancelSelectionQuoteClear: () => calls.push('cancel-clear'),
    scheduleSelectionQuoteSync: (delay) => calls.push(`sync:${delay}`),
    scheduleSelectionQuoteClear: (delay) => calls.push(`clear:${delay}`),
    applyQuoteIntoPrompt: () => calls.push('apply-quote'),
    clearSelectionQuoteState: () => calls.push('clear-state'),
  });

  controller.handleDocumentTouchStart({ target: {} });
  assert.deepEqual(calls, []);

  inMessages = false;
  controller.handleDocumentTouchStart({ target: {} });
  assert.deepEqual(calls, ['cancel-sync', 'cancel-settle', 'cancel-clear', 'remove-ranges', 'clear-state']);
});

test('selection quote controller dismisses desktop quote popup on outside pointer down', () => {
  const calls = [];
  const messagesEl = {
    contains: () => false,
    addEventListener: () => {},
  };
  const selectionQuoteButton = {
    hidden: false,
    contains: () => false,
  };
  const controller = interaction.createSelectionQuoteController({
    mobileQuoteMode: false,
    windowObject: { getSelection: () => ({ removeAllRanges: () => calls.push('remove-ranges') }) },
    documentObject: {
      activeElement: {},
      getSelection: () => null,
      addEventListener: () => {},
    },
    promptEl: {},
    messagesEl,
    selectionQuoteButton,
    selectionQuoteState: { getText: () => 'quoted text', clearPlacement: () => calls.push('clear-placement') },
    activeSelectionQuote: () => null,
    cancelSelectionQuoteSync: () => calls.push('cancel-sync'),
    cancelSelectionQuoteSettle: () => calls.push('cancel-settle'),
    cancelSelectionQuoteClear: () => calls.push('cancel-clear'),
    scheduleSelectionQuoteSync: () => calls.push('schedule-sync'),
    scheduleSelectionQuoteClear: () => calls.push('schedule-clear'),
    applyQuoteIntoPrompt: () => calls.push('apply-quote'),
    clearSelectionQuoteState: () => calls.push('clear-state'),
  });

  controller.handleDocumentPointerDown({ target: {} });
  assert.deepEqual(calls, ['cancel-sync', 'cancel-settle', 'cancel-clear', 'remove-ranges', 'clear-state']);
});

test('selection quote controller ignores touchstart on the quote button itself', () => {
  const calls = [];
  const messagesEl = {
    contains: () => false,
    addEventListener: () => {},
  };
  const selectionQuoteButton = {
    hidden: false,
    contains: (target) => target === selectionQuoteButton,
  };
  const documentObject = {
    activeElement: {},
    getSelection: () => null,
    addEventListener: () => {},
  };
  const controller = interaction.createSelectionQuoteController({
    mobileQuoteMode: true,
    windowObject: { getSelection: () => ({ removeAllRanges: () => {} }) },
    documentObject,
    promptEl: {},
    messagesEl,
    selectionQuoteButton,
    selectionQuoteState: { clearPlacement: () => calls.push('clear-placement') },
    activeSelectionQuote: () => null,
    cancelSelectionQuoteSync: () => calls.push('cancel-sync'),
    cancelSelectionQuoteSettle: () => calls.push('cancel-settle'),
    cancelSelectionQuoteClear: () => calls.push('cancel-clear'),
    scheduleSelectionQuoteSync: (delay) => calls.push(`sync:${delay}`),
    scheduleSelectionQuoteClear: (delay) => calls.push(`clear:${delay}`),
    applyQuoteIntoPrompt: () => calls.push('apply-quote'),
    clearSelectionQuoteState: () => calls.push('clear-state'),
  });

  controller.handleDocumentTouchStart({ target: selectionQuoteButton });
  assert.deepEqual(calls, []);
});

test('selection quote button touchstart applies quote immediately in mobile mode when click is swallowed', () => {
  const calls = [];
  const listeners = new Map();
  const selectionQuoteButton = {
    hidden: false,
    addEventListener(type, handler) {
      listeners.set(type, handler);
    },
  };
  const messagesEl = {
    contains: () => false,
    addEventListener: () => {},
  };
  const controller = interaction.createSelectionQuoteController({
    mobileQuoteMode: true,
    windowObject: { getSelection: () => ({ removeAllRanges: () => calls.push('remove-ranges') }) },
    documentObject: {
      activeElement: {},
      getSelection: () => null,
      addEventListener: () => {},
    },
    promptEl: {},
    messagesEl,
    selectionQuoteButton,
    selectionQuoteState: { getText: () => 'quoted text', clearPlacement: () => calls.push('clear-placement') },
    activeSelectionQuote: () => null,
    cancelSelectionQuoteSync: () => calls.push('cancel-sync'),
    cancelSelectionQuoteSettle: () => calls.push('cancel-settle'),
    cancelSelectionQuoteClear: () => calls.push('cancel-clear'),
    scheduleSelectionQuoteSync: () => calls.push('schedule-sync'),
    scheduleSelectionQuoteClear: () => calls.push('schedule-clear'),
    applyQuoteIntoPrompt: (text) => calls.push(`apply:${text}`),
    clearSelectionQuoteState: () => calls.push('clear-state'),
  });

  controller.bind();

  let prevented = false;
  listeners.get('touchstart')?.({
    preventDefault() {
      prevented = true;
    },
  });

  assert.equal(prevented, true);
  assert.deepEqual(calls, ['apply:quoted text', 'cancel-sync', 'cancel-settle', 'cancel-clear', 'remove-ranges', 'clear-state']);
});

test('syncSelectionQuoteAction accepts minor mobile selection rect jitter and still shows quote button', () => {
  const callbacks = {};
  const calls = [];
  const picks = [
    { text: 'quoted text', rect: { left: 40, top: 160, width: 92, height: 24 } },
    { text: 'quoted text', rect: { left: 43, top: 164, width: 90, height: 26 } },
  ];
  let pickIndex = 0;
  const selectionQuoteButton = { hidden: true };
  const selectionQuoteState = {
    placementKey: '',
    scheduleTimer(name, _delay, callback) {
      callbacks[name] = callback;
    },
    setText(text) {
      calls.push(`set-text:${text}`);
    },
    setPlacement(key) {
      this.placementKey = key;
      calls.push(`set-placement:${key}`);
    },
    getText() {
      return 'quoted text';
    },
  };

  interaction.syncSelectionQuoteAction({
    activeSelectionQuoteFn: () => picks[Math.min(pickIndex++, picks.length - 1)],
    clearSelectionQuoteState: () => calls.push('clear-state'),
    cancelSelectionQuoteClear: () => calls.push('cancel-clear'),
    mobileQuoteMode: true,
    showSelectionQuoteActionFn: (pick, options = {}) => {
      calls.push(`show:${pick.rect.left},${pick.rect.top}:${options.lockPlacement ? 'lock' : 'free'}`);
    },
    selectionQuoteButton,
    selectionQuoteState,
    cancelSelectionQuoteSettle: () => calls.push('cancel-settle'),
    scheduleSelectionQuoteClear: (delay) => calls.push(`clear:${delay}`),
    scheduleSelectionQuoteSync: (delay) => calls.push(`sync:${delay}`),
  });

  callbacks.settle();

  assert.deepEqual(calls, [
    'cancel-clear',
    'cancel-settle',
    'show:43,164:lock',
  ]);
});

test('interaction controller resolves active chat lazily for composer submit', () => {
  const calls = [];
  let activeChatId = 7;
  const controller = interaction.createController({
    mobileQuoteMode: false,
    getActiveChatId: () => activeChatId,
    focusMessagesPaneIfActiveChat: (chatId) => calls.push(`focus:${chatId}`),
    submitPromptWithUiError: () => calls.push('submit'),
  });
  const event = {
    isComposing: false,
    key: 'Enter',
    shiftKey: false,
    preventDefault: () => calls.push('prevent'),
  };

  controller.handleComposerSubmitShortcut(event);
  activeChatId = 12;
  controller.handleComposerSubmitShortcut(event);

  assert.deepEqual(calls, ['prevent', 'focus:7', 'submit', 'prevent', 'focus:12', 'submit']);
});

test('selection quote controller accepts pointer event fallbacks for touch-style selections', () => {
  const calls = [];
  const listeners = new Map();
  const messagesEl = {
    contains: () => true,
    addEventListener(type, handler) {
      listeners.set(type, handler);
    },
  };
  const documentObject = {
    activeElement: {},
    getSelection: () => ({ rangeCount: 1, isCollapsed: false, anchorNode: {} }),
    addEventListener: () => {},
  };
  const controller = interaction.createSelectionQuoteController({
    mobileQuoteMode: true,
    windowObject: { getSelection: () => ({ removeAllRanges: () => {} }) },
    documentObject,
    promptEl: {},
    messagesEl,
    selectionQuoteButton: { hidden: true, addEventListener: () => {} },
    selectionQuoteState: { clearPlacement: () => calls.push('clear-placement') },
    activeSelectionQuote: () => null,
    cancelSelectionQuoteSync: () => calls.push('cancel-sync'),
    cancelSelectionQuoteSettle: () => calls.push('cancel-settle'),
    cancelSelectionQuoteClear: () => calls.push('cancel-clear'),
    scheduleSelectionQuoteSync: (delay) => calls.push(`sync:${delay}`),
    scheduleSelectionQuoteClear: (delay) => calls.push(`clear:${delay}`),
    applyQuoteIntoPrompt: () => calls.push('apply-quote'),
    clearSelectionQuoteState: () => calls.push('clear-state'),
  });

  controller.bind();
  listeners.get('pointerdown')?.({ pointerType: 'touch' });
  listeners.get('pointerup')?.({ pointerType: 'touch' });
  listeners.get('pointercancel')?.({ pointerType: 'touch' });

  assert.deepEqual(calls, [
    'cancel-sync',
    'cancel-settle',
    'cancel-clear',
    'clear-placement',
    'cancel-clear',
    'sync:220',
    'cancel-sync',
    'cancel-settle',
    'clear:220',
  ]);
});

test('interaction controller binds selection quote handlers once and reuses controller instance', () => {
  const messageListeners = [];
  const documentListeners = [];
  const buttonListeners = [];
  const messagesEl = {
    addEventListener: (type, handler) => messageListeners.push([type, handler]),
    contains: () => false,
  };
  const documentObject = {
    addEventListener: (type, handler) => documentListeners.push([type, handler]),
    getSelection: () => null,
    activeElement: null,
  };
  const selectionQuoteButton = {
    addEventListener: (type, handler) => buttonListeners.push([type, handler]),
  };
  const selectionQuoteState = {
    clearPlacement() {},
    getText: () => '',
  };
  const controller = interaction.createController({
    mobileQuoteMode: false,
    windowObject: { getSelection: () => ({ removeAllRanges: () => {} }) },
    documentObject,
    promptEl: {},
    messagesEl,
    selectionQuoteButton,
    selectionQuoteState,
    activeSelectionQuote: () => null,
    cancelSelectionQuoteSync: () => {},
    cancelSelectionQuoteSettle: () => {},
    cancelSelectionQuoteClear: () => {},
    scheduleSelectionQuoteSync: () => {},
    scheduleSelectionQuoteClear: () => {},
    applyQuoteIntoPrompt: () => {},
    clearSelectionQuoteState: () => {},
  });

  const first = controller.bindSelectionQuoteBindings();
  const second = controller.bindSelectionQuoteBindings();

  assert.equal(first, second);
  assert.deepEqual(buttonListeners.map(([type]) => type), ['click', 'touchstart']);
  assert.deepEqual(messageListeners.map(([type]) => type), ['mouseup', 'touchstart', 'touchend', 'touchcancel', 'pointerdown', 'pointerup', 'pointercancel']);
  assert.deepEqual(documentListeners.map(([type]) => type), ['selectionchange', 'mousedown', 'touchstart']);
});
