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
  assert.equal(pendingState.canSend, true);
  assert.equal(pendingState.canPin, true);
  assert.equal(pendingState.sendLabel, 'Interrupt & send');

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
      canSend: true,
      sendLabel: 'Interrupt & send',
      canPrompt: true,
      canRemove: false,
      canPin: false,
    },
    sendButton,
    promptEl,
    removeChatButton,
    pinChatButton,
  });

  assert.equal(sendButton.disabled, false);
  assert.equal(sendButton.textContent, 'Interrupt & send');
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
  assert.equal(state.canSend, true);
  assert.equal(state.canPin, true);
  assert.equal(sendButton.disabled, false);
  assert.equal(sendButton.textContent, 'Interrupt & send');
  assert.equal(promptEl.disabled, false);
  assert.equal(removeChatButton.disabled, true);
  assert.equal(pinChatButton.disabled, false);
});

test('draft controller loads valid values and ignores malformed storage payloads', () => {
  const draftByChat = new Map();
  const localStorageRef = {
    getItem() {
      return JSON.stringify({
        4: { value: 'hello', ts: 40 },
        nope: 'skip',
        8: { value: '', ts: 80 },
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
  assert.equal(drafts.getDraft(8), '');
  assert.equal(drafts.getDraft(999), '');
});

test('draft controller setDraft persists timestamped add/remove operations', () => {
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
    nowMs: () => 1_000,
  });

  drafts.setDraft(6, 'draft text');
  drafts.setDraft(6, '');

  assert.equal(writes.length, 2);
  assert.deepEqual(writes[0], ['miniapp.drafts', JSON.stringify({ 6: { value: 'draft text', ts: 1000 } })]);
  assert.deepEqual(writes[1], ['miniapp.drafts', JSON.stringify({ 6: { value: '', ts: 1000 } })]);
  assert.equal(drafts.getDraft(6), '');
});

test('draft controller preserves newer drafts from another instance when persisting local changes', () => {
  const storage = new Map();
  storage.set('miniapp.drafts', JSON.stringify({
    4: { value: 'remote newer', ts: 50 },
    9: { value: 'remote only', ts: 60 },
  }));
  const localStorageRef = {
    getItem(key) {
      return storage.get(key) || null;
    },
    setItem(key, value) {
      storage.set(key, String(value));
    },
  };
  const draftByChat = new Map();
  const drafts = composerStateHelpers.createDraftController({
    localStorageRef,
    draftStorageKey: 'miniapp.drafts',
    draftByChat,
    nowMs: () => 40,
  });

  drafts.loadDraftsFromStorage();
  drafts.setDraft(7, 'local draft');

  assert.equal(drafts.getDraft(4), 'remote newer');
  assert.equal(drafts.getDraft(7), 'local draft');
  assert.equal(drafts.getDraft(9), 'remote only');
  assert.deepEqual(JSON.parse(storage.get('miniapp.drafts')), {
    4: { value: 'remote newer', ts: 50 },
    7: { value: 'local draft', ts: 40 },
    9: { value: 'remote only', ts: 60 },
  });
});
