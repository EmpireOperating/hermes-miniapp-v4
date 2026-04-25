import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const cssPath = path.resolve('static/app.css');
const cssSource = fs.readFileSync(cssPath, 'utf8');

test('desktop closed workspace hides sidebar overview wrapper by default', () => {
  assert.match(
    cssSource,
    /@media \(min-width: 861px\) \{[\s\S]*?\.workspace:not\(\[data-workspace-open="true"\]\) \.sidebar__chat-overview-wrap \{[\s\S]*?display:\s*none;/,
  );
});

test('desktop open workspace re-enables sidebar overview wrapper', () => {
  assert.match(
    cssSource,
    /@media \(min-width: 861px\) \{[\s\S]*?\.workspace\[data-workspace-open="true"\] \.sidebar__chat-overview-wrap \{[\s\S]*?display:\s*grid;/,
  );
});

test('desktop closed workspace explicitly keeps the stable sidebar-left and conversation-right grid', () => {
  assert.match(
    cssSource,
    /\.workspace\s*\{[\s\S]*grid-template-columns:\s*290px\s+minmax\(0, 1fr\);[\s\S]*grid-template-areas:\s*"sidebar terminal";/,
  );
});
