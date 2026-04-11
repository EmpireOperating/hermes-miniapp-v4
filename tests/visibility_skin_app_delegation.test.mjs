import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const appJsUrl = new URL('../static/app.js', import.meta.url);

function extractFunctionBody(source, functionName) {
  const fnPattern = new RegExp(
    String.raw`(?:async\s+)?function\s+${functionName}\s*\([^)]*\)\s*\{([\s\S]*?)\n\}`,
    'm',
  );
  const match = source.match(fnPattern);
  assert.ok(match, `expected to find function ${functionName}`);
  return match[1];
}

test('app.js visibility skin wrappers delegate to visibilitySkinController', async () => {
  const source = await readFile(appJsUrl, 'utf8');
  const delegateExpectations = [
    ['normalizeSkin', /return\s+visibilitySkinController\.normalizeSkin\(value\);/],
    ['getStoredSkin', /return\s+visibilitySkinController\.getStoredSkin\(\);/],
    ['setSkin', /return\s+visibilitySkinController\.setSkin\(skin, options\);/],
    ['syncSkinFromStorage', /return\s+visibilitySkinController\.syncSkinFromStorage\(\);/],
    ['saveSkinPreference', /return\s+visibilitySkinController\.saveSkinPreference\(skin\);/],
    ['syncUnreadNotificationPresence', /return\s+visibilitySkinController\.syncUnreadNotificationPresence\(options\);/],
  ];

  for (const [fnName, delegatedCall] of delegateExpectations) {
    const body = extractFunctionBody(source, fnName);
    assert.match(body, delegatedCall, `${fnName} should delegate through visibilitySkinController`);
  }
});
