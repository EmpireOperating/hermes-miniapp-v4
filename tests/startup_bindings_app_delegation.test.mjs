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
    /function\s+createStartupBindingsControllerBootstrapDeps\s*\(\)\s*\{[\s\S]*?return\s+\{[\s\S]*?fetchAuthBootstrapWithRetry,[\s\S]*?syncVisibleActiveChat,[\s\S]*?\};\s*\}/m,
    'app.js should isolate startup bootstrap/auth wiring in createStartupBindingsControllerBootstrapDeps(...)',
  );
  assert.match(
    source,
    /function\s+createStartupBindingsControllerDeps\s*\(args\s*=\s*\{\}\)\s*\{[\s\S]*?createStartupBindingsControllerElementDeps\(args\)[\s\S]*?createStartupBindingsControllerInteractionDeps\(args\)[\s\S]*?createStartupBindingsControllerBootstrapDeps\(args\)[\s\S]*?\}/m,
    'app.js should compose startup bindings deps from narrower helper bands',
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
