import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const appJsUrl = new URL('../static/app.js', import.meta.url);

function extractFunctionBody(source, functionName) {
  const fnPattern = new RegExp(
    String.raw`(?:async\s+)?function\s+${functionName}\s*\([^)]*\)\s*\{([\s\S]*?)\n\}`,
    'm',
  );
  const match = source.match(fnPattern);
  assert.ok(match, `${functionName} wrapper should exist in app.js`);
  return match[1] || '';
}

test('app.js chat-history wrappers keep delegating to chatHistoryController', async () => {
  const source = await readFile(appJsUrl, 'utf8');

  const delegateExpectations = [
    ['historiesDiffer', 'chatHistoryController.historiesDiffer(currentHistory, incomingHistory)'],
    ['hydrateChatFromServer', 'chatHistoryController.hydrateChatFromServer(targetChatId, requestId, hadCachedHistory)'],
    ['openChat', 'chatHistoryController.openChat(chatId)'],
    ['markRead', 'chatHistoryController.markRead(chatId)'],
    ['maybeMarkRead', 'chatHistoryController.maybeMarkRead(chatId, options)'],
    ['loadChatHistory', 'chatHistoryController.loadChatHistory(chatId, options)'],
    ['prefetchChatHistory', 'chatHistoryController.prefetchChatHistory(chatId)'],
    ['warmChatHistoryCache', 'chatHistoryController.warmChatHistoryCache()'],
    ['addLocalMessage', 'chatHistoryController.addLocalMessage(chatId, message)'],
    ['updatePendingAssistant', 'chatHistoryController.updatePendingAssistant(chatId, nextBody, pendingState)'],
    ['syncActiveMessageView', 'chatHistoryController.syncActiveMessageView(chatId, options)'],
    ['scheduleActiveMessageView', 'chatHistoryController.scheduleActiveMessageView(chatId)'],
    ['refreshChats', 'chatHistoryController.refreshChats()'],
    ['syncVisibleActiveChat', 'chatHistoryController.syncVisibleActiveChat(options)'],
  ];

  for (const [fnName, delegatedCall] of delegateExpectations) {
    const body = extractFunctionBody(source, fnName);
    assert.match(body, new RegExp(delegatedCall.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
      `${fnName} should delegate to controller`);
  }
});
