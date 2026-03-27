import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const composerState = require('../static/composer_state_helpers.js');

test('deriveComposerState computes send/remove/pin states from auth + pending + active chat', () => {
  const chats = new Map([[4, { id: 4, pending: false }]]);
  const pendingChats = new Set();

  const ready = composerState.deriveComposerState({
    activeChatId: 4,
    pendingChats,
    chats,
    isAuthenticated: true,
  });
  assert.equal(ready.canSend, true);
  assert.equal(ready.sendLabel, 'Send');
  assert.equal(ready.canRemove, true);
  assert.equal(ready.canPin, true);

  pendingChats.add(4);
  const pending = composerState.deriveComposerState({
    activeChatId: 4,
    pendingChats,
    chats,
    isAuthenticated: true,
  });
  assert.equal(pending.canSend, false);
  assert.equal(pending.sendLabel, 'Sending…');
  assert.equal(pending.canRemove, false);
  assert.equal(pending.canPin, false);

  const unauth = composerState.deriveComposerState({
    activeChatId: 4,
    pendingChats: new Set(),
    chats,
    isAuthenticated: false,
  });
  assert.equal(unauth.canPrompt, false);
  assert.equal(unauth.canSend, false);
});

test('applyComposerState mutates controls with safe optional buttons', () => {
  const sendButton = { disabled: false, textContent: '' };
  const promptEl = { disabled: false };
  const removeChatButton = { disabled: false };
  const pinChatButton = { disabled: false };

  composerState.applyComposerState({
    state: {
      canSend: false,
      sendLabel: 'Sending…',
      canPrompt: true,
      canRemove: false,
      canPin: true,
    },
    sendButton,
    promptEl,
    removeChatButton,
    pinChatButton,
  });

  assert.equal(sendButton.disabled, true);
  assert.equal(sendButton.textContent, 'Sending…');
  assert.equal(promptEl.disabled, false);
  assert.equal(removeChatButton.disabled, true);
  assert.equal(pinChatButton.disabled, false);
});
