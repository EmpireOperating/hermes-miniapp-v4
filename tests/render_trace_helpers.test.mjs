import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const renderTraceHelpers = require('../static/render_trace_helpers.js');

function createHarness({
  href = 'https://example.test/app?render_trace=1',
  search = '?render_trace=1',
  stored = null,
} = {}) {
  const state = { enabled: false };
  const storage = new Map();
  if (stored != null) {
    storage.set('hermes_render_trace_debug', stored);
  }
  const localStorageRef = {
    getItem(key) {
      return storage.has(key) ? storage.get(key) : null;
    },
    setItem(key, value) {
      storage.set(key, String(value));
    },
    removeItem(key) {
      storage.delete(key);
    },
  };
  const badge = {
    hidden: true,
    dataset: {},
    attributes: new Map(),
    textContent: '',
    title: '',
    setAttribute(name, value) {
      this.attributes.set(name, String(value));
    },
  };
  const replaceCalls = [];
  const infoCalls = [];

  const windowObject = {
    location: { href, search },
    history: {
      state: { session: 1 },
      replaceState(stateArg, titleArg, urlArg) {
        replaceCalls.push([stateArg, titleArg, urlArg]);
      },
    },
  };

  const controller = renderTraceHelpers.createController({
    windowObject,
    localStorageRef,
    renderTraceBadge: badge,
    storageKey: 'hermes_render_trace_debug',
    getRenderTraceDebugEnabled: () => state.enabled,
    setRenderTraceDebugEnabledState: (value) => {
      state.enabled = Boolean(value);
    },
    consoleRef: {
      info(...args) {
        infoCalls.push(args);
      },
    },
  });

  return {
    controller,
    state,
    storage,
    badge,
    replaceCalls,
    infoCalls,
  };
}

test('resolveRenderTraceDebugEnabled honors query param and persists preference', () => {
  const harness = createHarness({ href: 'https://example.test/app?render_trace=1', search: '?render_trace=1' });

  const enabled = harness.controller.resolveRenderTraceDebugEnabled();

  assert.equal(enabled, true);
  assert.equal(harness.storage.get('hermes_render_trace_debug'), '1');
});

test('setRenderTraceDebugEnabled updates state, badge, storage, and URL', () => {
  const harness = createHarness({ href: 'https://example.test/app?foo=1', search: '?foo=1' });

  harness.controller.setRenderTraceDebugEnabled(true);

  assert.equal(harness.state.enabled, true);
  assert.equal(harness.badge.hidden, false);
  assert.equal(harness.badge.dataset.enabled, 'true');
  assert.equal(harness.badge.attributes.get('aria-pressed'), 'true');
  assert.equal(harness.storage.get('hermes_render_trace_debug'), '1');
  assert.equal(harness.replaceCalls.length, 1);
  assert.match(harness.replaceCalls[0][2], /render_trace=1/);
});

test('handleRenderTraceBadgeClick toggles state and logs transitions', () => {
  const harness = createHarness({ href: 'https://example.test/app', search: '' });

  harness.controller.handleRenderTraceBadgeClick();
  harness.controller.handleRenderTraceBadgeClick();

  assert.equal(harness.infoCalls.length, 2);
  assert.equal(harness.infoCalls[0][0], '[render-trace] debug-enabled');
  assert.equal(harness.infoCalls[1][0], '[render-trace] debug-disabled');
});

test('renderTraceLog only logs when enabled', () => {
  const harness = createHarness({ href: 'https://example.test/app', search: '' });

  harness.controller.renderTraceLog('before');
  harness.controller.setRenderTraceDebugEnabled(true, { persist: false, updateUrl: false });
  harness.controller.renderTraceLog('after', { count: 1 });

  const traceEntries = harness.infoCalls.filter((entry) => String(entry[0]).includes('[render-trace]'));
  assert.equal(traceEntries.length, 1);
  assert.equal(traceEntries[0][0], '[render-trace] after');
  assert.deepEqual(traceEntries[0][1], { count: 1 });
});

test('renderBody supports fenced and non-fenced text rendering', () => {
  const container = { innerHTML: '' };
  const cleanDisplayTextFn = (value) => String(value || '').trim();
  const escapeHtmlFn = (value) => String(value || '').replace(/[<>&]/g, (char) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[char]));

  renderTraceHelpers.renderBody(container, 'hello\nworld', { cleanDisplayTextFn, escapeHtmlFn });
  assert.equal(container.innerHTML, 'hello<br>world');

  renderTraceHelpers.renderBody(container, '```js\nconst x = 1;\n```', { cleanDisplayTextFn, escapeHtmlFn });
  assert.match(container.innerHTML, /<pre class="code-block" data-lang="js"><code>const x = 1;<\/code><\/pre>/);
});

test('renderToolTraceBody builds expandable trace and syncs collapsed state on toggle', () => {
  function createNode(tagName) {
    return {
      tagName,
      className: '',
      textContent: '',
      innerHTML: '',
      open: false,
      children: [],
      listeners: {},
      appendChild(child) {
        this.children.push(child);
      },
      addEventListener(name, cb) {
        this.listeners[name] = cb;
      },
    };
  }

  const documentObject = {
    createElement(tagName) {
      return createNode(tagName);
    },
  };

  const container = createNode('div');
  const message = { body: 'step 1\nstep 2', pending: true, collapsed: false };
  renderTraceHelpers.renderToolTraceBody(container, message, {
    cleanDisplayTextFn: (value) => String(value || ''),
    documentObject,
  });

  assert.equal(container.children.length, 1);
  const details = container.children[0];
  assert.equal(details.className, 'tool-trace');
  assert.equal(details.children[0].textContent, 'Tool activity (2) · live');

  details.open = false;
  details.listeners.toggle();
  assert.equal(message.collapsed, true);
});

test('roleLabelForMessage maps role variants and honors operator display name', () => {
  assert.equal(renderTraceHelpers.roleLabelForMessage({ role: 'operator' }, { operatorDisplayName: 'Lemon' }), 'Lemon');
  assert.equal(renderTraceHelpers.roleLabelForMessage({ role: 'assistant' }), 'Hermes');
  assert.equal(renderTraceHelpers.roleLabelForMessage({ role: 'tool' }), 'Tool');
  assert.equal(renderTraceHelpers.roleLabelForMessage({ role: 'system' }), 'System');
});

test('messageVariantForRole and shouldSkipMessageRender map role/body contracts', () => {
  assert.equal(renderTraceHelpers.messageVariantForRole('user'), 'operator');
  assert.equal(renderTraceHelpers.messageVariantForRole('assistant'), 'assistant');
  assert.equal(renderTraceHelpers.messageVariantForRole('tool'), 'tool');
  assert.equal(renderTraceHelpers.messageVariantForRole('unknown'), 'system');

  assert.equal(renderTraceHelpers.shouldSkipMessageRender({ role: 'assistant', renderedBody: '', pending: false }), true);
  assert.equal(renderTraceHelpers.shouldSkipMessageRender({ role: 'tool', renderedBody: '', pending: false }), false);
  assert.equal(renderTraceHelpers.shouldSkipMessageRender({ role: 'assistant', renderedBody: 'ok', pending: false }), false);
});

test('applyMessageMeta sets role, variant class, pending class, and timestamps', () => {
  const roleNode = { textContent: '' };
  const timeNode = { textContent: '' };
  const node = {
    dataset: {},
    classList: {
      values: [],
      add(value) {
        this.values.push(value);
      },
    },
    querySelector(selector) {
      if (selector === '.message__role') return roleNode;
      if (selector === '.message__time') return timeNode;
      return null;
    },
  };

  renderTraceHelpers.applyMessageMeta(node, { pending: true, created_at: '2026-01-01T00:00:00Z' }, {
    role: 'assistant',
    variant: 'assistant',
    roleLabelForMessageFn: () => 'Hermes',
    formatMessageTimeFn: () => 'now',
  });

  assert.deepEqual(node.classList.values, ['message--assistant', 'message--pending']);
  assert.equal(node.dataset.role, 'assistant');
  assert.equal(roleNode.textContent, 'Hermes');
  assert.equal(timeNode.textContent, 'now');
});

test('renderMessageContent dispatches tool vs regular body renderers', () => {
  const bodyNode = { id: 'body' };
  const calls = [];
  const node = {
    querySelector(selector) {
      if (selector === '.message__body') return bodyNode;
      return null;
    },
  };

  renderTraceHelpers.renderMessageContent(node, { role: 'tool' }, 'ignored', {
    renderToolTraceBodyFn: (target, message) => calls.push(['tool', target, message.role]),
    renderBodyFn: (target, body) => calls.push(['body', target, body]),
  });
  renderTraceHelpers.renderMessageContent(node, { role: 'assistant' }, 'hello', {
    renderToolTraceBodyFn: (target, message) => calls.push(['tool', target, message.role]),
    renderBodyFn: (target, body) => calls.push(['body', target, body]),
  });

  assert.deepEqual(calls, [
    ['tool', bodyNode, 'tool'],
    ['body', bodyNode, 'hello'],
  ]);
});

test('messageStableKey and messageStableKeyForPendingState produce stable id/local keys', () => {
  assert.equal(renderTraceHelpers.messageStableKey({ id: 9, role: 'assistant' }, 3), 'id:9');
  assert.equal(
    renderTraceHelpers.messageStableKey({ role: 'assistant', pending: true, created_at: 't1' }, 2),
    'local:assistant:pending:t1:2',
  );
  assert.equal(
    renderTraceHelpers.messageStableKeyForPendingState({ role: 'assistant', created_at: 't1' }, 2, true),
    'local:assistant:pending:t1:2',
  );
  assert.equal(
    renderTraceHelpers.messageStableKeyForPendingState({ id: 10, role: 'assistant' }, 2, true),
    'id:10',
  );
});

test('upsertMessageNode composes skip/meta/content pipeline via injected deps', () => {
  const calls = [];
  const node = { className: '' };
  const message = { role: 'assistant', body: 'hello', pending: false };

  const rendered = renderTraceHelpers.upsertMessageNode(node, message, {
    cleanDisplayTextFn: (value) => String(value || '').trim(),
    shouldSkipMessageRenderFn: ({ role, renderedBody, pending }) => {
      calls.push(['skip', role, renderedBody, pending]);
      return false;
    },
    messageVariantForRoleFn: (role) => {
      calls.push(['variant', role]);
      return 'assistant';
    },
    applyMessageMetaFn: (target, msg, role, variant) => {
      calls.push(['meta', target, msg, role, variant]);
    },
    renderMessageContentFn: (target, msg, renderedBody) => {
      calls.push(['content', target, msg, renderedBody]);
    },
  });

  assert.equal(rendered, true);
  assert.equal(node.className, 'message');
  assert.deepEqual(calls[0], ['skip', 'assistant', 'hello', false]);
  assert.deepEqual(calls[1], ['variant', 'assistant']);
  assert.equal(calls[2][0], 'meta');
  assert.equal(calls[3][0], 'content');
});

test('createMessageNode and appendMessages attach stable keys and skip null nodes', () => {
  const templateElement = {
    content: {
      firstElementChild: {
        cloneNode() {
          return { dataset: {} };
        },
      },
    },
  };

  const created = renderTraceHelpers.createMessageNode({ id: 5, role: 'assistant' }, {
    index: 1,
    templateElement,
    upsertMessageNodeFn: () => true,
    messageStableKeyFn: () => 'id:5',
  });
  assert.ok(created);
  assert.equal(created.dataset.messageKey, 'id:5');
  assert.equal(created.dataset.messageId, '5');

  const fragment = {
    children: [],
    appendChild(node) {
      this.children.push(node);
    },
  };

  renderTraceHelpers.appendMessages(fragment, [{ id: 1 }, { id: 2 }, { id: 3 }], {
    startIndex: 10,
    createMessageNodeFn: (message, { index }) => {
      if (message.id === 2) return null;
      return { id: message.id, index };
    },
  });

  assert.deepEqual(fragment.children, [
    { id: 1, index: 10 },
    { id: 3, index: 12 },
  ]);
});

test('findMessageNodeByKey returns newest matching key including alternate key', () => {
  const nodes = [
    { dataset: { messageKey: 'old' }, name: 'old' },
    { dataset: { messageKey: 'alt' }, name: 'alt' },
    { dataset: { messageKey: 'target' }, name: 'target' },
  ];
  const container = {
    querySelectorAll(selector) {
      assert.equal(selector, '.message--assistant');
      return nodes;
    },
  };

  assert.equal(renderTraceHelpers.findMessageNodeByKey(container, '.message--assistant', 'target')?.name, 'target');
  assert.equal(renderTraceHelpers.findMessageNodeByKey(container, '.message--assistant', 'missing', 'alt')?.name, 'alt');
  assert.equal(renderTraceHelpers.findMessageNodeByKey(container, '.message--assistant', 'missing'), null);
});

test('findLatestHistoryMessageByRole and findLatestAssistantHistoryMessage derive latest targets with alternate keys', () => {
  const history = [
    { role: 'assistant', body: 'a1', pending: false, created_at: 't1' },
    { role: 'tool', body: 'tool1', pending: true, created_at: 't2' },
    { role: 'hermes', body: 'a2', pending: true, created_at: 't3' },
    { role: 'tool', body: 'tool2', pending: false, created_at: 't4' },
  ];

  const latestTool = renderTraceHelpers.findLatestHistoryMessageByRole(history, 'tool');
  assert.equal(latestTool?.index, 3);
  assert.equal(latestTool?.key, 'local:tool:sent:t4:3');
  assert.equal(latestTool?.alternatePendingKey, 'local:tool:pending:t4:3');

  const latestAssistant = renderTraceHelpers.findLatestAssistantHistoryMessage(history, { pendingOnly: true });
  assert.equal(latestAssistant?.index, 2);
  assert.equal(latestAssistant?.key, 'local:hermes:pending:t3:2');
  assert.equal(latestAssistant?.alternatePendingKey, 'local:hermes:sent:t3:2');
});

test('patchVisiblePendingAssistant updates body and pending class when stream target is patchable', () => {
  const bodyNode = { textContent: '' };
  const toggles = [];
  const node = {
    dataset: { messageKey: 'local:hermes:pending:t3:2' },
    classList: {
      toggle(name, enabled) {
        toggles.push([name, Boolean(enabled)]);
      },
    },
    querySelector(selector) {
      if (selector === '.message__body') return bodyNode;
      return null;
    },
  };

  const renderCalls = [];
  const result = renderTraceHelpers.patchVisiblePendingAssistant({
    chatId: 4,
    activeChatId: 4,
    phase: 'streaming',
    nextBody: 'updated',
    pendingState: true,
    messagesContainer: {},
    history: [{ role: 'hermes' }],
  }, {
    isPatchPhaseAllowedFn: () => true,
    findLatestAssistantHistoryMessageFn: () => ({ key: 'local:hermes:pending:t3:2', alternatePendingKey: 'local:hermes:sent:t3:2' }),
    findMessageNodeByKeyFn: () => node,
    renderTraceLogFn: () => {},
    preserveViewportDuringUiMutationFn: (fn) => fn(),
    renderBodyFn: (target, body) => renderCalls.push([target, body]),
  });

  assert.equal(result, true);
  assert.deepEqual(renderCalls, [[bodyNode, 'updated']]);
  assert.deepEqual(toggles, [['message--pending', true]]);
});

test('patchVisibleToolTrace updates tool trace body/time and handles no-target success', () => {
  const bodyNode = { id: 'body' };
  const timeNode = { textContent: '' };
  const toggles = [];
  const node = {
    dataset: { messageKey: 'tool-key' },
    classList: {
      toggle(name, enabled) {
        toggles.push([name, Boolean(enabled)]);
      },
    },
    querySelector(selector) {
      if (selector === '.message__body') return bodyNode;
      if (selector === '.message__time') return timeNode;
      return null;
    },
  };

  const toolMessage = { created_at: '2026-01-01T00:00:00Z', pending: false };
  const calls = [];
  const patched = renderTraceHelpers.patchVisibleToolTrace({
    chatId: 9,
    activeChatId: 9,
    phase: 'streaming',
    messagesContainer: {},
    history: [{ role: 'tool' }],
  }, {
    isPatchPhaseAllowedFn: () => true,
    findLatestHistoryMessageByRoleFn: () => ({
      key: 'tool-key',
      alternatePendingKey: 'tool-alt',
      message: toolMessage,
    }),
    findMessageNodeByKeyFn: () => node,
    renderTraceLogFn: () => {},
    preserveViewportDuringUiMutationFn: (fn) => fn(),
    renderToolTraceBodyFn: (target, message) => calls.push(['body', target, message]),
    formatMessageTimeFn: () => 'formatted',
  });

  assert.equal(patched, true);
  assert.deepEqual(calls, [['body', bodyNode, toolMessage]]);
  assert.equal(timeNode.textContent, 'formatted');
  assert.deepEqual(toggles, [['message--pending', false]]);

  const noTarget = renderTraceHelpers.patchVisibleToolTrace({
    chatId: 9,
    activeChatId: 9,
    phase: 'streaming',
    messagesContainer: {},
    history: [],
  }, {
    isPatchPhaseAllowedFn: () => true,
    findLatestHistoryMessageByRoleFn: () => null,
    findMessageNodeByKeyFn: () => null,
    renderTraceLogFn: () => {},
    preserveViewportDuringUiMutationFn: (fn) => fn(),
    renderToolTraceBodyFn: () => {},
    formatMessageTimeFn: () => 'formatted',
  });
  assert.equal(noTarget, true);
});
