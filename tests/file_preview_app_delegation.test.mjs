import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const appJsUrl = new URL('../static/app.js', import.meta.url);

function assertThinDelegate(source, functionName, delegatedCall) {
  const escapedCall = delegatedCall.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const fnPattern = new RegExp(
    String.raw`(?:async\s+)?function\s+${functionName}\s*\([^)]*\)\s*\{\s*return\s+${escapedCall}\s*;\s*\}`,
    'm',
  );
  assert.match(source, fnPattern, `${functionName} should delegate to controller`);
}

test('app.js file-preview wrappers keep delegating to filePreviewController', async () => {
  const source = await readFile(appJsUrl, 'utf8');

  assert.match(
    source,
    /function\s+createFilePreviewControllerDeps\s*\(\)\s*\{[\s\S]*?filePreviewClose,[\s\S]*?messagesEl,[\s\S]*?getCurrentFilePreview:[\s\S]*?setCurrentFilePreview:[\s\S]*?\};\s*\}/m,
    'app.js should build filePreviewController deps through createFilePreviewControllerDeps(...)',
  );
  assert.match(
    source,
    /function\s+createFilePreviewController\s*\(\)\s*\{\s*return\s+filePreviewHelpers\.createController\(createFilePreviewControllerDeps\(\)\);\s*\}/m,
    'app.js should instantiate filePreviewController through createFilePreviewController(...)',
  );
  assert.match(
    source,
    /const\s+filePreviewController\s*=\s*createLazyControllerProxy\(getFilePreviewController\);/m,
    'app.js should expose filePreviewController through the shared lazy proxy helper',
  );

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
    assertThinDelegate(source, fnName, delegatedCall);
  }
});
