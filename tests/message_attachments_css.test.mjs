import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const cssSource = readFileSync(join(__dirname, '..', 'static', 'app.css'), 'utf8');

test('message attachment transcript styles exist', () => {
  assert.match(cssSource, /\.message-attachments\s*\{/);
  assert.match(cssSource, /\.message-attachment\s*\{/);
  assert.match(cssSource, /\.message-attachment__thumb\s*\{/);
  assert.match(cssSource, /\.message-attachment__label\s*\{/);
  assert.match(cssSource, /\.message-attachment__meta\s*\{/);
});
