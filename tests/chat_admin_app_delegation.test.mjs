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

  assert.match(source, /const\s+tabActionsMenuFeatureEnabled\s*=\s*Boolean\(featureConfig\.tabActionsMenu\)/, 'app.js should read the tabActionsMenu feature flag');
  assert.match(source, /body\.dataset\.tabActionsMenu\s*=\s*tabActionsMenuFeatureEnabled\s*\?\s*"true"\s*:\s*"false"/, 'app.js should expose the tab-actions-menu flag on body dataset so mobile CSS can hide sidebar buttons');

  const delegateExpectations = [
    ['closeChatTabContextMenu', 'chatAdminController.closeChatTabContextMenu()'],
    ['openChatTabContextMenu', 'chatAdminController.openChatTabContextMenu(chatId, clientX, clientY)'],
    ['closePinnedChatContextMenu', 'chatAdminController.closePinnedChatContextMenu()'],
    ['openPinnedChatContextMenu', 'chatAdminController.openPinnedChatContextMenu(chatId, clientX, clientY)'],
    ['handleTabOverflowTriggerClick', 'chatAdminController.handleTabOverflowTriggerClick(event)'],
    ['handlePinnedOverflowTriggerClick', 'chatAdminController.handlePinnedOverflowTriggerClick(event)'],
    ['handleTabContextRenameClick', 'chatAdminController.handleTabContextRenameClick(event)'],
    ['handleTabContextPinClick', 'chatAdminController.handleTabContextPinClick(event)'],
    ['handleTabContextCloseClick', 'chatAdminController.handleTabContextCloseClick(event)'],
    ['handleTabContextForkClick', 'chatAdminController.handleTabContextForkClick(event)'],
    ['handlePinnedContextRemoveClick', 'chatAdminController.handlePinnedContextRemoveClick(event)'],
    ['handleGlobalChatContextMenuDismiss', 'chatAdminController.handleGlobalChatContextMenuDismiss(event)'],
  ];

  for (const [fnName, delegatedCall] of delegateExpectations) {
    const body = extractFunctionBody(source, fnName);
    assert.match(
      body,
      new RegExp(delegatedCall.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
      `${fnName} should delegate to chatAdminController`,
    );

    const definitionMatches = source.match(new RegExp(String.raw`function\s+${fnName}\s*\(`, 'g')) || [];
    assert.equal(definitionMatches.length, 1, `${fnName} should only be declared once in app.js`);
  }

  const bindingExpectations = [
    /tabsEl\?\.addEventListener\?\.\("click",\s*handleTabOverflowTriggerClick,\s*true\)/,
    /pinnedChatsEl\?\.addEventListener\?\.\("click",\s*handlePinnedOverflowTriggerClick,\s*true\)/,
    /chatTabContextRename\?\.addEventListener\?\.\("click",\s*\(event\)\s*=>\s*\{\s*void handleTabContextRenameClick\(event\);\s*\}\);/s,
    /chatTabContextPin\?\.addEventListener\?\.\("click",\s*\(event\)\s*=>\s*\{\s*void handleTabContextPinClick\(event\);\s*\}\);/s,
    /chatTabContextClose\?\.addEventListener\?\.\("click",\s*\(event\)\s*=>\s*\{\s*void handleTabContextCloseClick\(event\);\s*\}\);/s,
    /chatTabContextFork\?\.addEventListener\?\.\("click",\s*\(event\)\s*=>\s*\{\s*void handleTabContextForkClick\(event\);\s*\}\);/s,
    /pinnedChatContextRemove\?\.addEventListener\?\.\("click",\s*\(event\)\s*=>\s*\{\s*void handlePinnedContextRemoveClick\(event\);\s*\}\);/s,
    /function\s+closeAllChatContextMenus\s*\(\)\s*\{\s*closeChatTabContextMenu\(\);\s*closePinnedChatContextMenu\(\);\s*\}/s,
    /window\?\.addEventListener\?\.\("blur",\s*closeAllChatContextMenus\);/,
    /window\?\.addEventListener\?\.\("resize",\s*closeAllChatContextMenus\);/,
    /window\?\.addEventListener\?\.\("scroll",\s*closeAllChatContextMenus,\s*true\);/,
  ];

  for (const expectation of bindingExpectations) {
    assert.match(source, expectation, `app.js should preserve chat context menu binding ${expectation}`);
  }
});
