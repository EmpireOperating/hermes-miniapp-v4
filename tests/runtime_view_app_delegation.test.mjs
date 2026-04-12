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

test('app.js runtime view controller getters use narrowed deps helpers', async () => {
  const source = await readFile(appJsUrl, 'utf8');

  assert.ok(
    source.includes('function createComposerViewportControllerDeps() {')
      && source.includes('updateJumpLatestVisibility,'),
    'app.js should isolate composer viewport wiring in createComposerViewportControllerDeps(...)',
  );
  assert.ok(
    source.includes('function createComposerViewportController() {')
      && source.includes('return composerViewportHelpers.createController(createComposerViewportControllerDeps());'),
    'app.js should instantiate composerViewportController through createComposerViewportController(...)',
  );
  assert.ok(
    source.includes('const composerViewportController = createComposerViewportController();'),
    'app.js should allocate composerViewportController through the createComposerViewportController wrapper',
  );
  assert.ok(
    source.includes('function createLatencyViewControllerDeps() {')
      && source.includes('latencyByChat,')
      && source.includes('getDocumentVisibilityState: () => document.visibilityState,'),
    'app.js should isolate latency view wiring in createLatencyViewControllerDeps(...)',
  );
  assert.ok(
    source.includes('function createStreamActivityControllerDeps() {')
      && source.includes('streamPhases: STREAM_PHASES,')
      && source.includes('formatLatency,'),
    'app.js should isolate stream activity wiring in createStreamActivityControllerDeps(...)',
  );

  const getLatencyBody = extractFunctionBody(source, 'getLatencyViewController');
  assert.match(
    getLatencyBody,
    /runtimeHelpers\.createLatencyController\(createLatencyViewControllerDeps\(\)\)/,
    'getLatencyViewController should construct through createLatencyViewControllerDeps(...)',
  );

  const getStreamActivityBody = extractFunctionBody(source, 'getStreamActivityController');
  assert.match(
    getStreamActivityBody,
    /runtimeHelpers\.createStreamActivityController\(createStreamActivityControllerDeps\(\)\)/,
    'getStreamActivityController should construct through createStreamActivityControllerDeps(...)',
  );
});
