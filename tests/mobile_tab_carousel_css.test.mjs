import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const cssSource = readFileSync(join(__dirname, '..', 'static', 'app.css'), 'utf8');

test('mobile tab carousel uses bounded card widths with snap padding instead of overflowing full-width tabs', () => {
  assert.match(cssSource, /html, body\s*\{[\s\S]*overflow-x:\s*hidden;/);
  assert.match(cssSource, /\.tabs-wrap\s*\{[\s\S]*min-width:\s*0;[\s\S]*overflow-x:\s*hidden;/);
  assert.match(cssSource, /\.chat-tabs\s*\{[\s\S]*min-width:\s*0;[\s\S]*width:\s*100%;/);
  assert.match(cssSource, /\.chat-tabs\.chat-tabs--mobile-carousel\s*\{[\s\S]*padding-inline:\s*14px;[\s\S]*scroll-padding-inline:\s*14px;[\s\S]*justify-content:\s*flex-start;/);
  assert.match(cssSource, /\.chat-tabs\.chat-tabs--mobile-carousel \.chat-tab\s*\{[\s\S]*flex:\s*0 0 clamp\(15rem, calc\(100% - 112px\), 19rem\);[\s\S]*width:\s*clamp\(15rem, calc\(100% - 112px\), 19rem\);[\s\S]*max-width:\s*calc\(100% - 40px\);/);
  assert.doesNotMatch(cssSource, /\.chat-tabs\.chat-tabs--mobile-carousel \.chat-tab\s*\{[\s\S]*flex:\s*0 0 calc\(100% - 72px\);/);
});

test('mobile transcript content cannot widen the app shell when a reply contains long code lines', () => {
  assert.match(cssSource, /\.messages\s*\{[\s\S]*min-width:\s*0;/);
  assert.match(cssSource, /\.message\s*\{[\s\S]*min-width:\s*0;/);
  assert.match(cssSource, /\.message__body\s*\{[\s\S]*min-width:\s*0;[\s\S]*overflow-wrap:\s*anywhere;/);
  assert.match(cssSource, /\.code-block\s*\{[\s\S]*max-width:\s*100%;[\s\S]*min-width:\s*0;[\s\S]*overflow-x:\s*auto;[\s\S]*white-space:\s*pre-wrap;[\s\S]*overflow-wrap:\s*anywhere;[\s\S]*word-break:\s*break-word;/);
});
