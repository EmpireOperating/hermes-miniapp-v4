import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const cssSource = readFileSync(join(__dirname, '..', 'static', 'app.css'), 'utf8');

test('desktop Workspace-open layout widens the shell and adds a splitter track between the left rail and the preview', () => {
  assert.match(
    cssSource,
    /@media \(min-width: 861px\) \{[\s\S]*\.shell\[data-workspace-open="true"\]\s*\{[\s\S]*width:\s*min\(1440px, calc\(100vw - 24px\)\);[\s\S]*\.workspace\[data-workspace-open="true"\] \{[\s\S]*--workspace-sidebar-width:\s*380px;[\s\S]*grid-template-columns:\s*var\(--workspace-sidebar-width, 380px\)\s+12px\s+minmax\(0, 1fr\);[\s\S]*grid-template-rows:\s*auto\s+minmax\(0, 1fr\);[\s\S]*grid-template-areas:\s*"sidebar sidebar-resize visual"\s*"terminal sidebar-resize visual";[\s\S]*column-gap:\s*0;[\s\S]*row-gap:\s*0;/,
  );
  assert.match(cssSource, /\.sidebar\s*\{[\s\S]*grid-area:\s*sidebar;/);
  assert.match(cssSource, /\.terminal-panel\s*\{[\s\S]*grid-area:\s*terminal;/);
  assert.match(cssSource, /\.workspace__sidebar-resize-handle\s*\{[\s\S]*grid-area:\s*sidebar-resize;/);
  assert.match(cssSource, /\.visual-dev-workspace\s*\{[\s\S]*grid-area:\s*visual;/);
});

test('desktop Workspace-open keeps the overview rail compact and reuses the mobile-style carousel tabs in the chat panel', () => {
  assert.match(
    cssSource,
    /@media \(min-width: 861px\) \{[\s\S]*\.workspace\[data-workspace-open="true"\]\s+\.sidebar\s*\{[\s\S]*padding-bottom:\s*0;/,
  );
  assert.match(
    cssSource,
    /@media \(min-width: 861px\) \{[\s\S]*\.workspace\[data-workspace-open="true"\]\s+\.sidebar__chat-overview-wrap\s*\{[\s\S]*gap:\s*4px;[\s\S]*padding-top:\s*10px;/,
  );
  assert.match(
    cssSource,
    /@media \(min-width: 861px\) \{[\s\S]*\.workspace\[data-workspace-open="true"\]\s+\.sidebar__chat-overview-wrap\s+\.chat-tabs__overview:not\(\[hidden\]\)\s*\{[\s\S]*width:\s*fit-content;[\s\S]*max-width:\s*100%;[\s\S]*margin-inline:\s*auto;[\s\S]*justify-content:\s*center;/,
  );
  assert.match(
    cssSource,
    /@media \(min-width: 861px\) \{[\s\S]*\.workspace\[data-workspace-open="true"\]\s+\.tabs-wrap\s*\{[\s\S]*display:\s*block;[\s\S]*padding-top:\s*0;/,
  );
  assert.match(
    cssSource,
    /@media \(min-width: 861px\) \{[\s\S]*\.workspace\[data-workspace-open="true"\]\s+\.chat-tabs\s*\{[\s\S]*scroll-snap-type:\s*x mandatory;[\s\S]*padding-inline:\s*14px;[\s\S]*scroll-padding-inline:\s*14px;/,
  );
  assert.match(
    cssSource,
    /@media \(min-width: 861px\) \{[\s\S]*\.workspace\[data-workspace-open="true"\]\s+\.chat-tabs\s+\.chat-tab\s*\{[\s\S]*flex:\s*0 0 clamp\(15rem, calc\(100% - 112px\), 19rem\);[\s\S]*scroll-snap-align:\s*center;/,
  );
  assert.doesNotMatch(
    cssSource,
    /@media \(min-width: 861px\) \{[\s\S]*\.workspace\[data-workspace-open="true"\]\s+\.chat-tabs__overview-title\s*\{[\s\S]*display:\s*inline-block;/,
  );
});

test('desktop Workspace-open hides chat-scoped sidebar actions like the mobile tab-actions-menu mode', () => {
  assert.match(
    cssSource,
    /@media \(min-width: 861px\) \{[\s\S]*\.workspace\[data-workspace-open="true"\]\s+\.chat-actions__chat-scoped\s*\{[\s\S]*display:\s*none;/,
  );
});

test('desktop Workspace-open makes the preview pane taller while capping it to 75vh for shorter screens', () => {
  assert.match(cssSource, /\.visual-dev-workspace__preview-wrap\s*\{[\s\S]*min-height:\s*min\(840px, 75vh\);/);
  assert.match(cssSource, /\.visual-dev-workspace__preview\s*\{[\s\S]*min-height:\s*min\(840px, 75vh\);/);
});

test('workspace preview exposes a desktop bottom-right resize handle with visible overflow for anchored resizing', () => {
  assert.match(cssSource, /\.visual-dev-workspace\s*\{[\s\S]*overflow:\s*visible;/);
  assert.match(cssSource, /\.visual-dev-workspace__preview-wrap\s*\{[\s\S]*position:\s*relative;/);
  assert.match(cssSource, /\.visual-dev-workspace__preview-resize-handle\s*\{[\s\S]*position:\s*absolute;[\s\S]*right:\s*1\.5rem;[\s\S]*bottom:\s*1\.5rem;[\s\S]*cursor:\s*nwse-resize;/);
  assert.match(cssSource, /@media \(max-width: 860px\) \{[\s\S]*\.visual-dev-workspace__preview-resize-handle\s*\{[\s\S]*display:\s*none;/);
});

test('workspace layout exposes a desktop vertical resize handle for widening the left rail', () => {
  assert.match(cssSource, /\.workspace__sidebar-resize-handle\s*\{[\s\S]*align-self:\s*stretch;[\s\S]*justify-self:\s*stretch;[\s\S]*cursor:\s*col-resize;/);
  assert.match(cssSource, /\.workspace__sidebar-resize-handle::before\s*\{[\s\S]*width:\s*4px;[\s\S]*border-radius:\s*999px;/);
  assert.match(cssSource, /@media \(max-width: 860px\) \{[\s\S]*\.workspace__sidebar-resize-handle\s*\{[\s\S]*display:\s*none;/);
});

test('workspace preview can overflow the visual column for manual bottom-right resizing', () => {
  assert.match(cssSource, /\.visual-dev-workspace\s*\{[\s\S]*overflow:\s*visible;/);
  assert.match(
    cssSource,
    /\.visual-dev-workspace__preview-wrap\s*\{[\s\S]*width:\s*100%;[\s\S]*box-sizing:\s*border-box;/,
  );
  assert.doesNotMatch(
    cssSource,
    /\.visual-dev-workspace__preview-wrap\s*\{[\s\S]*max-width:\s*100%;/,
  );
});

test('workspace sidebar drag state disables iframe pointer events and selection while forcing a resize cursor', () => {
  assert.match(cssSource, /\.shell\[data-sidebar-resizing="true"\]\s*,\s*\.shell\[data-sidebar-resizing="true"\]\s*\*\s*\{[\s\S]*cursor:\s*col-resize\s*!important;/);
  assert.match(cssSource, /\.shell\[data-sidebar-resizing="true"\]\s*\{[\s\S]*user-select:\s*none;/);
  assert.match(cssSource, /\.shell\[data-sidebar-resizing="true"\]\s+\.visual-dev-workspace__preview\s*\{[\s\S]*pointer-events:\s*none;/);
});

test('workspace preview keeps hidden cached iframes out of layout so only the active panel is visible', () => {
  assert.match(cssSource, /\.visual-dev-workspace__preview\[hidden\]\s*\{[\s\S]*display:\s*none\s*!important;/);
});

test('composer context and attachment chips cannot stretch the workspace or detach the sidebar resize handle', () => {
  assert.match(cssSource, /\.activity-chip\s*\{[\s\S]*min-width:\s*0;[\s\S]*max-width:\s*min\(100%, calc\(100vw - 56px\)\);[\s\S]*white-space:\s*nowrap;[\s\S]*overflow:\s*hidden;[\s\S]*text-overflow:\s*ellipsis;/);
  assert.match(cssSource, /\.composer__context-row\s*\{[\s\S]*min-width:\s*0;/);
  assert.match(cssSource, /\.composer__context-row \.activity-chip\s*\{[\s\S]*max-width:\s*100%;/);
  assert.match(cssSource, /@media \(min-width: 861px\) \{[\s\S]*\.workspace\[data-workspace-open="true"\]\s+\.terminal-panel\s*\{[\s\S]*min-width:\s*0;[\s\S]*overflow-x:\s*clip;/);
  assert.match(cssSource, /\.composer\s*\{[\s\S]*min-width:\s*0;/);
  assert.match(cssSource, /\.composer-attachments\s*\{[\s\S]*min-width:\s*0;[\s\S]*max-width:\s*100%;[\s\S]*overflow-x:\s*clip;/);
  assert.match(cssSource, /\.composer-attachment-chip\s*\{[\s\S]*flex:\s*0 1 min\(100%, 18rem\);[\s\S]*min-width:\s*0;[\s\S]*max-width:\s*min\(100%, 18rem\);/);
  assert.match(cssSource, /\.composer-attachment-chip__label\s*\{[\s\S]*min-width:\s*0;[\s\S]*overflow:\s*hidden;[\s\S]*text-overflow:\s*ellipsis;[\s\S]*white-space:\s*nowrap;/);
  assert.match(cssSource, /\.composer-attachment-chip__remove\s*\{[\s\S]*flex:\s*0 0 auto;/);
});
