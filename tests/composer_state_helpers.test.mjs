import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const composerStateHelpers = require('../static/composer_state_helpers.js');

test('deriveComposerState reflects pending/auth combinations', () => {
  const pendingState = composerStateHelpers.deriveComposerState({
    activeChatId: 3,
    pendingChats: new Set([3]),
    chats: new Map([[3, { pending: false }]]),
    isAuthenticated: true,
  });

  assert.equal(pendingState.pending, true);
  assert.equal(pendingState.canSend, false);
  assert.equal(pendingState.sendLabel, 'Sending…');

  const idleState = composerStateHelpers.deriveComposerState({
    activeChatId: 3,
    pendingChats: new Set(),
    chats: new Map([[3, { pending: false }]]),
    isAuthenticated: true,
  });
  assert.equal(idleState.pending, false);
  assert.equal(idleState.canSend, true);
  assert.equal(idleState.sendLabel, 'Send');
});

test('applyComposerState updates control disabled flags and button labels', () => {
  const sendButton = { disabled: false, textContent: '' };
  const promptEl = { disabled: false };
  const removeChatButton = { disabled: false };
  const pinChatButton = { disabled: false };

  composerStateHelpers.applyComposerState({
    state: {
      canSend: false,
      sendLabel: 'Sending…',
      canPrompt: true,
      canRemove: false,
      canPin: false,
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
  assert.equal(pinChatButton.disabled, true);
});

test('createController updateComposerState derives and applies control state', () => {
  const pendingChats = new Set([5]);
  const chats = new Map([[5, { pending: false }]]);
  const sendButton = { disabled: false, textContent: '' };
  const promptEl = { disabled: false };
  const removeChatButton = { disabled: false };
  const pinChatButton = { disabled: false };

  const controller = composerStateHelpers.createController({
    getActiveChatId: () => 5,
    pendingChats,
    chats,
    getIsAuthenticated: () => true,
    sendButton,
    promptEl,
    removeChatButton,
    pinChatButton,
  });

  const state = controller.updateComposerState();

  assert.equal(state.pending, true);
  assert.equal(state.canSend, false);
  assert.equal(sendButton.disabled, true);
  assert.equal(sendButton.textContent, 'Sending…');
  assert.equal(promptEl.disabled, false);
  assert.equal(removeChatButton.disabled, true);
  assert.equal(pinChatButton.disabled, true);
});

test('draft controller loads valid values and ignores malformed storage payloads', () => {
  const draftByChat = new Map();
  const localStorageRef = {
    getItem() {
      return JSON.stringify({
        4: 'hello',
        nope: 'skip',
        8: '',
      });
    },
    setItem() {
      throw new Error('not expected');
    },
  };

  const drafts = composerStateHelpers.createDraftController({
    localStorageRef,
    draftStorageKey: 'miniapp.drafts',
    draftByChat,
  });

  drafts.loadDraftsFromStorage();

  assert.equal(draftByChat.size, 1);
  assert.equal(draftByChat.get(4), 'hello');
  assert.equal(drafts.getDraft(4), 'hello');
  assert.equal(drafts.getDraft(999), '');
});

test('draft controller setDraft persists add/remove operations', () => {
  const writes = [];
  const draftByChat = new Map();
  const localStorageRef = {
    getItem() {
      return null;
    },
    setItem(key, value) {
      writes.push([key, value]);
    },
  };

  const drafts = composerStateHelpers.createDraftController({
    localStorageRef,
    draftStorageKey: 'miniapp.drafts',
    draftByChat,
  });

  drafts.setDraft(6, 'draft text');
  drafts.setDraft(6, '');

  assert.equal(writes.length, 2);
  assert.deepEqual(writes[0], ['miniapp.drafts', JSON.stringify({ 6: 'draft text' })]);
  assert.deepEqual(writes[1], ['miniapp.drafts', JSON.stringify({})]);
  assert.equal(drafts.getDraft(6), '');
});
