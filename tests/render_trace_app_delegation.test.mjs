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

test('app.js render/history wrappers keep delegating to historyRenderController', async () => {
  const source = await readFile(appJsUrl, 'utf8');

  const delegateExpectations = [
    ['isNearBottom', 'historyRenderController.isNearBottom(element, threshold)'],
    ['shouldVirtualizeHistory', 'historyRenderController.shouldVirtualizeHistory(historyLength)'],
    ['getEstimatedMessageHeight', 'historyRenderController.getEstimatedMessageHeight(chatId)'],
    ['updateVirtualMetrics', 'historyRenderController.updateVirtualMetrics(chatId)'],
    ['updateJumpLatestVisibility', 'historyRenderController.updateJumpLatestVisibility()'],
    ['markStreamUpdate', 'historyRenderController.markStreamUpdate(chatId)'],
    ['computeVirtualRange', 'historyRenderController.computeVirtualRange({'],
    ['renderVirtualizedHistory', 'historyRenderController.renderVirtualizedHistory(targetChatId, history, {'],
    ['renderFullHistory', 'historyRenderController.renderFullHistory(targetChatId, history)'],
    ['tryAppendOnlyRender', 'historyRenderController.tryAppendOnlyRender(targetChatId, history, {'],
    ['restoreMessageViewport', 'historyRenderController.restoreMessageViewport(targetChatId, {'],
    ['finalizeRenderMessages', 'historyRenderController.finalizeRenderMessages(targetChatId, history, { shouldVirtualize, forceBottom })'],
    ['renderMessages', 'historyRenderController.renderMessages(chatId, { preserveViewport, forceBottom })'],
  ];

  for (const [fnName, delegatedCall] of delegateExpectations) {
    const body = extractFunctionBody(source, fnName);
    assert.match(
      body,
      new RegExp(delegatedCall.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
      `${fnName} should delegate to controller`,
    );
  }
});
