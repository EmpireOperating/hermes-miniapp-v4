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

test('app.js startup/bootstrap wrappers keep delegating to startupBindingsController', async () => {
  const source = await readFile(appJsUrl, 'utf8');

  assert.match(
    source,
    /function\s+createStartupBindingsControllerDeps\s*\([\s\S]*?return\s+\{[\s\S]*?noteMobileCarouselInteraction:[\s\S]*?chatTabsController\.noteMobileCarouselInteraction\(\),[\s\S]*?getStreamAbortControllers,[\s\S]*?\};\s*\}/m,
    'app.js should build startup bindings deps through createStartupBindingsControllerDeps(...)',
  );
  assert.match(
    source,
    /function\s+createStartupBindingsController\s*\(\)\s*\{[\s\S]*?startupBindingsHelpers\.createController\(createStartupBindingsControllerDeps\(\{[\s\S]*?getActiveChatId:\s*\(\)\s*=>\s*Number\(activeChatId\),[\s\S]*?getStreamAbortControllers:\s*\(\)\s*=>\s*streamController\.getAbortControllers\(\),[\s\S]*?\}\)\);[\s\S]*?\}/m,
    'app.js should instantiate startupBindingsController through createStartupBindingsController(...)',
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
