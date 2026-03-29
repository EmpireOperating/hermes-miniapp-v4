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

test('applyQuoteIntoPrompt inserts quote block at cursor and keeps caret in sync', () => {
  const promptEl = {
    value: 'Hello world',
    maxLength: 6000,
    selectionStart: 6,
    selectionEnd: 11,
    focus: () => {},
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
  assert.equal(visibleCalls, 1);
});

test('hasMessageSelection only returns true when non-collapsed selection is within messages container', () => {
  const insideNode = {};
  const messagesEl = {
    contains: (node) => node === insideNode,
  };

  const validSelection = { rangeCount: 1, isCollapsed: false, anchorNode: insideNode };
  const invalidSelection = { rangeCount: 1, isCollapsed: false, anchorNode: {} };

  assert.equal(interaction.hasMessageSelection(validSelection, { messagesEl }), true);
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
  const controller = interaction.createSelectionQuoteController({
    mobileQuoteMode: false,
    windowObject: { getSelection: () => ({ removeAllRanges: () => {} }) },
    documentObject: {
      activeElement: {},
      getSelection: () => currentSelection,
      addEventListener: () => {},
    },
    promptEl: {},
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
});
