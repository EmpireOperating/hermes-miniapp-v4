import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const promptContextHelpers = require('../static/visual_dev_prompt_context_helpers.js');

function createElement() {
  const listeners = new Map();
  return {
    value: '',
    focusCalls: 0,
    addEventListener(type, handler) {
      listeners.set(type, handler);
    },
    click() {
      listeners.get('click')?.();
    },
    focus() {
      this.focusCalls += 1;
    },
  };
}

test('buildSelectionSnippet includes the selected UI metadata', () => {
  const snippet = promptContextHelpers.buildSelectionSnippet({
    label: 'Play button',
    selector: '#play-button',
    tagName: 'button',
    text: 'Play',
  });

  assert.match(snippet, /\[Visual UI context\]/);
  assert.match(snippet, /Selected element: Play button/);
  assert.match(snippet, /Selector: #play-button/);
  assert.match(snippet, /Tag: button/);
  assert.match(snippet, /Visible text: Play/);
});

test('buildSelectionSnippet describes selected media-editor clips with timing metadata', () => {
  const snippet = promptContextHelpers.buildSelectionSnippet({
    selectionType: 'media_editor_clip',
    label: 'Opening title',
    selector: 'media-editor-clip:clip_1',
    tagName: 'media-editor-clip',
    clip_id: 'clip_1',
    track_id: 'track_text',
    clip_kind: 'text',
    start_ms: 250,
    duration_ms: 1750,
    text: 'Big opening hook',
  });

  assert.match(snippet, /\[Media editor context\]/);
  assert.match(snippet, /Selected clip: Opening title/);
  assert.match(snippet, /Timing: 250–2000ms \(duration 1750ms\)/);
  assert.match(snippet, /Clip ID: clip_1/);
  assert.match(snippet, /Track ID: track_text/);
  assert.match(snippet, /Clip kind: text/);
  assert.match(snippet, /Visible text: Big opening hook/);
});

test('appendSnippetToPrompt appends context with spacing and focuses the composer', () => {
  const promptEl = createElement();
  promptEl.value = 'Existing request';
  let ensured = 0;
  let notified = 0;

  const value = promptContextHelpers.appendSnippetToPrompt(promptEl, 'Context line', {
    ensureComposerVisible() {
      ensured += 1;
    },
    focusPrompt() {
      promptEl.focus();
    },
    notifyInput() {
      notified += 1;
    },
  });

  assert.equal(value, 'Existing request\n\nContext line');
  assert.equal(promptEl.value, 'Existing request\n\nContext line');
  assert.equal(ensured, 1);
  assert.equal(notified, 1);
  assert.equal(promptEl.focusCalls, 1);
});

test('controller chip clicks append selection and screenshot context into the composer', () => {
  const promptEl = createElement();
  const selectionChip = createElement();
  const screenshotChip = createElement();
  const drafts = [];
  const controller = promptContextHelpers.createController({
    enabled: true,
    promptEl,
    selectionChip,
    screenshotChip,
    getSelectionContext: () => ({ label: 'Sidebar toggle', selector: '#sidebar-toggle' }),
    getScreenshotContext: () => ({ label: 'viewport capture', storage_path: '/tmp/capture.png' }),
    notifyInput(value) {
      drafts.push(value);
    },
  });

  controller.bind();
  selectionChip.click();
  screenshotChip.click();

  assert.match(promptEl.value, /Selected element: Sidebar toggle/);
  assert.match(promptEl.value, /Latest screenshot: viewport capture • capture\.png/);
  assert.match(promptEl.value, /Artifact path: \/tmp\/capture\.png/);
  assert.equal(drafts.length, 2);
});

test('controller exposes explicit attached request context only after chip clicks and can clear it', () => {
  const promptEl = createElement();
  const selectionChip = createElement();
  const screenshotChip = createElement();
  const previewChip = createElement();
  const consoleChip = createElement();
  const attachedSelectionChip = createElement();
  attachedSelectionChip.hidden = true;
  const attachedSelectionClearButton = createElement();
  attachedSelectionClearButton.hidden = true;
  const attachedScreenshotChip = createElement();
  attachedScreenshotChip.hidden = true;
  const attachedScreenshotClearButton = createElement();
  attachedScreenshotClearButton.hidden = true;
  const attachedPreviewChip = createElement();
  attachedPreviewChip.hidden = true;
  const attachedPreviewClearButton = createElement();
  attachedPreviewClearButton.hidden = true;
  const attachedConsoleChip = createElement();
  attachedConsoleChip.hidden = true;
  const attachedConsoleClearButton = createElement();
  attachedConsoleClearButton.hidden = true;
  const selection = { label: 'Sidebar toggle', selector: '#sidebar-toggle' };
  const screenshot = { label: 'viewport capture', storage_path: '/tmp/screenshot-1776958241575-66c1c292.png' };
  const preview = { preview_url: 'https://preview.example.com/app', preview_title: 'Preview app' };
  const consoleContext = { runtime_state: 'build_failed', runtime_message: 'Vite compile failed', level: 'error', message: 'Build exploded' };
  const controller = promptContextHelpers.createController({
    enabled: true,
    promptEl,
    selectionChip,
    screenshotChip,
    previewChip,
    consoleChip,
    attachedSelectionChip,
    attachedSelectionClearButton,
    attachedScreenshotChip,
    attachedScreenshotClearButton,
    attachedPreviewChip,
    attachedPreviewClearButton,
    attachedConsoleChip,
    attachedConsoleClearButton,
    getSelectionContext: () => selection,
    getScreenshotContext: () => screenshot,
    getPreviewContext: () => preview,
    getConsoleContext: () => consoleContext,
  });

  controller.bind();
  assert.deepEqual(controller.getRequestContext?.(), {
    selection: null,
    screenshot: null,
    preview: null,
    console: null,
  });
  assert.equal(attachedSelectionChip.hidden, true);
  assert.equal(attachedScreenshotChip.hidden, true);
  assert.equal(attachedPreviewChip.hidden, true);
  assert.equal(attachedConsoleChip.hidden, true);

  selectionChip.click();
  assert.deepEqual(controller.getRequestContext?.(), {
    selection,
    screenshot: null,
    preview: null,
    console: null,
  });
  assert.equal(attachedSelectionChip.hidden, false);
  assert.match(attachedSelectionChip.textContent, /Next send UI: Sidebar toggle/);
  assert.equal(attachedSelectionClearButton.hidden, false);

  screenshotChip.click();
  assert.match(promptEl.value, /Latest screenshot: viewport capture • screenshot-1776958241575-66c1c292\.png/);
  assert.match(promptEl.value, /Artifact path: \/tmp\/screenshot-1776958241575-66c1c292\.png/);
  previewChip.click();
  consoleChip.click();
  assert.deepEqual(controller.getRequestContext?.(), {
    selection,
    screenshot,
    preview,
    console: consoleContext,
  });
  assert.equal(attachedScreenshotChip.hidden, false);
  assert.match(attachedScreenshotChip.textContent, /Next send screenshot: viewport capture • screenshot 66c1c292/);
  assert.doesNotMatch(attachedScreenshotChip.textContent, /1776958241575/);
  assert.equal(attachedScreenshotClearButton.hidden, false);
  assert.equal(attachedPreviewChip.hidden, false);
  assert.match(attachedPreviewChip.textContent, /Next send preview: Preview app/);
  assert.equal(attachedPreviewClearButton.hidden, false);
  assert.equal(attachedConsoleChip.hidden, false);
  assert.match(attachedConsoleChip.textContent, /Next send console: build_failed/);
  assert.equal(attachedConsoleClearButton.hidden, false);

  attachedSelectionClearButton.click();
  attachedPreviewClearButton.click();
  assert.deepEqual(controller.getRequestContext?.(), {
    selection: null,
    screenshot,
    preview: null,
    console: consoleContext,
  });
  assert.equal(attachedSelectionChip.hidden, true);
  assert.equal(attachedSelectionClearButton.hidden, true);
  assert.equal(attachedPreviewChip.hidden, true);
  assert.equal(attachedPreviewClearButton.hidden, true);

  controller.clearRequestContext?.();
  assert.deepEqual(controller.getRequestContext?.(), {
    selection: null,
    screenshot: null,
    preview: null,
    console: null,
  });
  assert.equal(attachedScreenshotChip.hidden, true);
  assert.equal(attachedScreenshotClearButton.hidden, true);
  assert.equal(attachedConsoleChip.hidden, true);
  assert.equal(attachedConsoleClearButton.hidden, true);
});

test('controller renders selected media-editor clip as next-send clip context', () => {
  const promptEl = createElement();
  const selectionChip = createElement();
  const attachedSelectionChip = createElement();
  attachedSelectionChip.hidden = true;
  const attachedSelectionClearButton = createElement();
  attachedSelectionClearButton.hidden = true;
  const selection = {
    selectionType: 'media_editor_clip',
    label: 'Opening title',
    selector: 'media-editor-clip:clip_1',
    tagName: 'media-editor-clip',
    clip_id: 'clip_1',
    track_id: 'track_text',
    clip_kind: 'text',
    start_ms: 250,
    duration_ms: 1750,
  };
  const controller = promptContextHelpers.createController({
    enabled: true,
    promptEl,
    selectionChip,
    attachedSelectionChip,
    attachedSelectionClearButton,
    getSelectionContext: () => selection,
  });

  controller.bind();
  selectionChip.click();

  assert.equal(attachedSelectionChip.hidden, false);
  assert.equal(attachedSelectionChip.textContent, 'Next send clip: Opening title, 250–2000ms');
  assert.match(promptEl.value, /\[Media editor context\]/);
  assert.match(promptEl.value, /Selected clip: Opening title/);
  assert.deepEqual(controller.getRequestContext?.().selection, selection);
});
