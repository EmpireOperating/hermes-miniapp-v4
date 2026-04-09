import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const appJsUrl = new URL('../static/app.js', import.meta.url);

function extractFunctionBody(source, functionName) {
  const fnPattern = new RegExp(
    String.raw`function\s+${functionName}\s*\([^)]*\)\s*\{([\s\S]*?)\n\}`,
    'm',
  );
  const match = source.match(fnPattern);
  assert.ok(match, `${functionName} wrapper should exist in app.js`);
  return match[1] || '';
}

test('app.js composes messageRenderController and delegates message-render wrappers through it', async () => {
  const source = await readFile(appJsUrl, 'utf8');

  assert.match(source, /const messageRenderController = renderTraceHelpers\.createMessageRenderController\(\{/,
    'app.js should compose messageRenderController from renderTraceHelpers');
  assert.match(source, /getAllowedRoots: \(\) => filePreviewAllowedRoots/,
    'messageRenderController should receive allowed-roots getter');
  assert.match(source, /getOperatorDisplayName: \(\) => operatorDisplayName/,
    'messageRenderController should receive live operator-display getter');
  assert.match(source, /templateElement: template/,
    'messageRenderController should receive the message template');
  assert.match(source, /getHistory: \(chatId\) => histories\.get\(Number\(chatId\)\) \|\| \[\]/,
    'messageRenderController should receive live history lookup');
  assert.match(source, /getMessagesContainer: \(\) => messagesEl/,
    'messageRenderController should receive the live messages container');
  assert.match(source, /getActiveChatId: \(\) => activeChatId/,
    'messageRenderController should receive a live active-chat getter');
  assert.match(source, /getStreamPhase,/,
    'messageRenderController should receive stream-phase lookup');

  const appendMessagesBody = extractFunctionBody(source, 'appendMessages');
  assert.match(appendMessagesBody, /messageRenderController\.appendMessages\(fragment, messages, options\)/,
    'appendMessages should delegate through messageRenderController');
  assert.doesNotMatch(appendMessagesBody, /typeof options === "number"/,
    'appendMessages should no longer own legacy option normalization inline');

  const createMessageNodeBody = extractFunctionBody(source, 'createMessageNode');
  assert.match(createMessageNodeBody, /messageRenderController\.createMessageNode\(message, \{ index \}\)/,
    'createMessageNode should delegate through messageRenderController');

  const upsertMessageNodeBody = extractFunctionBody(source, 'upsertMessageNode');
  assert.match(upsertMessageNodeBody, /messageRenderController\.upsertMessageNode\(node, message\)/,
    'upsertMessageNode should delegate through messageRenderController');

  const pendingKeyBody = extractFunctionBody(source, 'messageStableKeyForPendingState');
  assert.match(pendingKeyBody, /messageRenderController\.messageStableKeyForPendingState\(message, index, pendingState\)/,
    'messageStableKeyForPendingState should delegate through messageRenderController');

  const renderBodyBody = extractFunctionBody(source, 'renderBody');
  assert.match(renderBodyBody, /messageRenderController\.renderBody\(container, rawText, \{ fileRefs \}\)/,
    'renderBody should delegate through messageRenderController');

  const findLatestBody = extractFunctionBody(source, 'findLatestHistoryMessageByRole');
  assert.match(findLatestBody, /messageRenderController\.findLatestHistoryMessageByRole\(chatId, role, \{ pendingOnly \}\)/,
    'findLatestHistoryMessageByRole should delegate through messageRenderController');
  assert.doesNotMatch(findLatestBody, /renderTraceHelpers\.findLatestHistoryMessageByRole/,
    'findLatestHistoryMessageByRole should no longer compose through renderTraceHelpers inline');

  const findAssistantBody = extractFunctionBody(source, 'findLatestAssistantHistoryMessage');
  assert.match(findAssistantBody, /messageRenderController\.findLatestAssistantHistoryMessage\(chatId, \{ pendingOnly \}\)/,
    'findLatestAssistantHistoryMessage should delegate through messageRenderController');

  const findNodeBody = extractFunctionBody(source, 'findMessageNodeByKey');
  assert.match(findNodeBody, /messageRenderController\.findMessageNodeByKey\(selector, messageKey, alternateMessageKey\)/,
    'findMessageNodeByKey should delegate through messageRenderController');

  const patchAssistantBody = extractFunctionBody(source, 'patchVisiblePendingAssistant');
  assert.match(patchAssistantBody, /messageRenderController\.patchVisiblePendingAssistant\(chatId, nextBody, pendingState\)/,
    'patchVisiblePendingAssistant should delegate through messageRenderController');
  assert.doesNotMatch(patchAssistantBody, /renderTraceHelpers\.patchVisiblePendingAssistant/,
    'patchVisiblePendingAssistant should no longer own inline render-trace patch composition');

  const patchToolBody = extractFunctionBody(source, 'patchVisibleToolTrace');
  assert.match(patchToolBody, /messageRenderController\.patchVisibleToolTrace\(chatId\)/,
    'patchVisibleToolTrace should delegate through messageRenderController');
});
