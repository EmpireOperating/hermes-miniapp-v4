import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const cssSource = readFileSync(join(__dirname, '..', 'static', 'app.css'), 'utf8');

test('chat transcript uses the same pill-style custom scrollbar treatment as the stable mini app rails', () => {
  assert.match(
    cssSource,
    /\.messages\s*\{[\s\S]*overflow-y:\s*auto;[\s\S]*scrollbar-width:\s*thin;[\s\S]*scrollbar-color:\s*color-mix\(in srgb, var\(--line-strong\) 34%, transparent\) transparent;[\s\S]*\}/
  );
  assert.match(
    cssSource,
    /\.messages::-webkit-scrollbar\s*\{[\s\S]*width:\s*6px;[\s\S]*\}/
  );
  assert.match(
    cssSource,
    /\.messages::-webkit-scrollbar-track\s*\{[\s\S]*background:\s*transparent;[\s\S]*\}/
  );
  assert.match(
    cssSource,
    /\.messages::-webkit-scrollbar-thumb\s*\{[\s\S]*background:\s*color-mix\(in srgb, var\(--line-strong\) 34%, transparent\);[\s\S]*border-radius:\s*999px;[\s\S]*\}/
  );
});
