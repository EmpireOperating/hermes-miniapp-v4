import { test, assert, runtime } from './frontend_runtime_test_harness.mjs';

test('getNextChatTabId cycles forward with wrap-around', () => {
  assert.equal(
    runtime.getNextChatTabId({ orderedChatIds: [3, 7, 10], activeChatId: 7, reverse: false }),
    10,
  );

  assert.equal(
    runtime.getNextChatTabId({ orderedChatIds: [3, 7, 10], activeChatId: 10, reverse: false }),
    3,
  );
});


test('getNextChatTabId cycles backward with wrap-around', () => {
  assert.equal(
    runtime.getNextChatTabId({ orderedChatIds: [3, 7, 10], activeChatId: 7, reverse: true }),
    3,
  );

  assert.equal(
    runtime.getNextChatTabId({ orderedChatIds: [3, 7, 10], activeChatId: 3, reverse: true }),
    10,
  );
});


test('getNextChatTabId returns null for invalid or singleton tab lists', () => {
  assert.equal(
    runtime.getNextChatTabId({ orderedChatIds: [7], activeChatId: 7, reverse: false }),
    null,
  );

  assert.equal(
    runtime.getNextChatTabId({ orderedChatIds: [], activeChatId: 7, reverse: false }),
    null,
  );

  assert.equal(
    runtime.getNextChatTabId({ orderedChatIds: [3, 7, 10], activeChatId: 999, reverse: false }),
    null,
  );
});
