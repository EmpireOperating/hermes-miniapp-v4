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

test('app.js keyboard shortcut wrappers keep delegating to keyboardShortcutsController', async () => {
  const source = await readFile(appJsUrl, 'utf8');

  const delegateExpectations = [
    ['getOrderedChatIds', 'keyboardShortcutsController.getOrderedChatIds()'],
    ['isTextEntryElement', 'keyboardShortcutsController.isTextEntryElement(element)'],
    ['isDesktopViewport', 'keyboardShortcutsController.isDesktopViewport()'],
    ['handleTabClick', 'keyboardShortcutsController.handleTabClick(event)'],
    ['handlePinnedChatClick', 'keyboardShortcutsController.handlePinnedChatClick(event)'],
    ['handleGlobalTabCycle', 'keyboardShortcutsController.handleGlobalTabCycle(event)'],
    ['scrollMessagesByArrow', 'keyboardShortcutsController.scrollMessagesByArrow(direction)'],
    ['handleGlobalArrowJump', 'keyboardShortcutsController.handleGlobalArrowJump(event)'],
    ['handleGlobalComposerFocusShortcut', 'keyboardShortcutsController.handleGlobalComposerFocusShortcut(event)'],
    ['handleGlobalChatActionShortcut', 'keyboardShortcutsController.handleGlobalChatActionShortcut(event)'],
    ['shouldReleaseControlFocusAfterClick', 'keyboardShortcutsController.shouldReleaseControlFocusAfterClick(target)'],
    ['releaseStickyControlFocus', 'keyboardShortcutsController.releaseStickyControlFocus()'],
    ['handleGlobalControlClickFocusCleanup', 'keyboardShortcutsController.handleGlobalControlClickFocusCleanup(event)'],
    ['handleGlobalControlMouseDownFocusGuard', 'keyboardShortcutsController.handleGlobalControlMouseDownFocusGuard(event)'],
    ['handleGlobalControlEnterDefuse', 'keyboardShortcutsController.handleGlobalControlEnterDefuse(event)'],
  ];

  for (const [fnName, delegatedCall] of delegateExpectations) {
    const body = extractFunctionBody(source, fnName);
    assert.match(
      body,
      new RegExp(delegatedCall.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
      `${fnName} should delegate to keyboardShortcutsController`,
    );
  }
});
