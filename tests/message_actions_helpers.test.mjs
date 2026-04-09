import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const actions = require('../static/message_actions_helpers.js');

function makeClassList() {
  const values = new Set();
  return {
    add: (...tokens) => tokens.forEach((token) => values.add(token)),
    remove: (...tokens) => tokens.forEach((token) => values.delete(token)),
    has: (token) => values.has(token),
  };
}

test('createMessageCopyState enforces duplicate-click throttling', () => {
  const state = actions.createMessageCopyState({ minHandledIntervalMs: 500 });
  const button = {};

  assert.equal(state.wasHandledRecently(button, 1000), false);
  state.markHandled(button, 1000);
  assert.equal(state.wasHandledRecently(button, 1200), true);
  assert.equal(state.wasHandledRecently(button, 1700), false);
});

test('copyTextFromMessageButton normalizes message body text via callback', () => {
  const bodyNode = { innerText: '  hello\nworld  ' };
  const messageNode = {
    querySelector: (selector) => (selector === '.message__body' ? bodyNode : null),
  };
  const copyButton = {
    closest: (selector) => (selector === '.message' ? messageNode : null),
  };

  const text = actions.copyTextFromMessageButton(copyButton, {
    normalizeText: (raw) => String(raw).trim().toUpperCase(),
  });

  assert.equal(text, 'HELLO\nWORLD');
});

test('set/reset copy button feedback updates icon and metadata', () => {
  const button = {
    classList: makeClassList(),
    textContent: '',
    title: '',
    ariaLabel: '',
    setAttribute(name, value) {
      if (name === 'aria-label') {
        this.ariaLabel = value;
      }
    },
  };

  actions.setCopyButtonFeedback(button, true);
  assert.equal(button.textContent, '✓');
  assert.equal(button.ariaLabel, 'Copied');
  assert.equal(button.title, 'Copied');
  assert.equal(button.classList.has('is-copied'), true);

  actions.resetCopyButtonFeedback(button);
  assert.equal(button.textContent, '⧉');
  assert.equal(button.ariaLabel, 'Copy message');
  assert.equal(button.title, 'Copy message');
  assert.equal(button.classList.has('is-copied'), false);
  assert.equal(button.classList.has('is-error'), false);
});

test('createController reuses one copy state and binds at most once', () => {
  const messagesEl = {
    addEventListenerCalls: [],
    removeEventListenerCalls: [],
    addEventListener(eventName, handler) {
      this.addEventListenerCalls.push([eventName, handler]);
    },
    removeEventListener(eventName, handler) {
      this.removeEventListenerCalls.push([eventName, handler]);
    },
  };

  const controller = actions.createController({
    messagesEl,
    normalizeText: (value) => value,
    copyTextToClipboard: async () => true,
  });

  const firstUnbind = controller.bindMessageCopyBindings();
  const secondUnbind = controller.bindMessageCopyBindings();

  assert.equal(typeof firstUnbind, 'function');
  assert.equal(secondUnbind, firstUnbind);
  assert.equal(messagesEl.addEventListenerCalls.length, 1);
  assert.equal(messagesEl.addEventListenerCalls[0][0], 'click');
  assert.ok(controller.messageCopyState);

  firstUnbind();
  assert.equal(messagesEl.removeEventListenerCalls.length, 1);
  assert.equal(messagesEl.removeEventListenerCalls[0][0], 'click');
});
