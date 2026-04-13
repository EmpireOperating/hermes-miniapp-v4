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

test('app.js interaction wrappers delegate through interactionController', async () => {
  const source = await readFile(appJsUrl, 'utf8');

  assert.match(
    source,
    /function\s+createInteractionControllerDeps\s*\([\s\S]*?return\s+\{[\s\S]*?selectionQuoteButton,[\s\S]*?scheduleSelectionQuoteClear,[\s\S]*?clearSelectionQuoteState,[\s\S]*?\};\s*\}/m,
    'app.js should build interactionController deps through createInteractionControllerDeps(...)',
  );
  assert.match(
    source,
    /const\s+interactionController\s*=\s*interactionHelpers\.createController\(createInteractionControllerDeps\(\{[\s\S]*?activeChatIdProvider:\s*\(\)\s*=>\s*Number\(activeChatId\),[\s\S]*?\}\)\);/m,
    'app.js should instantiate interactionController through createInteractionControllerDeps(...)',
  );
  assert.doesNotMatch(
    source,
    /function\s+createSelectionQuoteController\s*\(/,
    'app.js should no longer keep a bespoke createSelectionQuoteController shim',
  );
  assert.doesNotMatch(
    source,
    /const\s+selectionQuoteController\s*=\s*createSelectionQuoteController\(\);/,
    'app.js should no longer allocate a redundant selectionQuoteController shim',
  );

  const handleComposerBody = extractFunctionBody(source, 'handleComposerSubmitShortcut');
  assert.match(
    handleComposerBody,
    /return\s+interactionController\.handleComposerSubmitShortcut\(event\);/,
    'handleComposerSubmitShortcut should delegate through interactionController',
  );

  const installSelectionBody = extractFunctionBody(source, 'installSelectionQuoteBindings');
  assert.match(
    installSelectionBody,
    /return\s+interactionController\.bindSelectionQuoteBindings\(\);/,
    'installSelectionQuoteBindings should delegate through interactionController',
  );

  const applyQuoteBody = extractFunctionBody(source, 'applyQuoteIntoPrompt');
  assert.match(
    applyQuoteBody,
    /interactionHelpers\.applyQuoteIntoPrompt\(text,\s*\{/,
    'applyQuoteIntoPrompt should delegate through interactionHelpers',
  );
  assert.match(
    applyQuoteBody,
    /focusComposerAfterQuoteInsertionFn:\s*\(caretPosition\)\s*=>\s*composerViewportController\.focusComposerAfterQuoteInsertion\(caretPosition\)/,
    'applyQuoteIntoPrompt should delegate post-insert focus hardening to composerViewportController so quote insertion uses the same hardened composer-focus path as other reveal flows',
  );
  assert.match(
    applyQuoteBody,
    /mobileQuoteMode\s*,/,
    'applyQuoteIntoPrompt should pass mobileQuoteMode so quote insertion uses the correct focus behavior',
  );
  assert.match(
    applyQuoteBody,
    /documentObject:\s*document/,
    'applyQuoteIntoPrompt should pass document so quote insertion can verify focus ownership before retries',
  );
  assert.match(
    applyQuoteBody,
    /windowObject:\s*window/,
    'applyQuoteIntoPrompt should pass window so quote insertion can schedule focus retries after mobile keyboard transitions',
  );

  const showSelectionQuoteBody = extractFunctionBody(source, 'showSelectionQuoteAction');
  assert.match(
    showSelectionQuoteBody,
    /interactionHelpers\.showSelectionQuoteAction\(/,
    'showSelectionQuoteAction should delegate through interactionHelpers',
  );
  assert.match(
    showSelectionQuoteBody,
    /messagesEl\s*,/,
    'showSelectionQuoteAction should pass messagesEl through so mobile placement uses the live transcript bounds',
  );
  assert.doesNotMatch(
    showSelectionQuoteBody,
    /selectionQuoteButton\.hidden\s*=|style\.left\s*=|style\.top\s*=/,
    'showSelectionQuoteAction should no longer own inline placement DOM mutations',
  );

  const syncSelectionQuoteBody = extractFunctionBody(source, 'syncSelectionQuoteAction');
  assert.match(
    syncSelectionQuoteBody,
    /interactionHelpers\.syncSelectionQuoteAction\(\{/,
    'syncSelectionQuoteAction should delegate through interactionHelpers',
  );
  assert.doesNotMatch(
    syncSelectionQuoteBody,
    /document\.activeElement|selectionQuoteButton\.hidden\s*=|getBoundingClientRect\(/,
    'syncSelectionQuoteAction should no longer keep bespoke selection-sync logic inline',
  );

  assert.match(
    source,
    /installSelectionQuoteBindings\(\);/,
    'app.js should install selection quote bindings through the wrapper',
  );
});

test('deferred interaction helper forwards resolved controller APIs to the deferred controller registry', async () => {
  const source = await readFile(appJsUrl, 'utf8');

  assert.match(
    source,
    /function\s+createDeferredGlobalFacade\s*\(\{\s*windowObject\s*=\s*window,\s*globalKey,\s*facadeApi,\s*handleSet\s*=\s*null\s*\}\)\s*\{[\s\S]*?Object\.defineProperty\(windowObject, globalKey, \{[\s\S]*?handleSet\?\.\(value\);[\s\S]*?\}\);[\s\S]*?\}/m,
    'app.js should centralize deferred global facade installation in createDeferredGlobalFacade(...)',
  );
  assert.match(
    source,
    /function\s+createDeferredControllerFacadeApi\s*\([\s\S]*?return\s+\{[\s\S]*?createController\(deps\)\s*\{[\s\S]*?controllerStates\.add\(state\);[\s\S]*?shouldReplayMethod\(prop\)[\s\S]*?\}\s*,?[\s\S]*?\};\s*\}/m,
    'app.js should centralize deferred controller proxy creation in createDeferredControllerFacadeApi(...)',
  );
  assert.match(
    source,
    /const\s+deferredControllerGlobalKey\s*=\s*`\$\{globalKey\}__deferred_controller__`;/,
    'createDeferredApiHelper should track the deferred controller registry key',
  );
  assert.match(
    source,
    /createDeferredGlobalFacade\(\{[\s\S]*?globalKey,[\s\S]*?facadeApi,[\s\S]*?handleSet\(value\)\s*\{[\s\S]*?window\[deferredControllerGlobalKey\]\s*=\s*value;[\s\S]*?\}\s*\}\);/m,
    'createDeferredApiHelper should install late-bound helpers through createDeferredGlobalFacade(...)',
  );
  assert.match(
    source,
    /window\[deferredControllerGlobalKey\]\s*=\s*value;/,
    'late-loaded helper APIs with createController should be forwarded into the deferred controller registry',
  );
});
