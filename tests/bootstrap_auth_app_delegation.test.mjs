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
    /function\s+createBootstrapAuthControllerDeps\s*\([\s\S]*?return\s+\{[\s\S]*?markVersionSyncReloadIntent,[\s\S]*?onBootstrapStage,[\s\S]*?\};\s*\}/m,
    'app.js should build bootstrap auth deps through a dedicated composition helper',
  );
  assert.match(
    source,
    /function\s+createBootstrapAuthController\s*\(\)\s*\{[\s\S]*?bootstrapAuthHelpers\.createController\(createBootstrapAuthControllerDeps\(\{[\s\S]*?onBootstrapStage:\s*createBootstrapAuthStageReporter\(\{[\s\S]*?\}\),[\s\S]*?\}\)\);[\s\S]*?\}/m,
    'app.js should instantiate bootstrapAuthController through createBootstrapAuthController(...)',
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
