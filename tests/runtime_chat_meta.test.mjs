import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const runtimeChatMeta = require('../static/runtime_chat_meta.js');

function buildHarness() {
  const chatScrollTop = new Map();
  const chatStickToBottom = new Map();
  const chats = new Map([
    [3, { id: 3, title: 'Current chat' }],
    [7, { id: 7, title: 'Target chat' }],
  ]);
  let activeChatId = 3;
  let renderedChatId = 3;
  const promptEl = { value: 'draft text' };
  const activeChatName = { textContent: '' };
  const panelTitle = { textContent: '' };
  const historyCount = { textContent: '' };
  const messagesEl = {
    scrollTop: 42,
    innerHTML: '<existing />',
    appendChild(node) {
      this.lastAppendedNode = node;
    },
  };
  const roleNode = { textContent: '' };
  const timeNode = { textContent: '' };
  const bodyNode = {};
  const cloneNode = {
    classList: { add() {} },
    querySelector(selector) {
      if (selector === '.message__role') return roleNode;
      if (selector === '.message__time') return timeNode;
      if (selector === '.message__body') return bodyNode;
      return null;
    },
  };
  const template = {
    content: {
      firstElementChild: {
        cloneNode() {
          return cloneNode;
        },
      },
    },
  };
  const calls = {
    setDraft: [],
    renderBody: [],
    syncLiveToolStreamForChat: [],
    syncActiveTabSelection: [],
    scheduleTimeout: [],
    renderTabs: 0,
    updateComposerState: 0,
    syncPinChatButton: 0,
    syncActivePendingStatus: 0,
    syncActiveLatencyChip: 0,
    updateJumpLatestVisibility: 0,
  };
  const controller = runtimeChatMeta.createMetaController({
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
    isNearBottomFn: () => true,
    setDraft: (chatId, value) => calls.setDraft.push({ chatId: Number(chatId), value }),
    promptEl,
    activeChatName,
    panelTitle,
    template,
    nowStamp: () => '10:30',
    renderBody: (_container, text) => calls.renderBody.push(String(text)),
    historyCount,
    updateComposerState: () => { calls.updateComposerState += 1; },
    syncPinChatButton: () => { calls.syncPinChatButton += 1; },
    renderTabs: () => { calls.renderTabs += 1; },
    syncActiveTabSelection: (previousChatId, nextChatId) => calls.syncActiveTabSelection.push({ previousChatId, nextChatId }),
    syncLiveToolStreamForChat: (chatId) => calls.syncLiveToolStreamForChat.push(chatId == null ? null : Number(chatId)),
    syncActivePendingStatus: () => { calls.syncActivePendingStatus += 1; },
    syncActiveLatencyChip: () => { calls.syncActiveLatencyChip += 1; },
    updateJumpLatestVisibility: () => { calls.updateJumpLatestVisibility += 1; },
    getDraft: (chatId) => (Number(chatId) === 7 ? 'saved draft' : ''),
    chats,
    scheduleTimeout: (callback, delay) => calls.scheduleTimeout.push({ callback, delay }),
  });
  return {
    controller,
    calls,
    chatScrollTop,
    chatStickToBottom,
    promptEl,
    activeChatName,
    panelTitle,
    historyCount,
    messagesEl,
    getActiveChatId: () => activeChatId,
    getRenderedChatId: () => renderedChatId,
  };
}

test('runtime_chat_meta defers non-critical active-chat updates and preserves prior draft/scroll state', () => {
  const harness = buildHarness();

  harness.controller.setActiveChatMeta(7, { fullTabRender: false, deferNonCritical: true });

  assert.deepEqual(harness.calls.setDraft, [{ chatId: 3, value: 'draft text' }]);
  assert.equal(harness.chatScrollTop.get(3), 42);
  assert.equal(harness.chatStickToBottom.get(3), true);
  assert.equal(harness.getActiveChatId(), 7);
  assert.equal(harness.promptEl.value, 'saved draft');
  assert.equal(harness.activeChatName.textContent, 'Target chat');
  assert.equal(harness.panelTitle.textContent, 'Conversation · Target chat');
  assert.equal(harness.calls.renderTabs, 0);
  assert.deepEqual(harness.calls.syncActiveTabSelection, [{ previousChatId: 3, nextChatId: 7 }]);
  assert.equal(harness.calls.scheduleTimeout.length, 1);

  harness.calls.scheduleTimeout[0].callback();
  assert.deepEqual(harness.calls.syncLiveToolStreamForChat, [7]);
  assert.equal(harness.calls.updateJumpLatestVisibility, 1);
});

test('runtime_chat_meta setNoActiveChatMeta clears active state and renders empty-chat system card', () => {
  const harness = buildHarness();

  harness.controller.setNoActiveChatMeta();

  assert.equal(harness.getActiveChatId(), null);
  assert.equal(harness.getRenderedChatId(), null);
  assert.equal(harness.promptEl.value, '');
  assert.equal(harness.activeChatName.textContent, 'None');
  assert.equal(harness.panelTitle.textContent, 'Conversation');
  assert.equal(harness.messagesEl.innerHTML, '');
  assert.equal(harness.historyCount.textContent, '0');
  assert.deepEqual(harness.calls.renderBody, ['No chats open. Start a new chat to continue.']);
  assert.deepEqual(harness.calls.syncLiveToolStreamForChat, [null]);
});
