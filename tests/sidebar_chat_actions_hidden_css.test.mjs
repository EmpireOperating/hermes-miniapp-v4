import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const cssSource = readFileSync(join(__dirname, '..', 'static', 'app.css'), 'utf8');

test('chat-scoped sidebar actions are hidden globally', () => {
  assert.match(
    cssSource,
    /\.chat-actions__chat-scoped\s*\{\s*display:\s*none;\s*\}/,
  );
});
