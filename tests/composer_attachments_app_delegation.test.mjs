import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const appJsUrl = new URL('../static/app.js', import.meta.url);
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const templateSource = readFileSync(join(__dirname, '..', 'templates', 'app.html'), 'utf8');

function indexOfFragment(fragment) {
  const index = templateSource.indexOf(fragment);
  assert.notEqual(index, -1, `expected template fragment: ${fragment}`);
  return index;
}

test('template exposes generic composer attachment controls ahead of the prompt actions', () => {
  const formIndex = indexOfFragment('<form id="chat-form" class="composer">');
  const attachmentsWrapIndex = indexOfFragment('<div id="composer-attachments" class="composer-attachments" hidden></div>');
  const textareaIndex = indexOfFragment('<textarea id="prompt" name="prompt" rows="4" placeholder="Type a message…"');
  const inputIndex = indexOfFragment('<input id="attachment-input" name="attachment" type="file" accept="image/*,.pdf,.txt,.md,.json,.csv,.tsv,.log,.yaml,.yml" hidden>');
  const actionsIndex = indexOfFragment('<div class="composer__actions">');
  const attachButtonIndex = indexOfFragment('<button id="attachment-button" type="button" class="action-button action-button--subtle">Attach</button>');
  const sendButtonIndex = indexOfFragment('<button id="send-button" type="submit">Send</button>');

  assert.ok(attachmentsWrapIndex > formIndex, 'attachment chips should live inside the composer form');
  assert.ok(textareaIndex > attachmentsWrapIndex, 'attachment chip row should appear before the textarea');
  assert.ok(inputIndex > textareaIndex, 'hidden attachment input should be bound after the textarea');
  assert.ok(actionsIndex > inputIndex, 'composer actions should still render after the input');
  assert.ok(attachButtonIndex > actionsIndex, 'attach button should render in the composer action row');
  assert.ok(sendButtonIndex > attachButtonIndex, 'send button should remain after attach button');
});

test('app.js wires generic composer attachments through upload, chips, and send success clearing', async () => {
  const source = await readFile(appJsUrl, 'utf8');

  assert.ok(
    source.includes('const composerAttachmentsEl = document.getElementById("composer-attachments");')
      && source.includes('const attachmentInputEl = document.getElementById("attachment-input");')
      && source.includes('const attachmentButton = document.getElementById("attachment-button");'),
    'app.js should bind the composer attachment DOM controls',
  );
  assert.ok(
    source.includes('let composerAttachments = [];')
      && source.includes('let composerAttachmentChatId = null;'),
    'app.js should keep attachment state scoped to the active chat',
  );
  assert.ok(
    source.includes('function renderComposerAttachments() {')
      && source.includes('composerAttachmentsEl.hidden = !attachments.length;')
      && source.includes('attachmentButton?.setAttribute("aria-pressed", attachments.length ? "true" : "false");'),
    'app.js should render attachment chips and reflect attachment state on the button',
  );
  assert.ok(
    source.includes('async function prepareComposerAttachmentForUpload(file) {')
      && source.includes('const COMPOSER_IMAGE_TARGET_BYTES = 850 * 1024;')
      && source.includes('const COMPOSER_IMAGE_COMPRESSION_THRESHOLD_BYTES = COMPOSER_IMAGE_TARGET_BYTES;')
      && source.includes('for (const step of COMPOSER_IMAGE_COMPRESSION_STEPS)')
      && source.includes('compressedBlob.size <= COMPOSER_IMAGE_TARGET_BYTES')
      && source.includes('await prepareComposerAttachmentForUpload(file)')
      && source.includes('canvas.toBlob')
      && source.includes('image/jpeg'),
    'app.js should downscale large mobile image selections before uploading them',
  );
  assert.ok(
    source.includes('async function uploadComposerAttachment(file) {')
      && source.includes('const response = await fetch("/api/chats/upload", {')
      && source.includes('composerAttachments = [attachment];'),
    'app.js should upload composer attachments through /api/chats/upload and store returned metadata',
  );
  assert.ok(
    source.includes('attachmentButton.addEventListener("click", () => {')
      && source.includes('appendSystemMessage("Open a chat before attaching a file.");')
      && source.includes('attachmentInputEl.addEventListener("change", async () => {'),
    'app.js should guard attach clicks until a chat is open and react to file selection changes',
  );
  assert.ok(
    source.includes('const sendSucceeded = await sendPrompt(promptEl.value, { attachments });')
      && source.includes('if (sendSucceeded) {')
      && source.includes('clearComposerAttachments();'),
    'composer submit should pass attachment metadata into sendPrompt and clear it only after a successful send',
  );
});
