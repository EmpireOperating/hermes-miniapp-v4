import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const templateSource = readFileSync(join(__dirname, '..', 'templates', 'media_editor.html'), 'utf8');

test('media editor uses a blue-toned Hermes palette instead of default GitHub editor colors', () => {
  assert.match(templateSource, /--media-editor-bg:\s*#070b14;/);
  assert.match(templateSource, /--media-editor-panel:\s*rgba\(10, 18, 32, 0\.96\);/);
  assert.match(templateSource, /--media-editor-accent:\s*#67b7ff;/);
  assert.match(templateSource, /--media-editor-accent-soft:\s*#b8ddff;/);
  assert.match(templateSource, /--media-editor-line:\s*rgba\(103, 183, 255, 0\.28\);/);

  assert.doesNotMatch(templateSource, /background:\s*#0d1117;/);
  assert.doesNotMatch(templateSource, /background:\s*rgba\(22, 27, 34, 0\.96\);/);
  assert.doesNotMatch(templateSource, /#58a6ff/);
  assert.doesNotMatch(templateSource, /#d2a8ff/);
  assert.doesNotMatch(templateSource, /#3fb950/);
});
