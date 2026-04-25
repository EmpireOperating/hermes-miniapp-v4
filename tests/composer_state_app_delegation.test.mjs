import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const repoRoot = resolve(import.meta.dirname, '..');

function read(relativePath) {
  return readFileSync(resolve(repoRoot, relativePath), 'utf8');
}

test('app delegates updateComposerState ownership to composer_state_helpers controller', () => {
  const appJs = read('static/app.js');
  const helperJs = read('static/composer_state_helpers.js');

  assert.match(helperJs, /function createController\(\{/);
  assert.match(helperJs, /function updateComposerState\(\) \{/);
  assert.match(helperJs, /const state = deriveComposerState\(\{/);
  assert.match(helperJs, /applyComposerState\(\{/);

  assert.match(appJs, /const composerStateController = composerStateHelpers\.createController\(\{/);
  assert.match(appJs, /function updateComposerState\(\) \{/);
  assert.match(appJs, /const result = composerStateController\.updateComposerState\(\);[\s\S]*?renderComposerAttachments\(\);[\s\S]*?return result;/);
  assert.doesNotMatch(appJs, /composerStateHelpers\.deriveComposerState\(\{/);
  assert.doesNotMatch(appJs, /composerStateHelpers\.applyComposerState\(\{/);
});
