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
