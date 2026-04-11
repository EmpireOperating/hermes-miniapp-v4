import test from 'node:test';
import assert from 'node:assert/strict';
import { buildMetaHarness } from './chat_history_test_harness.mjs';

test('createMetaController defers non-critical active-chat updates and preserves prior draft/scroll state', () => {
  const harness = buildMetaHarness();

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
  assert.equal(harness.calls.syncLiveToolStreamForChat.length, 0);
  assert.equal(harness.calls.syncActivePendingStatus, 1);
  assert.equal(harness.calls.syncActiveLatencyChip, 1);
  assert.equal(harness.calls.updateJumpLatestVisibility, 0);

  harness.calls.scheduleTimeout[0].callback();
  assert.deepEqual(harness.calls.syncLiveToolStreamForChat, [7]);
  assert.equal(harness.calls.syncActivePendingStatus, 1);
  assert.equal(harness.calls.syncActiveLatencyChip, 1);
  assert.equal(harness.calls.updateJumpLatestVisibility, 1);
});

test('createMetaController ignores stale deferred finalize callbacks after a newer tab switch', () => {
  const harness = buildMetaHarness();

  harness.controller.setActiveChatMeta(7, { fullTabRender: false, deferNonCritical: true });
  harness.controller.setActiveChatMeta(3, { fullTabRender: false, deferNonCritical: false });

  assert.equal(harness.calls.scheduleTimeout.length, 1);
  assert.deepEqual(harness.calls.syncLiveToolStreamForChat, [3]);
  assert.equal(harness.calls.updateJumpLatestVisibility, 1);

  harness.calls.scheduleTimeout[0].callback();

  assert.deepEqual(harness.calls.syncLiveToolStreamForChat, [3]);
  assert.equal(harness.calls.updateJumpLatestVisibility, 1);
});

test('createMetaController skips stale deferred non-critical updates after a later tab switch', () => {
  const harness = buildMetaHarness();

  harness.controller.setActiveChatMeta(7, { fullTabRender: false, deferNonCritical: true });
  harness.controller.setActiveChatMeta(8, { fullTabRender: false, deferNonCritical: true });

  assert.equal(harness.calls.scheduleTimeout.length, 2);
  assert.equal(harness.getActiveChatId(), 8);

  harness.calls.scheduleTimeout[0].callback();
  assert.deepEqual(harness.calls.syncLiveToolStreamForChat, []);
  assert.equal(harness.calls.updateJumpLatestVisibility, 0);

  harness.calls.scheduleTimeout[1].callback();
  assert.deepEqual(harness.calls.syncLiveToolStreamForChat, [8]);
  assert.equal(harness.calls.updateJumpLatestVisibility, 1);
});

test('createMetaController setNoActiveChatMeta clears active state and renders empty-chat system card', () => {
  const harness = buildMetaHarness();

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
  assert.equal(harness.calls.renderTabs, 1);
  assert.equal(harness.calls.updateComposerState, 1);
});

