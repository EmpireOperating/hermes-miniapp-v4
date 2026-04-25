import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const renderTraceMessageHelpers = require('../static/render_trace_message_helpers.js');

function createToolTraceNode(tagName = 'div') {
  const node = {
    tagName: String(tagName || '').toUpperCase(),
    className: '',
    textContent: '',
    children: [],
    listeners: {},
    parentNode: null,
    scrollTop: 0,
    scrollHeight: 0,
    clientHeight: 0,
    style: {},
    dataset: {},
    open: false,
    appendChild(child) {
      if (!child) return child;
      child.parentNode = this;
      this.children.push(child);
      if (this.className === 'tool-trace__lines') {
        this.scrollHeight = Math.max(Number(this.scrollHeight) || 0, this.children.length * 100);
      }
      return child;
    },

    addEventListener(name, handler) {
      this.listeners[name] = handler;
    },
    querySelector(selector) {
      if (!selector || !selector.startsWith('.')) return null;
      const className = selector.slice(1);
      const stack = [...this.children];
      while (stack.length) {
        const candidate = stack.shift();
        if (String(candidate?.className || '') === className) {
          return candidate;
        }
        if (Array.isArray(candidate?.children) && candidate.children.length) {
          stack.unshift(...candidate.children);
        }
      }
      return null;
    },
  };
  Object.defineProperty(node, 'innerHTML', {
    get() {
      return this.children.length ? '[children]' : '';
    },
    set(value) {
      if (value === '') {
        this.children = [];
      }
    },
  });
  return node;
}

test('renderToolTraceBody builds expandable trace, syncs collapsed state on toggle, and restores scroll position', () => {
  const documentObject = {
    createElement(tagName) {
      return createToolTraceNode(tagName);
    },
  };
  const windowScrollCalls = [];
  const windowObject = {
    scrollY: 180,
    scrollTo(x, y) {
      windowScrollCalls.push([x, y]);
    },
    requestAnimationFrame(cb) {
      cb();
    },
  };

  const scroller = createToolTraceNode('section');
  scroller.scrollTop = 240;
  const container = createToolTraceNode('div');
  scroller.appendChild(container);
  const message = { body: 'step 1\nstep 2', pending: true, collapsed: false };
  renderTraceMessageHelpers.renderToolTraceBody(container, message, {
    cleanDisplayTextFn: (value) => String(value || ''),
    documentObject,
    windowObject,
  });

  assert.equal(container.children.length, 1);
  const details = container.children[0];
  assert.equal(details.className, 'tool-trace');
  assert.equal(details.children[0].textContent, 'Tool activity (2) · live');

  details.children[0].listeners.click();
  scroller.scrollTop = 999;
  details.open = false;
  details.listeners.toggle();
  assert.equal(message.collapsed, true);
  assert.equal(scroller.scrollTop, 240);
  assert.deepEqual(windowScrollCalls, [[0, 180]]);
});

test('renderToolTraceBody uses tracked tool call count when available', () => {
  const documentObject = {
    createElement(tagName) {
      return createToolTraceNode(tagName);
    },
  };
  const windowObject = {
    scrollY: 0,
    scrollTo() {},
    requestAnimationFrame(cb) {
      cb();
    },
  };
  const container = createToolTraceNode('div');
  const message = {
    body: '📖 read_file: loaded 100 bytes\n📖 read_file: done',
    pending: true,
    collapsed: false,
    tool_call_count: 1,
  };

  renderTraceMessageHelpers.renderToolTraceBody(container, message, {
    cleanDisplayTextFn: (value) => String(value || ''),
    documentObject,
    windowObject,
  });

  assert.equal(container.children[0].children[0].textContent, 'Tool activity (1) · live');
});

test('renderToolTraceBody preserves inner tool list scroll position across rerenders when reading older entries', () => {
  const documentObject = {
    createElement(tagName) {
      return createToolTraceNode(tagName);
    },
  };
  const windowObject = {
    scrollY: 0,
    scrollTo() {},
    requestAnimationFrame(cb) {
      cb();
    },
  };
  const container = createToolTraceNode('div');

  const message = { body: 'step 1\nstep 2\nstep 3', pending: true, collapsed: false };
  renderTraceMessageHelpers.renderToolTraceBody(container, message, {
    cleanDisplayTextFn: (value) => String(value || ''),
    documentObject,
    windowObject,
  });

  const firstDetails = container.children[0];
  const firstList = firstDetails.children[1];
  firstList.scrollTop = 140;
  firstList.scrollHeight = 600;
  firstList.clientHeight = 200;

  message.body = 'step 1\nstep 2\nstep 3\nstep 4';
  renderTraceMessageHelpers.renderToolTraceBody(container, message, {
    cleanDisplayTextFn: (value) => String(value || ''),
    documentObject,
    windowObject,
  });

  const rerenderedDetails = container.children[container.children.length - 1];
  const rerenderedList = rerenderedDetails.children[1];
  assert.equal(rerenderedDetails.open, true);
  assert.equal(rerenderedList.scrollTop, 140);
});

test('renderToolTraceBody keeps following the bottom across rerenders when already at latest tool entry', () => {
  const documentObject = {
    createElement(tagName) {
      return createToolTraceNode(tagName);
    },
  };
  const windowObject = {
    scrollY: 0,
    scrollTo() {},
    requestAnimationFrame(cb) {
      cb();
    },
  };
  const container = createToolTraceNode('div');

  const message = { body: 'step 1\nstep 2\nstep 3', pending: true, collapsed: false };
  renderTraceMessageHelpers.renderToolTraceBody(container, message, {
    cleanDisplayTextFn: (value) => String(value || ''),
    documentObject,
    windowObject,
  });

  const firstDetails = container.children[0];
  const firstList = firstDetails.children[1];
  firstList.scrollTop = 360;
  firstList.scrollHeight = 600;
  firstList.clientHeight = 200;

  message.body = 'step 1\nstep 2\nstep 3\nstep 4';
  renderTraceMessageHelpers.renderToolTraceBody(container, message, {
    cleanDisplayTextFn: (value) => String(value || ''),
    documentObject,
    windowObject,
  });

  const rerenderedList = container.children[container.children.length - 1].children[1];
  assert.equal(rerenderedList.scrollTop, 400);
});

test('renderToolTraceBody preserves a collapsed tool trace across rerenders even if incoming state resets open', () => {
  const documentObject = {
    createElement(tagName) {
      return createToolTraceNode(tagName);
    },
  };
  const windowObject = {
    scrollY: 0,
    scrollTo() {},
    requestAnimationFrame(cb) {
      cb();
    },
  };
  const container = createToolTraceNode('div');

  const message = { body: 'step 1\nstep 2', pending: true, collapsed: false };
  renderTraceMessageHelpers.renderToolTraceBody(container, message, {
    cleanDisplayTextFn: (value) => String(value || ''),
    documentObject,
    windowObject,
  });

  const firstDetails = container.children[0];
  firstDetails.children[0].listeners.click();
  firstDetails.open = false;
  firstDetails.listeners.toggle();
  assert.equal(message.collapsed, true);

  message.body = 'step 1\nstep 2\nstep 3';
  message.collapsed = false;
  renderTraceMessageHelpers.renderToolTraceBody(container, message, {
    cleanDisplayTextFn: (value) => String(value || ''),
    documentObject,
    windowObject,
  });

  const rerenderedDetails = container.children[container.children.length - 1];
  assert.equal(rerenderedDetails.open, false);
  assert.equal(message.collapsed, true);
});

test('renderToolTraceBody lets terminal completed tool collapse override the live open state', () => {
  const documentObject = {
    createElement(tagName) {
      return createToolTraceNode(tagName);
    },
  };
  const windowObject = {
    scrollY: 0,
    scrollTo() {},
    requestAnimationFrame(cb) {
      cb();
    },
  };
  const container = createToolTraceNode('div');

  const message = { body: 'step 1\nstep 2', pending: true, collapsed: false };
  renderTraceMessageHelpers.renderToolTraceBody(container, message, {
    cleanDisplayTextFn: (value) => String(value || ''),
    documentObject,
    windowObject,
  });
  assert.equal(container.children[0].open, true);

  message.pending = false;
  message.collapsed = true;
  renderTraceMessageHelpers.renderToolTraceBody(container, message, {
    cleanDisplayTextFn: (value) => String(value || ''),
    documentObject,
    windowObject,
  });

  const rerenderedDetails = container.children[container.children.length - 1];
  assert.equal(rerenderedDetails.open, false);
  assert.equal(message.collapsed, true);
});

test('roleLabelForMessage maps role variants and honors operator display name', () => {
  assert.equal(renderTraceMessageHelpers.roleLabelForMessage({ role: 'operator' }, { operatorDisplayName: 'Lemon' }), 'Lemon');
  assert.equal(renderTraceMessageHelpers.roleLabelForMessage({ role: 'assistant' }), 'Hermes');
  assert.equal(renderTraceMessageHelpers.roleLabelForMessage({ role: 'tool' }), 'Tool');
  assert.equal(renderTraceMessageHelpers.roleLabelForMessage({ role: 'system' }), 'System');
});

test('messageVariantForRole and shouldSkipMessageRender map role/body contracts', () => {
  assert.equal(renderTraceMessageHelpers.messageVariantForRole('user'), 'operator');
  assert.equal(renderTraceMessageHelpers.messageVariantForRole('assistant'), 'assistant');
  assert.equal(renderTraceMessageHelpers.messageVariantForRole('tool'), 'tool');
  assert.equal(renderTraceMessageHelpers.messageVariantForRole('unknown'), 'system');

  assert.equal(renderTraceMessageHelpers.shouldSkipMessageRender({ role: 'assistant', renderedBody: '', pending: false }), true);
  assert.equal(renderTraceMessageHelpers.shouldSkipMessageRender({ role: 'tool', renderedBody: '', pending: false }), false);
  assert.equal(renderTraceMessageHelpers.shouldSkipMessageRender({ role: 'assistant', renderedBody: 'ok', pending: false }), false);
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

  renderTraceMessageHelpers.applyMessageMeta(node, { pending: true, created_at: '2026-01-01T00:00:00Z' }, {
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

  renderTraceMessageHelpers.renderMessageContent(node, { role: 'tool' }, 'ignored', {
    renderToolTraceBodyFn: (target, message) => calls.push(['tool', target, message.role]),
    renderBodyFn: (target, body) => calls.push(['body', target, body]),
  });
  renderTraceMessageHelpers.renderMessageContent(node, { role: 'assistant', file_refs: [{ ref_id: 'fr_1' }] }, 'hello', {
    renderToolTraceBodyFn: (target, message) => calls.push(['tool', target, message.role]),
    renderBodyFn: (target, body, options) => calls.push(['body', target, body, options]),
  });

  assert.deepEqual(calls, [
    ['tool', bodyNode, 'tool'],
    ['body', bodyNode, 'hello', { fileRefs: [{ ref_id: 'fr_1' }] }],
  ]);
});

test('messageStableKey and messageStableKeyForPendingState produce stable id/local keys', () => {
  assert.equal(renderTraceMessageHelpers.messageStableKey({ id: 9, role: 'assistant' }, 3), 'id:9');
  assert.equal(
    renderTraceMessageHelpers.messageStableKey({ role: 'assistant', pending: true, created_at: 't1' }, 2),
    'local:assistant:pending:t1:2',
  );
  assert.equal(
    renderTraceMessageHelpers.messageStableKeyForPendingState({ role: 'assistant', created_at: 't1' }, 2, true),
    'local:assistant:pending:t1:2',
  );
  assert.equal(
    renderTraceMessageHelpers.messageStableKeyForPendingState({ id: 10, role: 'assistant' }, 2, true),
    'id:10',
  );
});

test('upsertMessageNode composes skip/meta/content pipeline via injected deps', () => {
  const calls = [];
  const node = { className: '' };
  const message = { role: 'assistant', body: 'hello', pending: false };

  const rendered = renderTraceMessageHelpers.upsertMessageNode(node, message, {
    cleanDisplayTextFn: (value) => String(value || '').trim(),
    shouldSkipMessageRenderFn: ({ role, renderedBody, pending }) => {
      calls.push(['skip', role, renderedBody, pending]);
      return false;
    },
    messageVariantForRoleFn: (role) => {
      calls.push(['variant', role]);
      return 'assistant';
    },
    applyMessageMetaFn: (target, msg, options) => {
      calls.push(['meta', target, msg, options]);
    },
    renderMessageContentFn: (target, msg, renderedBody, options) => {
      calls.push(['content', target, msg, renderedBody, options]);
    },
  });

  assert.equal(rendered, true);
  assert.equal(node.className, 'message');
  assert.deepEqual(calls[0], ['skip', 'assistant', 'hello', false]);
  assert.deepEqual(calls[1], ['variant', 'assistant']);
  assert.deepEqual(calls[2], ['meta', node, message, { role: 'assistant', variant: 'assistant' }]);
  assert.deepEqual(calls[3], ['content', node, message, 'hello', { role: 'assistant', variant: 'assistant' }]);
});

test('upsertMessageNode with real helper deps preserves variant classes and tool body rendering', () => {
  const roleNode = { textContent: '' };
  const timeNode = { textContent: '' };
  const bodyNode = { rendered: null };
  const toolRenderCalls = [];
  const node = {
    className: '',
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
      if (selector === '.message__body') return bodyNode;
      return null;
    },
  };
  const message = { role: 'tool', body: 'read_file', pending: true, created_at: '2026-04-08T08:00:01Z' };

  const rendered = renderTraceMessageHelpers.upsertMessageNode(node, message, {
    cleanDisplayTextFn: (value) => String(value || '').trim(),
    shouldSkipMessageRenderFn: renderTraceMessageHelpers.shouldSkipMessageRender,
    messageVariantForRoleFn: renderTraceMessageHelpers.messageVariantForRole,
    applyMessageMetaFn: (target, msg, options) => renderTraceMessageHelpers.applyMessageMeta(target, msg, {
      ...options,
      roleLabelForMessageFn: () => 'Tool',
      formatMessageTimeFn: () => '08:00',
    }),
    renderMessageContentFn: (target, msg, renderedBody, options) => renderTraceMessageHelpers.renderMessageContent(target, msg, renderedBody, {
      ...options,
      renderToolTraceBodyFn: (container, toolMessage) => {
        toolRenderCalls.push(toolMessage.body);
        container.rendered = toolMessage.body;
      },
      renderBodyFn: () => {
        throw new Error('tool message should not render via generic body path');
      },
    }),
  });

  assert.equal(rendered, true);
  assert.equal(node.className, 'message');
  assert.deepEqual(node.classList.values, ['message--tool', 'message--pending']);
  assert.equal(node.dataset.role, 'tool');
  assert.equal(roleNode.textContent, 'Tool');
  assert.equal(timeNode.textContent, '08:00');
  assert.deepEqual(toolRenderCalls, ['read_file']);
  assert.equal(bodyNode.rendered, 'read_file');
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

  const created = renderTraceMessageHelpers.createMessageNode({ id: 5, role: 'assistant' }, {
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

  renderTraceMessageHelpers.appendMessages(fragment, [{ id: 1 }, { id: 2 }, { id: 3 }], {
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

test('createController owns message-render composition, legacy appendMessages normalization, and patch helper orchestration', () => {
  const previousTextHelpers = globalThis.HermesMiniappRenderTraceText;
  const renderBodyCalls = [];
  globalThis.HermesMiniappRenderTraceText = {
    renderBody(container, rawText, options = {}) {
      renderBodyCalls.push({ container, rawText, options });
      container.rendered = { rawText, options };
    },
  };

  try {
    const messagesContainer = {
      querySelectorAll(selector) {
        if (selector === '.message--assistant') {
          return [assistantNode];
        }
        if (selector === '.message--tool') {
          return [toolNode];
        }
        return [];
      },
    };
    const historyByChat = new Map([
      [7, [
        { id: 1, role: 'assistant', body: 'alpha', pending: true, created_at: 't1', file_refs: [{ ref_id: 'fr_1' }] },
        { id: 2, role: 'tool', body: 'tool body', pending: false, created_at: 't2' },
      ]],
    ]);
    const assistantBodyNode = { rendered: null };
    const assistantToggles = [];
    const assistantNode = {
      dataset: { messageKey: 'id:1' },
      classList: { toggle(name, enabled) { assistantToggles.push([name, Boolean(enabled)]); } },
      querySelector(selector) {
        if (selector === '.message__body') return assistantBodyNode;
        return null;
      },
    };
    const toolBodyNode = createToolTraceNode('div');
    const toolTimeNode = { textContent: '' };
    const toolToggles = [];
    const toolNode = {
      dataset: { messageKey: 'id:2' },
      classList: { toggle(name, enabled) { toolToggles.push([name, Boolean(enabled)]); } },
      querySelector(selector) {
        if (selector === '.message__body') return toolBodyNode;
        if (selector === '.message__time') return toolTimeNode;
        return null;
      },
    };
    const preserveCalls = [];

    const controller = renderTraceMessageHelpers.createController({
      cleanDisplayTextFn: (value) => String(value || '').trim(),
      escapeHtmlFn: (value) => String(value || ''),
      getAllowedRoots: () => ['/workspace'],
      documentObject: { createElement(tagName) { return createToolTraceNode(tagName); } },
      windowObject: { requestAnimationFrame(cb) { cb(); }, scrollTo() {} },
      getOperatorDisplayName: () => 'Alice',
      formatMessageTimeFn: () => '09:15',
      templateElement: {
        content: {
          firstElementChild: {
            cloneNode() {
              return {
                dataset: {},
                className: '',
                classList: { add() {} },
                querySelector(selector) {
                  if (selector === '.message__role') return { textContent: '' };
                  if (selector === '.message__time') return { textContent: '' };
                  if (selector === '.message__body') return {};
                  return null;
                },
              };
            },
          },
        },
      },
      getHistory: (chatId) => historyByChat.get(Number(chatId)) || [],
      getMessagesContainer: () => messagesContainer,
      getActiveChatId: () => 7,
      getStreamPhase: () => 'streaming',
      isPatchPhaseAllowedFn: () => true,
      renderTraceLogFn: () => {},
      preserveViewportDuringUiMutationFn: (fn) => {
        preserveCalls.push('run');
        fn();
      },
    });

    assert.equal(controller.roleLabelForMessage({ role: 'user' }), 'Alice');
    assert.equal(controller.messageStableKey({ id: 12 }, 3), 'id:12');

    const fragment = {
      children: [],
      appendChild(node) {
        this.children.push(node);
      },
    };
    controller.appendMessages(fragment, [{ id: 1, role: 'assistant', body: ' one ' }], 7);

    assert.equal(fragment.children.length, 1);
    assert.equal(fragment.children[0].dataset.messageKey, 'id:1');
    assert.equal(renderBodyCalls.length, 1);
    assert.equal(renderBodyCalls[0].rawText, 'one');
    assert.deepEqual(renderBodyCalls[0].options.allowedRoots, ['/workspace']);

    const latestTool = controller.findLatestHistoryMessageByRole(7, 'tool');
    assert.equal(latestTool?.index, 1);
    assert.equal(latestTool?.key, 'id:2');

    const latestAssistant = controller.findLatestAssistantHistoryMessage(7, { pendingOnly: true });
    assert.equal(latestAssistant?.index, 0);
    assert.equal(latestAssistant?.key, 'id:1');

    assert.equal(controller.findMessageNodeByKey('.message--assistant', 'id:1'), assistantNode);
    assert.equal(controller.patchVisiblePendingAssistant(7, 'patched body', false), true);
    assert.equal(assistantBodyNode.rendered.rawText, 'patched body');
    assert.deepEqual(assistantBodyNode.rendered.options.fileRefs, [{ ref_id: 'fr_1' }]);
    assert.deepEqual(assistantToggles, [['message--pending', false]]);

    assert.equal(controller.patchVisibleToolTrace(7), true);
    assert.equal(toolBodyNode.children.length, 1);
    assert.equal(toolTimeNode.textContent, '09:15');
    assert.deepEqual(toolToggles, [['message--pending', false]]);
    assert.equal(preserveCalls.length, 2);
  } finally {
    globalThis.HermesMiniappRenderTraceText = previousTextHelpers;
  }
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

  assert.equal(renderTraceMessageHelpers.findMessageNodeByKey(container, '.message--assistant', 'target')?.name, 'target');
  assert.equal(renderTraceMessageHelpers.findMessageNodeByKey(container, '.message--assistant', 'missing', 'alt')?.name, 'alt');
  assert.equal(renderTraceMessageHelpers.findMessageNodeByKey(container, '.message--assistant', 'missing'), null);
});

test('findLatestHistoryMessageByRole and findLatestAssistantHistoryMessage derive latest targets with alternate keys', () => {
  const history = [
    { role: 'assistant', body: 'a1', pending: false, created_at: 't1' },
    { role: 'tool', body: 'tool1', pending: true, created_at: 't2' },
    { role: 'hermes', body: 'a2', pending: true, created_at: 't3' },
    { role: 'tool', body: 'tool2', pending: false, created_at: 't4' },
  ];

  const latestTool = renderTraceMessageHelpers.findLatestHistoryMessageByRole(history, 'tool');
  assert.equal(latestTool?.index, 3);
  assert.equal(latestTool?.key, 'local:tool:sent:t4:3');
  assert.equal(latestTool?.alternatePendingKey, 'local:tool:pending:t4:3');

  const latestAssistant = renderTraceMessageHelpers.findLatestAssistantHistoryMessage(history, { pendingOnly: true });
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
  const result = renderTraceMessageHelpers.patchVisiblePendingAssistant({
    chatId: 4,
    activeChatId: 4,
    phase: 'streaming',
    nextBody: 'updated',
    pendingState: true,
    messagesContainer: {},
    history: [{ role: 'hermes', file_refs: [{ ref_id: 'fr_7' }] }],
  }, {
    isPatchPhaseAllowedFn: () => true,
    findLatestAssistantHistoryMessageFn: () => ({
      key: 'local:hermes:pending:t3:2',
      alternatePendingKey: 'local:hermes:sent:t3:2',
      message: { file_refs: [{ ref_id: 'fr_7' }] },
    }),
    findMessageNodeByKeyFn: () => node,
    renderTraceLogFn: () => {},
    preserveViewportDuringUiMutationFn: (fn) => fn(),
    renderBodyFn: (target, body, options) => renderCalls.push([target, body, options]),
  });

  assert.equal(result, true);
  assert.deepEqual(renderCalls, [[bodyNode, 'updated', { fileRefs: [{ ref_id: 'fr_7' }] }]]);
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
  const patched = renderTraceMessageHelpers.patchVisibleToolTrace({
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

  const noTarget = renderTraceMessageHelpers.patchVisibleToolTrace({
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


