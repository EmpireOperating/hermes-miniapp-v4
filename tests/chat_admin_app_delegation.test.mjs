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

test('app.js chat-tab context wrappers keep delegating to chatAdminController', async () => {
  const source = await readFile(appJsUrl, 'utf8');

  const delegateExpectations = [
    ['closeChatTabContextMenu', 'chatAdminController.closeChatTabContextMenu()'],
    ['openChatTabContextMenu', 'chatAdminController.openChatTabContextMenu(chatId, clientX, clientY)'],
    ['handleTabOverflowTriggerClick', 'chatAdminController.handleTabOverflowTriggerClick(event)'],
    ['handleTabContextForkClick', 'chatAdminController.handleTabContextForkClick(event)'],
    ['handleGlobalChatContextMenuDismiss', 'chatAdminController.handleGlobalChatContextMenuDismiss(event)'],
  ];

  for (const [fnName, delegatedCall] of delegateExpectations) {
    const body = extractFunctionBody(source, fnName);
    assert.match(
      body,
      new RegExp(delegatedCall.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
      `${fnName} should delegate to chatAdminController`,
    );
  }
});
