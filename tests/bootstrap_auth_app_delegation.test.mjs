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
