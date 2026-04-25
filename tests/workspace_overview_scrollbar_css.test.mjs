import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const cssSource = readFileSync(join(__dirname, '..', 'static', 'app.css'), 'utf8');

test('workspace overview scrollbar matches the stable miniapp pill scrollbar styling', () => {
  assert.match(
    cssSource,
    /\.sidebar__chat-overview-wrap\s+\.chat-tabs__overview:not\(\[hidden\]\)\s*\{[\s\S]*scrollbar-width:\s*thin;[\s\S]*scrollbar-color:\s*color-mix\(in srgb, var\(--line-strong\) 34%, transparent\) transparent;/,
  );
  assert.match(
    cssSource,
    /\.sidebar__chat-overview-wrap\s+\.chat-tabs__overview:not\(\[hidden\]\)::\-webkit-scrollbar\s*\{[\s\S]*height:\s*6px;/,
  );
  assert.match(
    cssSource,
    /\.sidebar__chat-overview-wrap\s+\.chat-tabs__overview:not\(\[hidden\]\)::\-webkit-scrollbar-track\s*\{[\s\S]*background:\s*transparent;/,
  );
  assert.match(
    cssSource,
    /\.sidebar__chat-overview-wrap\s+\.chat-tabs__overview:not\(\[hidden\]\)::\-webkit-scrollbar-thumb\s*\{[\s\S]*background:\s*color-mix\(in srgb, var\(--line-strong\) 34%, transparent\);[\s\S]*border-radius:\s*999px;/,
  );
});
