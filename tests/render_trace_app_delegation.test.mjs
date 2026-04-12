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

  assert.match(source, /function\s+createLazyControllerProxy\s*\(getController\)\s*\{[\s\S]*?return\s+new\s+Proxy\(\{},[\s\S]*?get\(_target, prop\)[\s\S]*?const\s+controller\s*=\s*getController\(\);[\s\S]*?value\.bind\(controller\)\s*:\s*value;[\s\S]*?\}\);\s*\}/m,
    'app.js should share lazy proxy binding through createLazyControllerProxy(...)');
  assert.match(source, /function\s+createRenderTraceControllerDeps\s*\(\)\s*\{[\s\S]*?renderTraceBadge,[\s\S]*?storageKey:\s*RENDER_TRACE_STORAGE_KEY,[\s\S]*?consoleRef:\s*console,[\s\S]*?\};\s*\}/m,
    'app.js should build render-trace deps through createRenderTraceControllerDeps(...)');
  assert.match(source, /function\s+createRenderTraceController\s*\(\)\s*\{\s*return\s+renderTraceHelpers\.createController\(createRenderTraceControllerDeps\(\)\);\s*\}/m,
    'app.js should instantiate renderTraceController through createRenderTraceController(...)');
  assert.match(source, /const\s+renderTraceController\s*=\s*createLazyControllerProxy\(getRenderTraceController\);/,
    'app.js should expose renderTraceController through the shared lazy proxy helper');
  assert.match(source, /function\s+createMessageRenderControllerDeps\s*\(\)\s*\{[\s\S]*?getAllowedRoots:\s*\(\)\s*=>\s*filePreviewAllowedRoots,[\s\S]*?getOperatorDisplayName:\s*\(\)\s*=>\s*operatorDisplayName,[\s\S]*?templateElement:\s*template,[\s\S]*?getHistory:\s*\(chatId\)\s*=>\s*histories\.get\(Number\(chatId\)\)\s*\|\|\s*\[\],[\s\S]*?getMessagesContainer:\s*\(\)\s*=>\s*messagesEl,[\s\S]*?getActiveChatId:\s*\(\)\s*=>\s*activeChatId,[\s\S]*?getStreamPhase,[\s\S]*?\};\s*\}/m,
    'app.js should build messageRenderController deps through createMessageRenderControllerDeps(...)');
  assert.match(source, /function\s+createMessageRenderController\s*\(\)\s*\{\s*return\s+renderTraceHelpers\.createMessageRenderController\(createMessageRenderControllerDeps\(\)\);\s*\}/m,
    'app.js should instantiate messageRenderController through createMessageRenderController(...)');
  assert.match(source, /const\s+messageRenderController\s*=\s*createLazyControllerProxy\(getMessageRenderController\);/,
    'app.js should expose messageRenderController through the shared lazy proxy helper');

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
