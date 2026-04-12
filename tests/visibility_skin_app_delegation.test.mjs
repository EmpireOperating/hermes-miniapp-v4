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

  assert.ok(
    source.includes('function createVisibilitySkinControllerStateDeps() {')
      && source.includes('skinSyncChannel,')
      && source.includes('setCurrentSkin: (value) => {'),
    'app.js should isolate visibility skin state wiring in createVisibilitySkinControllerStateDeps(...)',
  );
  assert.ok(
    source.includes('function createVisibilitySkinControllerRuntimeDeps() {')
      && source.includes('apiPost,')
      && source.includes('markVisibilityResume,'),
    'app.js should isolate visibility skin runtime wiring in createVisibilitySkinControllerRuntimeDeps(...)',
  );
  assert.ok(
    source.includes('function createVisibilitySkinControllerDeps() {')
      && source.includes('...createVisibilitySkinControllerStateDeps(),')
      && source.includes('...createVisibilitySkinControllerRuntimeDeps(),'),
    'app.js should compose visibility skin deps from narrower helper bands',
  );
  assert.ok(
    source.includes('function createVisibilitySkinController() {')
      && source.includes('return visibilitySkinHelpers.createController(createVisibilitySkinControllerDeps());'),
    'app.js should instantiate visibilitySkinController through createVisibilitySkinController(...)',
  );
  assert.ok(
    source.includes('const visibilitySkinController = createVisibilitySkinController();'),
    'app.js should allocate visibilitySkinController through the createVisibilitySkinController wrapper',
  );

  const delegateExpectations = [
    ['normalizeSkin', /return\s+visibilitySkinController\.normalizeSkin\(value\);/],
    ['getStoredSkin', /return\s+visibilitySkinController\.getStoredSkin\(\);/],
    ['setSkin', /return\s+visibilitySkinController\.setSkin\(skin, options\);/],
    ['syncSkinFromStorage', /return\s+visibilitySkinController\.syncSkinFromStorage\(\);/],
    ['saveSkinPreference', /return\s+visibilitySkinController\.saveSkinPreference\(skin\);/],
    ['syncUnreadNotificationPresence', /return\s+visibilitySkinController\.syncUnreadNotificationPresence\(options\);/],
  ];

  const explicitAppWrappers = [
    ['saveTelegramUnreadNotificationsPreference', /apiPost\('\/api\/preferences\/telegram-unread-notifications'/],
  ];

  for (const [fnName, delegatedCall] of delegateExpectations) {
    const body = extractFunctionBody(source, fnName);
    assert.match(body, delegatedCall, `${fnName} should delegate through visibilitySkinController`);
  }

  for (const [fnName, delegatedCall] of explicitAppWrappers) {
    const body = extractFunctionBody(source, fnName);
    assert.match(body, delegatedCall, `${fnName} should preserve the explicit app-level wrapper logic`);
  }
});
