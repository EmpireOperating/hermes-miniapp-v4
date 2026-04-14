import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const runtimeLocalMutation = require('../static/runtime_local_mutation.js');
const transcriptAuthority = require('../static/runtime_transcript_authority.js');

function buildHarness(overrides = {}) {
  const histories = new Map();
  let activeChatId = 7;
  const renderedMessages = [];
  const persistedSnapshots = [];
  const clearedSnapshots = [];
  const messagesEl = {
    appendedNodes: [],
    appendChild(node) {
      this.appendedNodes.push(node);
      return node;
    },
  };
  const roleNode = { textContent: '' };
  const timeNode = { textContent: '' };
  const bodyNode = {};
  const template = {
    content: {
      firstElementChild: {
        cloneNode() {
          return {
            classList: { add() {} },
            querySelector(selector) {
              if (selector === '.message__role') return roleNode;
              if (selector === '.message__time') return timeNode;
              if (selector === '.message__body') return bodyNode;
              return null;
            },
          };
        },
      },
    },
  };
  const controller = runtimeLocalMutation.createLocalMutationController({
    histories,
    getActiveChatId: () => activeChatId,
    messagesEl,
    template,
    nowStamp: () => '10:45',
    renderBody: (_container, text) => { bodyNode.textContent = String(text); },
    renderMessages: (chatId, options = {}) => renderedMessages.push({ chatId: Number(chatId), options }),
    persistPendingStreamSnapshot: (chatId) => persistedSnapshots.push(Number(chatId)),
    clearPendingStreamSnapshot: (chatId) => clearedSnapshots.push(Number(chatId)),
    enqueueUiMutation: (callback) => callback(),
    isActiveChat: (chatId) => Number(chatId) === Number(activeChatId),
    normalizeChatId: (chatId) => Number(chatId),
    reconcilePendingAssistantUpdate: transcriptAuthority.reconcilePendingAssistantUpdate,
    ...overrides,
  });
  return {
    controller,
    histories,
    renderedMessages,
    persistedSnapshots,
    clearedSnapshots,
    messagesEl,
    roleNode,
    timeNode,
    bodyNode,
    setActiveChatId: (value) => { activeChatId = Number(value); },
  };
}

test('runtime_local_mutation updates pending assistant history and snapshot ownership', () => {
  const harness = buildHarness();

  harness.controller.addLocalMessage(7, { role: 'user', body: 'hello' });
  harness.controller.updatePendingAssistant(7, 'streaming', true);
  harness.controller.updatePendingAssistant(7, 'done', false);

  const history = harness.histories.get(7) || [];
  assert.equal(history.length, 2);
  assert.equal(history[1].role, 'hermes');
  assert.equal(history[1].body, 'done');
  assert.equal(history[1].pending, false);
  assert.deepEqual(harness.persistedSnapshots, [7, 7]);
  assert.deepEqual(harness.clearedSnapshots, [7]);
});

test('runtime_local_mutation appends inline system card when no active chat is selected', () => {
  const harness = buildHarness();
  harness.setActiveChatId(0);

  harness.controller.appendSystemMessage('Waiting for sign-in');

  assert.equal(harness.messagesEl.appendedNodes.length, 1);
  assert.equal(harness.roleNode.textContent, 'system');
  assert.equal(harness.timeNode.textContent, '10:45');
  assert.equal(harness.bodyNode.textContent, 'Waiting for sign-in');
});

test('runtime_local_mutation only schedules rerender for the active chat', () => {
  const harness = buildHarness();

  harness.controller.syncActiveMessageView(8, { preserveViewport: true });
  harness.controller.syncActiveMessageView(7, { preserveViewport: true });
  harness.controller.scheduleActiveMessageView(8);
  harness.controller.scheduleActiveMessageView(7);

  assert.deepEqual(harness.renderedMessages, [
    { chatId: 7, options: { preserveViewport: true } },
    { chatId: 7, options: { preserveViewport: true } },
  ]);
});
