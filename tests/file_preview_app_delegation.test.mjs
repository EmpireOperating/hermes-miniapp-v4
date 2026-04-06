import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const appJsUrl = new URL('../static/app.js', import.meta.url);

function extractFunctionBody(source, functionName) {
  const fnPattern = new RegExp(
    String.raw`(?:async\s+)?function\s+${functionName}\s*\([^)]*\)\s*\{([\s\S]*?)\n\}`,
    'm',
  );
  const match = source.match(fnPattern);
  assert.ok(match, `${functionName} wrapper should exist in app.js`);
  return match[1] || '';
}

test('app.js file-preview wrappers keep delegating to filePreviewController', async () => {
  const source = await readFile(appJsUrl, 'utf8');

  const delegateExpectations = [
    ['cloneFilePreviewRequest', 'filePreviewController.cloneFilePreviewRequest(previewRequest)'],
    ['syncFilePreviewExpandControls', 'filePreviewController.syncFilePreviewExpandControls(preview, options)'],
    ['resetFilePreviewState', 'filePreviewController.resetFilePreviewState()'],
    ['closeFilePreviewModal', 'filePreviewController.closeFilePreviewModal()'],
    ['createFilePreviewLineNode', 'filePreviewController.createFilePreviewLineNode(row, options)'],
    ['captureFilePreviewViewportAnchor', 'filePreviewController.captureFilePreviewViewportAnchor()'],
    ['restoreFilePreviewViewportAnchor', 'filePreviewController.restoreFilePreviewViewportAnchor(anchor)'],
    ['canIncrementallyExpandFilePreview', 'filePreviewController.canIncrementallyExpandFilePreview(previousPreview, nextPreview)'],
    ['expandFilePreviewInPlace', 'filePreviewController.expandFilePreviewInPlace(previousPreview, nextPreview)'],
    ['renderFilePreview', 'filePreviewController.renderFilePreview(preview, options)'],
    ['showFilePreviewStatus', 'filePreviewController.showFilePreviewStatus(message)'],
    ['openFilePreview', 'filePreviewController.openFilePreview(previewRequest, options)'],
    ['openFilePreviewByRef', 'filePreviewController.openFilePreviewByRef(refId)'],
    ['openFilePreviewByPath', 'filePreviewController.openFilePreviewByPath(pathText, options)'],
    ['requestFilePreviewExpansion', 'filePreviewController.requestFilePreviewExpansion(direction)'],
    ['requestFullFilePreview', 'filePreviewController.requestFullFilePreview()'],
    ['handleMessageFileRefTouchStart', 'filePreviewController.handleMessageFileRefTouchStart(event)'],
    ['handleMessageFileRefTouchMove', 'filePreviewController.handleMessageFileRefTouchMove(event)'],
    ['cancelPendingMessageFileRefTouch', 'filePreviewController.cancelPendingMessageFileRefTouch()'],
    ['handleMessageFileRefClick', 'filePreviewController.handleMessageFileRefClick(event)'],
  ];

  for (const [fnName, delegatedCall] of delegateExpectations) {
    const body = extractFunctionBody(source, fnName);
    assert.match(
      body,
      new RegExp(delegatedCall.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
      `${fnName} should delegate to controller`,
    );
  }
});
