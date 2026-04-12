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

test('app.js composes historyRenderController and delegates history-render wrappers through it', async () => {
  const source = await readFile(appJsUrl, 'utf8');

  assert.match(
    source,
    /function\s+createHistoryRenderControllerDeps\s*\([\s\S]*?return\s+\{[\s\S]*?clearSelectionQuoteStateFn:\s*clearSelectionQuoteState,[\s\S]*?syncLiveToolStreamForChatFn:\s*syncLiveToolStreamForChat,[\s\S]*?appendMessagesFn:\s*appendMessages,[\s\S]*?\};\s*\}/m,
    'app.js should build history render deps through createHistoryRenderControllerDeps(...)',
  );
  assert.match(
    source,
    /historyRenderControllerInstance\s*=\s*renderTraceHelpers\.createHistoryRenderController\(createHistoryRenderControllerDeps\(\{[\s\S]*?getActiveChatId:\s*\(\)\s*=>\s*Number\(activeChatId\),[\s\S]*?\}\)\);/m,
    'app.js should instantiate historyRenderController through createHistoryRenderControllerDeps(...)',
  );

  const renderVirtualizedBody = extractFunctionBody(source, 'renderVirtualizedHistory');
  assert.match(
    renderVirtualizedBody,
    /return\s+historyRenderController\.renderVirtualizedHistory\(targetChatId, history, \{/,
    'renderVirtualizedHistory should delegate through historyRenderController',
  );
  assert.doesNotMatch(
    renderVirtualizedBody,
    /messagesEl\.innerHTML\s*=|computeVirtualRange\(|createDocumentFragment\(/,
    'renderVirtualizedHistory should no longer own inline virtualized DOM work',
  );

  const tryAppendOnlyBody = extractFunctionBody(source, 'tryAppendOnlyRender');
  assert.match(
    tryAppendOnlyBody,
    /return\s+historyRenderController\.tryAppendOnlyRender\(targetChatId, history, \{/,
    'tryAppendOnlyRender should delegate through historyRenderController',
  );
  assert.doesNotMatch(
    tryAppendOnlyBody,
    /appendChild\(|querySelectorAll\('\.message'\)|dataset\.messageKey/,
    'tryAppendOnlyRender should no longer own inline append-only DOM bookkeeping',
  );

  const restoreViewportBody = extractFunctionBody(source, 'restoreMessageViewport');
  assert.match(
    restoreViewportBody,
    /return\s+historyRenderController\.restoreMessageViewport\(targetChatId, \{/,
    'restoreMessageViewport should delegate through historyRenderController',
  );
  assert.doesNotMatch(
    restoreViewportBody,
    /scrollTop\s*=|querySelector\('\.message\[data-message-key=/,
    'restoreMessageViewport should no longer own inline viewport anchoring logic',
  );

  const renderMessagesBody = extractFunctionBody(source, 'renderMessages');
  assert.match(
    renderMessagesBody,
    /return\s+historyRenderController\.renderMessages\(chatId, \{ preserveViewport, forceBottom \}\);/,
    'renderMessages should delegate through historyRenderController',
  );
});
