import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const renderTraceTextHelpers = require('../static/render_trace_text_helpers.js');

test('renderBody supports fenced and non-fenced text rendering', () => {
  const container = { innerHTML: '' };
  const cleanDisplayTextFn = (value) => String(value || '').trim();
  const escapeHtmlFn = (value) => String(value || '').replace(/[<>&]/g, (char) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[char]));

  renderTraceTextHelpers.renderBody(container, 'hello\nworld', { cleanDisplayTextFn, escapeHtmlFn });
  assert.equal(container.innerHTML, 'hello<br>world');

  renderTraceTextHelpers.renderBody(container, '```js\nconst x = 1;\n```', { cleanDisplayTextFn, escapeHtmlFn });
  assert.match(container.innerHTML, /<pre class="code-block" data-lang="js"><code>const x = 1;<\/code><\/pre>/);
});

test('renderBody linkifies known file refs in plain text', () => {
  const container = { innerHTML: '' };
  const cleanDisplayTextFn = (value) => String(value || '').trim();
  const escapeHtmlFn = (value) => String(value || '').replace(/[<>&]/g, (char) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[char]));

  renderTraceTextHelpers.renderBody(
    container,
    'Open /tmp/demo.py:12 please',
    {
      cleanDisplayTextFn,
      escapeHtmlFn,
      fileRefs: [{ ref_id: 'fr_1', raw_text: '/tmp/demo.py:12', resolved_path: '/tmp/demo.py', line_start: 12 }],
    },
  );

  assert.match(container.innerHTML, /data-file-ref-id="fr_1"/);
  assert.match(container.innerHTML, /data-file-path="\/tmp\/demo.py"/);
  assert.match(container.innerHTML, /data-file-line-start="12"/);
  assert.match(container.innerHTML, /message-file-ref/);
});

test('renderBody uses file_ref.path as a fallback when resolved_path is absent', () => {
  const container = { innerHTML: '' };
  const cleanDisplayTextFn = (value) => String(value || '').trim();
  const escapeHtmlFn = (value) => String(value || '').replace(/[<>&]/g, (char) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[char]));

  renderTraceTextHelpers.renderBody(
    container,
    'See static/runtime_history_helpers.js:12',
    {
      cleanDisplayTextFn,
      escapeHtmlFn,
      fileRefs: [{
        ref_id: 'fr_path_only',
        raw_text: 'static/runtime_history_helpers.js:12',
        path: '/home/hermes-agent/workspace/active/hermes_miniapp_v4/static/runtime_history_helpers.js',
        line_start: 12,
      }],
    },
  );

  assert.match(container.innerHTML, /data-file-ref-id="fr_path_only"/);
  assert.match(container.innerHTML, /data-file-path="\/home\/hermes-agent\/workspace\/active\/hermes_miniapp_v4\/static\/runtime_history_helpers\.js"/);
  assert.match(container.innerHTML, /data-file-line-start="12"/);
});

test('renderBody preserves file-ref clickability across fenced blocks', () => {
  const container = { innerHTML: '' };
  const cleanDisplayTextFn = (value) => String(value || '').trim();
  const escapeHtmlFn = (value) => String(value || '').replace(/[<>&]/g, (char) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[char]));

  renderTraceTextHelpers.renderBody(
    container,
    'See miniapp_config.py:1\n```js\nconst path = "miniapp_config.py:1";\n```',
    {
      cleanDisplayTextFn,
      escapeHtmlFn,
      fileRefs: [{ ref_id: 'fr_2', raw_text: 'miniapp_config.py:1' }],
    },
  );

  assert.match(container.innerHTML, /data-file-ref-id="fr_2"/);
  assert.match(container.innerHTML, /<pre class="code-block" data-lang="js"><code>/);
});

test('renderBody does not linkify plain text paths without metadata or allowed roots', () => {
  const container = { innerHTML: '' };
  const cleanDisplayTextFn = (value) => String(value || '').trim();
  const escapeHtmlFn = (value) => String(value || '').replace(/[<>&]/g, (char) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[char]));

  renderTraceTextHelpers.renderBody(
    container,
    'Try /workspace/hermes-miniapp-v4/miniapp_config.py:1 now',
    {
      cleanDisplayTextFn,
      escapeHtmlFn,
      fileRefs: null,
      allowedRoots: [],
    },
  );

  assert.doesNotMatch(container.innerHTML, /message-file-ref/);
  assert.match(container.innerHTML, /\/workspace\/hermes-miniapp-v4\/miniapp_config.py:1/);
});

test('renderBody does not linkify plain text paths without server metadata even when allowed roots are provided', () => {
  const container = { innerHTML: '' };
  const cleanDisplayTextFn = (value) => String(value || '').trim();
  const escapeHtmlFn = (value) => String(value || '').replace(/[<>&]/g, (char) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[char]));

  renderTraceTextHelpers.renderBody(
    container,
    'Open /workspace/hermes-miniapp-v4/miniapp_config.py:1 and /tmp/outside.py:1',
    {
      cleanDisplayTextFn,
      escapeHtmlFn,
      fileRefs: null,
      allowedRoots: ['/workspace/hermes-miniapp-v4'],
    },
  );

  assert.doesNotMatch(container.innerHTML, /message-file-ref/);
  assert.match(container.innerHTML, /\/workspace\/hermes-miniapp-v4\/miniapp_config.py:1/);
  assert.match(container.innerHTML, /\/tmp\/outside.py:1/);
});

test('renderBody does not linkify file-like text when metadata is absent', () => {
  const container = { innerHTML: '' };
  const cleanDisplayTextFn = (value) => String(value || '').trim();
  const escapeHtmlFn = (value) => String(value || '').replace(/[<>&]/g, (char) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[char]));

  renderTraceTextHelpers.renderBody(
    container,
    'Use src/routes/chat.py:22 and ./static/app.js#L90-L92 for this fix',
    {
      cleanDisplayTextFn,
      escapeHtmlFn,
      fileRefs: null,
    },
  );

  assert.doesNotMatch(container.innerHTML, /message-file-ref/);
  assert.match(container.innerHTML, /src\/routes\/chat.py:22/);
  assert.match(container.innerHTML, /\.\/static\/app.js#L90-L92/);
});

test('renderBody consumes refs once and preserves correct ref ids for repeated raw text', () => {
  const container = { innerHTML: '' };
  const cleanDisplayTextFn = (value) => String(value || '').trim();
  const escapeHtmlFn = (value) => String(value || '').replace(/[<>&]/g, (char) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[char]));

  renderTraceTextHelpers.renderBody(
    container,
    'Check /tmp/demo.py:90 then /tmp/demo.py:90 again',
    {
      cleanDisplayTextFn,
      escapeHtmlFn,
      fileRefs: [
        { ref_id: 'fr_first', raw_text: '/tmp/demo.py:90' },
        { ref_id: 'fr_second', raw_text: '/tmp/demo.py:90' },
      ],
    },
  );

  assert.match(container.innerHTML, /data-file-ref-id="fr_first"/);
  assert.match(container.innerHTML, /data-file-ref-id="fr_second"/);
  assert.match(container.innerHTML, /fr_first[\s\S]*fr_second/);
});

test('renderBody favors longest same-position match for overlapping refs like :9 vs :90', () => {
  const container = { innerHTML: '' };
  const cleanDisplayTextFn = (value) => String(value || '').trim();
  const escapeHtmlFn = (value) => String(value || '').replace(/[<>&]/g, (char) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[char]));

  renderTraceTextHelpers.renderBody(
    container,
    'Jump to /tmp/demo.py:90 now',
    {
      cleanDisplayTextFn,
      escapeHtmlFn,
      fileRefs: [
        { ref_id: 'fr_line9', raw_text: '/tmp/demo.py:9' },
        { ref_id: 'fr_line90', raw_text: '/tmp/demo.py:90' },
      ],
    },
  );

  assert.match(container.innerHTML, /data-file-ref-id="fr_line90"/);
  assert.doesNotMatch(container.innerHTML, /data-file-ref-id="fr_line9"[^\s\S]*\/tmp\/demo\.py:90/);
});

function createToolTraceNode(tagName) {
  return {
    tagName,
    className: '',
    textContent: '',
    innerHTML: '',
    open: false,
    children: [],
    listeners: {},
    parentNode: null,
    scrollTop: undefined,
    scrollHeight: undefined,
    clientHeight: undefined,
    appendChild(child) {
      child.parentNode = this;
      this.children.push(child);
      if (String(this.className || '') === 'tool-trace__lines') {
        const nextScrollHeight = Number(this.scrollHeight) || 0;
        this.scrollHeight = nextScrollHeight + 100;
        if (!Number.isFinite(Number(this.clientHeight))) {
          this.clientHeight = 200;
        }
      }
    },
    addEventListener(name, cb) {
      this.listeners[name] = cb;
    },
    querySelector(selector) {
      if (!String(selector || '').startsWith('.')) return null;
      const className = String(selector).slice(1);
      const stack = [...this.children];
      while (stack.length) {
        const current = stack.shift();
        if (String(current?.className || '') === className) {
          return current;
        }
        if (Array.isArray(current?.children) && current.children.length) {
          stack.unshift(...current.children);
        }
      }
      return null;
    },
  };
}



test('renderBody applies buildAttachmentUrlFn to attachment thumbnails and links', () => {
  const container = { innerHTML: '' };
  const cleanDisplayTextFn = (value) => String(value || '').trim();
  const escapeHtmlFn = (value) => String(value || '').replace(/[<>&]/g, (char) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[char]));

  renderTraceTextHelpers.renderBody(container, 'see attached', {
    cleanDisplayTextFn,
    escapeHtmlFn,
    buildAttachmentUrlFn: (url) => `${url}?chat_id=123&init_data=auth`,
    attachments: [
      {
        id: 'att_img',
        filename: 'screen.png',
        kind: 'image',
        content_type: 'image/png',
        size_bytes: 2048,
        preview_url: '/api/chats/attachments/att_img/content',
      },
    ],
  });

  assert.match(container.innerHTML, /href="\/api\/chats\/attachments\/att_img\/content\?chat_id=123&amp;init_data=auth"/);
  assert.match(container.innerHTML, /src="\/api\/chats\/attachments\/att_img\/content\?chat_id=123&amp;init_data=auth"/);
});
