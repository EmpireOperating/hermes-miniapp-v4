import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const cssSource = readFileSync(join(__dirname, '..', 'static', 'app.css'), 'utf8');

test('workspace page scrollbar uses the same pill-style treatment as the styled miniapp rails', () => {
  assert.match(
    cssSource,
    /html,\s*body\s*\{[\s\S]*margin:\s*0;[\s\S]*\}/,
  );
  assert.match(
    cssSource,
    /html,\s*body\s*\{[\s\S]*scrollbar-width:\s*thin;[\s\S]*scrollbar-color:\s*color-mix\(in srgb, var\(--line-strong\) 34%, transparent\) transparent;[\s\S]*\}/,
  );
  assert.match(
    cssSource,
    /html::-webkit-scrollbar,\s*body::-webkit-scrollbar\s*\{[\s\S]*width:\s*6px;[\s\S]*\}/,
  );
  assert.match(
    cssSource,
    /html::-webkit-scrollbar-track,\s*body::-webkit-scrollbar-track\s*\{[\s\S]*background:\s*transparent;[\s\S]*\}/,
  );
  assert.match(
    cssSource,
    /html::-webkit-scrollbar-thumb,\s*body::-webkit-scrollbar-thumb\s*\{[\s\S]*background:\s*color-mix\(in srgb, var\(--line-strong\) 34%, transparent\);[\s\S]*border-radius:\s*999px;[\s\S]*\}/,
  );
});
