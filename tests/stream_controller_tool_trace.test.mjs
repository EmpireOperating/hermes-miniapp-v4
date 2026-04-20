import test from 'node:test';
import assert from 'node:assert/strict';
import { streamController } from './stream_controller_test_harness.mjs';

test('createToolTraceController upserts tool deltas by message_id + tool_call_id + phase', () => {
  const histories = new Map([[7, [{ role: 'hermes', body: 'pending', pending: true }]]]);
  const toolTrace = streamController.createToolTraceController({
    histories,
    cleanDisplayText: (text) => String(text || '').trim(),
  });

  toolTrace.appendInlineToolTrace(7, '📖 read_file: opening', {
    message_id: 'm-1',
    tool_call_id: 'tc-1',
    phase: 'started',
  });
  toolTrace.appendInlineToolTrace(7, '📖 read_file: loaded 100 bytes', {
    message_id: 'm-1',
    tool_call_id: 'tc-1',
    phase: 'started',
  });
  toolTrace.appendInlineToolTrace(7, '📖 read_file: done', {
    message_id: 'm-1',
    tool_call_id: 'tc-1',
    phase: 'completed',
  });

  const pending = toolTrace.findPendingToolTraceMessage(7);
  assert.equal(Boolean(pending), true);
  assert.equal(pending.body, '📖 read_file: loaded 100 bytes\n📖 read_file: done');
  assert.equal(pending.tool_call_count, 1);

  toolTrace.finalizeInlineToolTrace(7);
  const finalized = histories.get(7)[0];
  assert.equal(finalized.body, '📖 read_file: loaded 100 bytes\n📖 read_file: done');
  assert.equal(finalized.tool_call_count, 1);
  assert.equal('_toolTraceOrder' in finalized, false);
  assert.equal('_toolTraceLines' in finalized, false);
});

test('createToolTraceController appends pending tool traces and preserves open state across finalize', () => {
  const histories = new Map([[7, [{ role: 'hermes', body: 'pending', pending: true }]]]);

  const toolTrace = streamController.createToolTraceController({
    histories,
    cleanDisplayText: (text) => String(text || '').trim(),
  });

  toolTrace.appendInlineToolTrace(7, 'read_file');
  toolTrace.appendInlineToolTrace(7, 'search_files');

  const pending = toolTrace.findPendingToolTraceMessage(7);
  assert.equal(Boolean(pending), true);
  assert.equal(pending.body, 'read_file\nsearch_files');
  assert.equal(pending.collapsed, false);
  assert.equal(pending.tool_call_count, 2);

  toolTrace.finalizeInlineToolTrace(7);
  const finalized = histories.get(7)[0];
  assert.equal(finalized.role, 'tool');
  assert.equal(finalized.pending, false);
  assert.equal(finalized.collapsed, false);
  assert.equal(finalized.body, 'read_file\nsearch_files');
  assert.equal(finalized.tool_call_count, 2);
});

test('createToolTraceController preserves restored tool lines when resumed tool events gain dedupe ids', () => {
  const histories = new Map([[7, [{ role: 'tool', body: 'read_file\nsearch_files', pending: true, collapsed: false }]]]);

  const toolTrace = streamController.createToolTraceController({
    histories,
    cleanDisplayText: (text) => String(text || '').trim(),
  });

  toolTrace.appendInlineToolTrace(7, 'apply_patch', {
    message_id: 'm-2',
    tool_call_id: 'tc-3',
    phase: 'started',
  });

  const pending = toolTrace.findPendingToolTraceMessage(7);
  assert.equal(Boolean(pending), true);
  assert.equal(pending.body, 'read_file\nsearch_files\napply_patch');
  assert.deepEqual(pending._toolTraceOrder, ['__restored__0', '__restored__1', 'm-2::tc-3::started']);
  assert.equal(pending._toolTraceLines['__restored__0'], 'read_file');
  assert.equal(pending._toolTraceLines['__restored__1'], 'search_files');
  assert.equal(pending._toolTraceLines['m-2::tc-3::started'], 'apply_patch');
});

test('createToolTraceController preserves repeated restored tool lines before resumed deduped events', () => {
  const histories = new Map([[7, [{ role: 'tool', body: 'read_file\nsearch_files\nread_file', pending: true, collapsed: false }]]]);

  const toolTrace = streamController.createToolTraceController({
    histories,
    cleanDisplayText: (text) => String(text || '').trim(),
  });

  toolTrace.appendInlineToolTrace(7, 'apply_patch', {
    message_id: 'm-2',
    tool_call_id: 'tc-4',
    phase: 'started',
  });

  const pending = toolTrace.findPendingToolTraceMessage(7);
  assert.equal(Boolean(pending), true);
  assert.equal(pending.body, 'read_file\nsearch_files\nread_file\napply_patch');
});

test('createToolTraceController preserves explicit collapsed state across finalize', () => {
  const histories = new Map([[7, [{ role: 'hermes', body: 'pending', pending: true }]]]);

  const toolTrace = streamController.createToolTraceController({
    histories,
    cleanDisplayText: (text) => String(text || '').trim(),
  });

  toolTrace.appendInlineToolTrace(7, 'read_file');
  const pending = toolTrace.findPendingToolTraceMessage(7);
  pending.collapsed = true;

  toolTrace.finalizeInlineToolTrace(7);
  const finalized = histories.get(7)[0];
  assert.equal(finalized.pending, false);
  assert.equal(finalized.collapsed, true);
});

test('createToolTraceController can collapse a pending tool trace when assistant output starts', () => {
  const histories = new Map([[7, [{ role: 'tool', body: 'read_file', pending: true, collapsed: false }]]]);
  const persisted = [];

  const toolTrace = streamController.createToolTraceController({
    histories,
    cleanDisplayText: (text) => String(text || '').trim(),
    persistPendingStreamSnapshot: (chatId) => persisted.push(Number(chatId)),
  });

  const changed = toolTrace.collapsePendingToolTrace(7);
  assert.equal(changed, true);
  assert.equal(histories.get(7)[0].collapsed, true);
  assert.deepEqual(persisted, [7]);

  const secondChange = toolTrace.collapsePendingToolTrace(7);
  assert.equal(secondChange, false);
  assert.deepEqual(persisted, [7]);
});

test('createToolTraceController tolerates detached tool stream UI removal', () => {
  const histories = new Map([[7, [{ role: 'hermes', body: 'pending', pending: true }]]]);

  const toolTrace = streamController.createToolTraceController({
    histories,
    cleanDisplayText: (text) => String(text || '').trim(),
  });

  toolTrace.appendInlineToolTrace(7, 'read_file');
  toolTrace.appendInlineToolTrace(7, 'search_files');

  const pending = toolTrace.findPendingToolTraceMessage(7);
  assert.equal(pending.body, 'read_file\nsearch_files');
  assert.doesNotThrow(() => toolTrace.resetToolStream());
});

test('createToolTraceController can drop stale pending tool traces before a new run starts', () => {
  const histories = new Map([[7, [
    { role: 'tool', body: 'old run tool A', pending: true, collapsed: false },
    { role: 'tool', body: 'old run tool B', pending: true, collapsed: false },
    { role: 'assistant', body: 'completed reply', pending: false },
  ]]]);
  const persisted = [];

  const toolTrace = streamController.createToolTraceController({
    histories,
    cleanDisplayText: (text) => String(text || '').trim(),
    persistPendingStreamSnapshot: (chatId) => persisted.push(Number(chatId)),
  });

  const changed = toolTrace.dropPendingToolTraceMessages(7);

  assert.equal(changed, true);
  assert.deepEqual(histories.get(7), [
    { role: 'assistant', body: 'completed reply', pending: false },
  ]);
  assert.equal(toolTrace.findPendingToolTraceMessage(7), null);
  assert.deepEqual(persisted, [7]);

  toolTrace.appendInlineToolTrace(7, 'new run tool');
  const pending = toolTrace.findPendingToolTraceMessage(7);
  assert.equal(Boolean(pending), true);
  assert.equal(pending.body, 'new run tool');
  assert.deepEqual(persisted, [7, 7]);
});

test('createToolTraceController snapshots pending trace mutations inside the helper owner', () => {
  const histories = new Map([[9, [{ role: 'assistant', body: 'pending', pending: true }]]]);
  const persisted = [];

  const toolTrace = streamController.createToolTraceController({
    histories,
    cleanDisplayText: (text) => String(text || '').trim(),
    persistPendingStreamSnapshot: (chatId) => persisted.push(Number(chatId)),
  });

  toolTrace.appendInlineToolTrace(9, 'read_file');
  toolTrace.appendInlineToolTrace(9, 'search_files');
  toolTrace.finalizeInlineToolTrace(9);

  assert.deepEqual(persisted, [9, 9, 9]);
  assert.equal(histories.get(9)[0].pending, false);
  assert.equal(histories.get(9)[0].body, 'read_file\nsearch_files');
});

test('createToolTraceController drops empty finalized traces after detached tool stream removal', () => {
  const histories = new Map([[5, [{ role: 'tool', body: '   ', pending: true, collapsed: false }]]]);

  const toolTrace = streamController.createToolTraceController({
    histories,
    cleanDisplayText: (text) => String(text || '').trim(),
  });

  toolTrace.finalizeInlineToolTrace(5);
  assert.equal(histories.get(5).length, 0);

  assert.doesNotThrow(() => toolTrace.resetToolStream());
});

