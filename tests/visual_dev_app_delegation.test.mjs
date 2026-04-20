import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const appJsUrl = new URL('../static/app.js', import.meta.url);

test('app.js wires visual dev mode through a dedicated controller wrapper and boot sync hooks', async () => {
  const source = await readFile(appJsUrl, 'utf8');

  assert.ok(
    source.includes("visualDevModeHelpers: windowObject.HermesMiniappVisualDevMode || createDeferredControllerHelper('HermesMiniappVisualDevMode')")
      && source.includes("visualDevAttachHelpers: windowObject.HermesMiniappVisualDevAttach || createDeferredControllerHelper('HermesMiniappVisualDevAttach')")
      && source.includes("visualDevPromptContextHelpers: windowObject.HermesMiniappVisualDevPromptContext || createDeferredControllerHelper('HermesMiniappVisualDevPromptContext')"),
    'app.js should register HermesMiniappVisualDevMode, HermesMiniappVisualDevAttach, and HermesMiniappVisualDevPromptContext in the deferred helper registry',
  );
  assert.ok(
    source.includes('function createVisualDevControllerDeps() {')
      && source.includes('getIsAuthenticated: () => isAuthenticated,')
      && source.includes("apiGetJson: (url) => apiGetJson(url)"),
    'app.js should isolate visual dev wiring in createVisualDevControllerDeps(...)',
  );
  assert.ok(
    source.includes('function createVisualDevController() {')
      && source.includes('return visualDevModeHelpers.createController(createVisualDevControllerDeps());'),
    'app.js should instantiate visualDevController through createVisualDevController(...)',
  );
  assert.ok(
    source.includes('function createVisualDevPromptContextControllerDeps() {')
      && source.includes('getSelectionContext: () => visualDevController.getActiveContext?.().selection || null,')
      && source.includes('getScreenshotContext: () => visualDevController.getActiveContext?.().screenshot || null,')
      && source.includes('getPreviewContext: () => visualDevController.getActiveContext?.().preview || null,')
      && source.includes('getConsoleContext: () => visualDevController.getActiveContext?.().console || null,')
      && source.includes('notifyInput: (value) => {')
      && source.includes("setDraft(activeChatId, value || '');"),
    'app.js should expose a prompt-context controller that can pull visual-dev context into the composer draft',
  );
  assert.ok(
    source.includes('getVisualDevRequestContext: () => visualDevPromptContextController.getRequestContext?.() || null,')
      && source.includes('clearVisualDevRequestContext: () => visualDevPromptContextController.clearRequestContext?.(),'),
    'app.js should pass explicit visual-dev request context into the stream controller deps',
  );
  assert.ok(
    source.includes('const visualDevComposerSelectionChip = document.getElementById("visual-dev-composer-selection-chip");')
      && source.includes('const visualDevComposerScreenshotChip = document.getElementById("visual-dev-composer-screenshot-chip");')
      && source.includes('const visualDevComposerPreviewChip = document.getElementById("visual-dev-composer-preview-chip");')
      && source.includes('const visualDevComposerConsoleChip = document.getElementById("visual-dev-composer-console-chip");')
      && source.includes('const visualDevAttachedSelectionChip = document.getElementById("visual-dev-attached-selection-chip");')
      && source.includes('const visualDevAttachedSelectionClearButton = document.getElementById("visual-dev-attached-selection-clear");')
      && source.includes('const visualDevAttachedScreenshotChip = document.getElementById("visual-dev-attached-screenshot-chip");')
      && source.includes('const visualDevAttachedScreenshotClearButton = document.getElementById("visual-dev-attached-screenshot-clear");')
      && source.includes('const visualDevAttachedPreviewChip = document.getElementById("visual-dev-attached-preview-chip");')
      && source.includes('const visualDevAttachedPreviewClearButton = document.getElementById("visual-dev-attached-preview-clear");')
      && source.includes('const visualDevAttachedConsoleChip = document.getElementById("visual-dev-attached-console-chip");')
      && source.includes('const visualDevAttachedConsoleClearButton = document.getElementById("visual-dev-attached-console-clear");')
      && source.includes('inspectButton: visualDevInspectButton,')
      && source.includes('screenshotButton: visualDevScreenshotButton,')
      && source.includes('logsButton: visualDevLogsButton,')
      && source.includes('composerSelectionChip: visualDevComposerSelectionChip,')
      && source.includes('composerScreenshotChip: visualDevComposerScreenshotChip,')
      && source.includes('composerPreviewChip: visualDevComposerPreviewChip,')
      && source.includes('composerConsoleChip: visualDevComposerConsoleChip,'),
    'app.js should wire inspect/screenshot/log toolbar controls and composer context chips into the visual-dev controller deps',
  );
  assert.ok(
    source.includes('visualDevAttachController.bind();')
      && source.includes('visualDevPromptContextController.bind();')
      && source.includes('await visualDevController.bootstrap();')
      && source.includes('await visualDevAttachController.refreshUi();'),
    'bootstrap should bind visual dev attach controls and prompt-context chips, then refresh visual-dev state/UI',
  );
  assert.ok(
    source.includes('visualDevController.syncActiveChatSession();'),
    'active-chat changes should resync preview ownership through the visualDevController',
  );
});
