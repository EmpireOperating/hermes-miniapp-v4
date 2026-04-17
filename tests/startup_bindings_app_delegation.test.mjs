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

test('safeDecodeUriComponent returns an empty secret for malformed dev auth hashes', async () => {
  const source = await readFile(appJsUrl, 'utf8');
  const body = extractFunctionBody(source, 'safeDecodeUriComponent');
  const safeDecodeUriComponent = new Function('value', `${body}`);

  assert.equal(safeDecodeUriComponent('desktop%20tester'), 'desktop tester');
  assert.equal(safeDecodeUriComponent('%E0'), '');
});

test('app.js startup/bootstrap wrappers keep delegating to startupBindingsController', async () => {
  const source = await readFile(appJsUrl, 'utf8');

  assert.match(
    source,
    /function\s+createStartupBindingsControllerElementDeps\s*\([\s\S]*?return\s+\{[\s\S]*?templateEl:\s*template,[\s\S]*?tg,[\s\S]*?\};\s*\}/m,
    'app.js should isolate startup DOM wiring in createStartupBindingsControllerElementDeps(...)',
  );
  assert.match(
    source,
    /function\s+createStartupBindingsControllerInteractionDeps\s*\([\s\S]*?return\s+\{[\s\S]*?noteMobileCarouselInteraction:[\s\S]*?chatTabsController\.noteMobileCarouselInteraction\(\),[\s\S]*?getStreamAbortControllers,[\s\S]*?\};\s*\}/m,
    'app.js should isolate startup interaction/runtime wiring in createStartupBindingsControllerInteractionDeps(...)',
  );
  assert.match(
    source,
    /function\s+createStartupBindingsControllerBootstrapDeps\s*\(\)\s*\{[\s\S]*?return\s+\{[\s\S]*?fetchAuthBootstrapWithRetry,[\s\S]*?restoreActiveBootstrapPendingState:\s*\(chatId, options = \{\}\) => \([\s\S]*?typeof chatHistoryController\?\.restoreActiveBootstrapPendingState === 'function'[\s\S]*?chatHistoryController\.restoreActiveBootstrapPendingState\(chatId, options\)[\s\S]*?: null[\s\S]*?\),[\s\S]*?syncVisibleActiveChat,[\s\S]*?\};\s*\}/m,
    'app.js should isolate startup bootstrap/auth wiring in createStartupBindingsControllerBootstrapDeps(...) and guard stale helper mismatches',
  );
  assert.match(
    source,
    /function\s+createStartupBindingsControllerDeps\s*\(args\s*=\s*\{\}\)\s*\{[\s\S]*?createStartupBindingsControllerElementDeps\(args\)[\s\S]*?createStartupBindingsControllerInteractionDeps\(args\)[\s\S]*?createStartupBindingsControllerBootstrapDeps\(args\)[\s\S]*?\}/m,
    'app.js should compose startup bindings deps from narrower helper bands',
  );
  assert.match(
    source,
    /function\s+createStartupBindingsControllerStateArgs\s*\(\)\s*\{[\s\S]*?getActiveChatId:\s*\(\)\s*=>\s*Number\(activeChatId\),[\s\S]*?getRenderTraceDebugEnabled:\s*\(\)\s*=>\s*renderTraceDebugEnabled,[\s\S]*?\}/m,
    'app.js should isolate startup state arg building in createStartupBindingsControllerStateArgs(...)',
  );
  assert.match(
    source,
    /function\s+createStartupBindingsControllerRuntimeArgs\s*\(\)\s*\{[\s\S]*?isMobileBootstrapPath:\s*\(\)\s*=>\s*mobileQuoteMode,[\s\S]*?getStreamAbortControllers:\s*\(\)\s*=>\s*streamController\.getAbortControllers\(\),[\s\S]*?\}/m,
    'app.js should isolate startup runtime arg building in createStartupBindingsControllerRuntimeArgs(...)',
  );
  assert.match(
    source,
    /function\s+createStartupBindingsControllerArgs\s*\(\)\s*\{[\s\S]*?createStartupBindingsControllerStateArgs\(\)[\s\S]*?createStartupBindingsControllerRuntimeArgs\(\)[\s\S]*?\}/m,
    'app.js should compose startup constructor args from narrower helper bands',
  );
  assert.ok(
    source.includes('return startupBindingsHelpers.createController(createStartupBindingsControllerDeps(createStartupBindingsControllerArgs()));'),
    'app.js should instantiate startupBindingsController through createStartupBindingsController(...) using the extracted args builder',
  );
  assert.match(
    source,
    /const\s+startupBindingsController\s*=\s*createStartupBindingsController\(\);/m,
    'app.js should allocate startupBindingsController through the createStartupBindingsController wrapper',
  );

  const delegateExpectations = [
    ['getMissingBootstrapBindings', 'startupBindingsController.getMissingBootstrapBindings()'],
    ['reportBootstrapMismatch', 'startupBindingsController.reportBootstrapMismatch(reason, details)'],
    ['bootstrap', 'startupBindingsController.bootstrap()'],
    ['installPendingCompletionWatchdog', 'startupBindingsController.installPendingCompletionWatchdog()'],
  ];

  for (const [fnName, delegatedCall] of delegateExpectations) {
    const body = extractFunctionBody(source, fnName);
    assert.match(
      body,
      new RegExp(delegatedCall.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
      `${fnName} should delegate to startup bindings controller`,
    );
  }
});
