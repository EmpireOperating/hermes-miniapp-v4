import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const cssSource = readFileSync(join(__dirname, '..', 'static', 'app.css'), 'utf8');

test('desktop chat tab carousel flips the native scrollbar above the tabs without affecting mobile carousel rules', () => {
  assert.match(cssSource, /\.tabs-wrap\s*\{[\s\S]*padding:\s*5px 14px 0;/);
  assert.match(
    cssSource,
    /@media \(min-width:\s*861px\)\s*\{[\s\S]*\.chat-tabs\s*\{[\s\S]*transform:\s*rotateX\(180deg\);[\s\S]*padding-top:\s*10px;[\s\S]*padding-bottom:\s*5px;[\s\S]*scrollbar-width:\s*thin;[\s\S]*scrollbar-color:\s*color-mix\(in srgb, var\(--line-strong\) 34%, transparent\) transparent;[\s\S]*\}[\s\S]*\.chat-tabs::-webkit-scrollbar\s*\{[\s\S]*height:\s*6px;[\s\S]*\}[\s\S]*\.chat-tabs::-webkit-scrollbar-thumb\s*\{[\s\S]*background:\s*color-mix\(in srgb, var\(--line-strong\) 34%, transparent\);[\s\S]*border-radius:\s*999px;[\s\S]*\}[\s\S]*\.chat-tabs\s*>\s*\*\s*\{[\s\S]*transform:\s*rotateX\(180deg\);[\s\S]*\.chat-tabs\s*>\s*\.chat-tab:active\s*\{[\s\S]*transform:\s*translateY\(1px\) rotateX\(180deg\);/
  );
  assert.match(
    cssSource,
    /@media \(max-width:\s*860px\)\s*\{[\s\S]*\.chat-tabs\.chat-tabs--mobile-carousel\s*\{[\s\S]*scrollbar-width:\s*none;/
  );
});
