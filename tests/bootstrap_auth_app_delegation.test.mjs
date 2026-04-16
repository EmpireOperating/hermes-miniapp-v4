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

test('app.js bootstrap/auth request wrappers keep delegating to bootstrapAuthController', async () => {
  const source = await readFile(appJsUrl, 'utf8');
  assert.match(
    source,
    /function\s+createDeferredHelperRegistry\s*\([\s\S]*?return\s+\{[\s\S]*?bootstrapAuthHelpers:\s*requireHelperGlobal\(windowObject, 'HermesMiniappBootstrapAuth'\),[\s\S]*?interactionHelpers:\s*windowObject\.HermesMiniappInteraction\s*\|\|\s*createDeferredApiHelper\('HermesMiniappInteraction', interactionFallbacks\),[\s\S]*?\};\s*\}/m,
    'app.js should centralize deferred helper/bootstrap lookup in createDeferredHelperRegistry(...)',
  );
  assert.match(
    source,
    /const\s+\{[\s\S]*?bootstrapAuthHelpers,[\s\S]*?startupBindingsHelpers,[\s\S]*?renderTraceHelpers,[\s\S]*?\}\s*=\s*createDeferredHelperRegistry\(\{[\s\S]*?interactionFallbacks:\s*deferredInteractionFallbacks,[\s\S]*?\}\);/m,
    'app.js should resolve helper globals through createDeferredHelperRegistry(...)',
  );
  assert.match(
    source,
    /function\s+createBootstrapAuthStageReporter\s*\([\s\S]*?return\s*\(stage, details = \{\}\) => \{[\s\S]*?logBootStage\(stage, normalized\);[\s\S]*?\};\s*\}/m,
    'app.js should move bootstrap-stage telemetry shaping into createBootstrapAuthStageReporter(...)',
  );
  assert.match(
    source,
    /function\s+createBootstrapAuthControllerSessionDeps\s*\([\s\S]*?return\s+\{[\s\S]*?operatorName,[\s\S]*?messagesEl,[\s\S]*?\};\s*\}/m,
    'app.js should isolate bootstrap auth session/dev wiring in createBootstrapAuthControllerSessionDeps(...)',
  );
  assert.match(
    source,
    /function\s+createBootstrapAuthControllerAppDeps\s*\([\s\S]*?return\s+\{[\s\S]*?resumePendingChatStream,[\s\S]*?windowObject,[\s\S]*?\};\s*\}/m,
    'app.js should isolate bootstrap auth app-state wiring in createBootstrapAuthControllerAppDeps(...)',
  );
  assert.match(
    source,
    /function\s+createBootstrapAuthControllerBootstrapDeps\s*\([\s\S]*?return\s+\{[\s\S]*?markVersionSyncReloadIntent,[\s\S]*?onBootstrapStage,[\s\S]*?\};\s*\}/m,
    'app.js should isolate bootstrap auth retry/version wiring in createBootstrapAuthControllerBootstrapDeps(...)',
  );
  assert.match(
    source,
    /function\s+createBootstrapAuthControllerDeps\s*\(args\)\s*\{[\s\S]*?createBootstrapAuthControllerSessionDeps\(args\)[\s\S]*?createBootstrapAuthControllerAppDeps\(args\)[\s\S]*?createBootstrapAuthControllerBootstrapDeps\(args\)[\s\S]*?\}/m,
    'app.js should compose bootstrap auth deps from narrower helper bands',
  );
  assert.match(
    source,
    /function\s+createBootstrapAuthControllerStateArgs\s*\(\)\s*\{[\s\S]*?devAuthSessionStorageKey:\s*DEV_AUTH_SESSION_STORAGE_KEY,[\s\S]*?getIsAuthenticated:\s*\(\)\s*=>\s*isAuthenticated,[\s\S]*?messagesEl,[\s\S]*?\}/m,
    'app.js should isolate bootstrap auth state/session arg building in createBootstrapAuthControllerStateArgs(...)',
  );
  assert.match(
    source,
    /function\s+createBootstrapAuthControllerAppArgs\s*\(\)\s*\{[\s\S]*?setSkin,[\s\S]*?restoreActiveBootstrapPendingState:\s*\(chatId, options = \{\}\) => \([\s\S]*?typeof chatHistoryController\?\.restoreActiveBootstrapPendingState === 'function'[\s\S]*?chatHistoryController\.restoreActiveBootstrapPendingState\(chatId, options\)[\s\S]*?: null[\s\S]*?\),[\s\S]*?syncBootstrapActivationReadState:\s*\(chatId, options = \{\}\) => \([\s\S]*?typeof chatHistoryController\?\.syncBootstrapActivationReadState === 'function'[\s\S]*?chatHistoryController\.syncBootstrapActivationReadState\(chatId, options\)[\s\S]*?: false[\s\S]*?\),[\s\S]*?windowObject:\s*window,[\s\S]*?\}/m,
    'app.js should isolate bootstrap auth app arg building in createBootstrapAuthControllerAppArgs(...) and guard stale helper mismatches',
  );
  assert.doesNotMatch(
    source,
    /ensureActivationReadThreshold:\s*\(chatId, unreadCount\) => chatHistoryController\.ensureActivationReadThreshold\(chatId, unreadCount\)/,
    'app.js should not thread the legacy raw bootstrap threshold helper through live bootstrap auth args once syncBootstrapActivationReadState exists',
  );
  assert.match(
    source,
    /function\s+createBootstrapAuthControllerBootstrapArgs\s*\(\)\s*\{[\s\S]*?authBootstrapMaxAttempts:\s*AUTH_BOOTSTRAP_MAX_ATTEMPTS,[\s\S]*?onBootstrapStage:\s*createBootstrapAuthStageReporter\(\{[\s\S]*?\}\),[\s\S]*?\}/m,
    'app.js should isolate bootstrap auth retry/telemetry arg building in createBootstrapAuthControllerBootstrapArgs(...)',
  );
  assert.match(
    source,
    /function\s+createBootstrapAuthControllerArgs\s*\(\)\s*\{[\s\S]*?createBootstrapAuthControllerStateArgs\(\)[\s\S]*?createBootstrapAuthControllerAppArgs\(\)[\s\S]*?createBootstrapAuthControllerBootstrapArgs\(\)[\s\S]*?\}/m,
    'app.js should compose bootstrap auth constructor args from narrower helper bands',
  );
  assert.ok(
    source.includes('return bootstrapAuthHelpers.createController(createBootstrapAuthControllerDeps(createBootstrapAuthControllerArgs()));'),
    'app.js should instantiate bootstrapAuthController through createBootstrapAuthController(...) using the extracted args builder',
  );
  assert.match(
    source,
    /const\s+bootstrapAuthController\s*=\s*createBootstrapAuthController\(\);/m,
    'app.js should allocate bootstrapAuthController through the createBootstrapAuthController wrapper',
  );

  const delegateExpectations = [
    ['normalizeHandle', 'bootstrapAuthController.normalizeHandle(value)'],
    ['fallbackHandleFromDisplayName', 'bootstrapAuthController.fallbackHandleFromDisplayName(value)'],
    ['refreshOperatorRoleLabels', 'bootstrapAuthController.refreshOperatorRoleLabels()'],
    ['authPayload', 'bootstrapAuthController.authPayload(extra)'],
    ['safeReadJson', 'bootstrapAuthController.safeReadJson(response)'],
    ['summarizeUiFailure', 'bootstrapAuthController.summarizeUiFailure(rawBody, { status, fallback })'],
    ['parseStreamErrorPayload', 'bootstrapAuthController.parseStreamErrorPayload(rawBody)'],
    ['apiPost', 'bootstrapAuthController.apiPost(url, payload)'],
    ['fetchAuthBootstrapWithRetry', 'bootstrapAuthController.fetchAuthBootstrapWithRetry()'],
    ['maybeRefreshForBootstrapVersionMismatch', 'bootstrapAuthController.maybeRefreshForBootstrapVersionMismatch()'],
  ];

  for (const [fnName, delegatedCall] of delegateExpectations) {
    const body = extractFunctionBody(source, fnName);
    assert.match(
      body,
      new RegExp(delegatedCall.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
      `${fnName} should delegate to bootstrap auth controller`,
    );
  }
});
