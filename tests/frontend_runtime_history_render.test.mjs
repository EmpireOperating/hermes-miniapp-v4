import { test, assert, runtime } from './frontend_runtime_test_harness.mjs';

test('mergeHydratedHistory preserves local pending tool traces while chat is pending', () => {
  const previousHistory = [
    { id: 1, role: 'operator', body: 'run this', created_at: '2026-03-25T10:00:00Z' },
    { role: 'tool', body: 'fetching quote', created_at: '2026-03-25T10:00:01Z', pending: true },
    { role: 'hermes', body: 'Working on it…', created_at: '2026-03-25T10:00:02Z', pending: true },
  ];
  const hydrated = [
    { id: 1, role: 'operator', body: 'run this', created_at: '2026-03-25T10:00:00Z' },
  ];

  const merged = runtime.mergeHydratedHistory({
    previousHistory,
    nextHistory: hydrated,
    chatPending: true,
  });

  assert.equal(merged.length, 3);
  assert.equal(merged[1].role, 'tool');
  assert.equal(merged[1].pending, true);
  assert.equal(merged[2].role, 'hermes');
  assert.equal(merged[2].pending, true);
});


test('mergeHydratedHistory does not preserve local pending traces after chat is no longer pending', () => {
  const previousHistory = [
    { id: 1, role: 'operator', body: 'run this', created_at: '2026-03-25T10:00:00Z' },
    { role: 'tool', body: 'fetching quote', created_at: '2026-03-25T10:00:01Z', pending: true },
  ];
  const hydrated = [
    { id: 1, role: 'operator', body: 'run this', created_at: '2026-03-25T10:00:00Z' },
    { id: 2, role: 'hermes', body: 'done', created_at: '2026-03-25T10:00:04Z', pending: false },
  ];

  const merged = runtime.mergeHydratedHistory({
    previousHistory,
    nextHistory: hydrated,
    chatPending: false,
  });

  assert.deepEqual(merged, hydrated);
});


test('mergeHydratedHistory preserves completed local tool trace on force-complete hydrate when server history lacks it', () => {
  const previousHistory = [
    { id: 1, role: 'operator', body: 'run this', created_at: '2026-03-25T10:00:00Z' },
    { role: 'tool', body: 'fetching quote', created_at: '2026-03-25T10:00:01Z', pending: false },
    { role: 'hermes', body: 'done', created_at: '2026-03-25T10:00:04Z', pending: false },
  ];
  const hydrated = [
    { id: 1, role: 'operator', body: 'run this', created_at: '2026-03-25T10:00:00Z' },
    { id: 2, role: 'hermes', body: 'done', created_at: '2026-03-25T10:00:04Z', pending: false },
  ];

  const merged = runtime.mergeHydratedHistory({
    previousHistory,
    nextHistory: hydrated,
    chatPending: false,
    preserveCompletedToolTrace: true,
  });

  assert.equal(merged.length, 3);
  assert.equal(merged[1].role, 'tool');
  assert.equal(merged[1].body, 'fetching quote');
  assert.equal(merged[2].role, 'hermes');
});


test('mergeHydratedHistory does not duplicate completed local tool trace when server history already includes it', () => {
  const completedTool = { role: 'tool', body: 'fetching quote', created_at: '2026-03-25T10:00:01Z', pending: false };
  const previousHistory = [
    { id: 1, role: 'operator', body: 'run this', created_at: '2026-03-25T10:00:00Z' },
    completedTool,
    { role: 'hermes', body: 'done', created_at: '2026-03-25T10:00:04Z', pending: false },
  ];
  const hydrated = [
    { id: 1, role: 'operator', body: 'run this', created_at: '2026-03-25T10:00:00Z' },
    { ...completedTool, id: 2 },
    { id: 3, role: 'hermes', body: 'done', created_at: '2026-03-25T10:00:04Z', pending: false },
  ];

  const merged = runtime.mergeHydratedHistory({
    previousHistory,
    nextHistory: hydrated,
    chatPending: false,
    preserveCompletedToolTrace: true,
  });

  assert.equal(merged.filter((item) => item.role === 'tool').length, 1);
  assert.equal(merged[1].id, 2);
});


test('mergeHydratedHistory does not duplicate completed local tool trace when server copy has different timestamp', () => {
  const previousHistory = [
    { id: 1, role: 'operator', body: 'run this', created_at: '2026-03-25T10:00:00Z' },
    { role: 'tool', body: 'fetching quote', created_at: '2026-03-25T10:00:01Z', pending: false },
    { role: 'hermes', body: 'done', created_at: '2026-03-25T10:00:03Z', pending: true },
  ];
  const hydrated = [
    { id: 1, role: 'operator', body: 'run this', created_at: '2026-03-25T10:00:00Z' },
    { id: 9, role: 'tool', body: 'fetching quote', created_at: '2026-03-25T10:00:04Z', pending: false },
    { id: 3, role: 'hermes', body: 'done', created_at: '2026-03-25T10:00:05Z', pending: false },
  ];

  const merged = runtime.mergeHydratedHistory({
    previousHistory,
    nextHistory: hydrated,
    chatPending: false,
    preserveCompletedToolTrace: true,
  });

  assert.equal(merged.filter((item) => item.role === 'tool').length, 1);
  assert.equal(merged[1].id, 9);
  assert.equal(merged[2].role, 'hermes');
});


test('mergeHydratedHistory anchors preserved completed tool trace before final assistant when only pending assistant existed locally', () => {
  const previousHistory = [
    { id: 1, role: 'operator', body: 'run this', created_at: '2026-03-25T10:00:00Z' },
    { role: 'tool', body: 'fetching quote', created_at: '2026-03-25T10:00:01Z', pending: false },
    { role: 'hermes', body: 'done', created_at: '2026-03-25T10:00:03Z', pending: true },
  ];
  const hydrated = [
    { id: 1, role: 'operator', body: 'run this', created_at: '2026-03-25T10:00:00Z' },
    { id: 3, role: 'hermes', body: 'done', created_at: '2026-03-25T10:00:05Z', pending: false },
  ];

  const merged = runtime.mergeHydratedHistory({
    previousHistory,
    nextHistory: hydrated,
    chatPending: false,
    preserveCompletedToolTrace: true,
  });

  assert.equal(merged.length, 3);
  assert.equal(merged[1].role, 'tool');
  assert.equal(merged[2].role, 'hermes');
});


test('mergeHydratedHistory avoids duplicating pending entries already present in hydrated history', () => {
  const pendingTool = { role: 'tool', body: 'fetching quote', created_at: '2026-03-25T10:00:01Z', pending: true };
  const previousHistory = [
    { id: 1, role: 'operator', body: 'run this', created_at: '2026-03-25T10:00:00Z' },
    pendingTool,
  ];
  const hydrated = [
    { id: 1, role: 'operator', body: 'run this', created_at: '2026-03-25T10:00:00Z' },
    { ...pendingTool },
  ];

  const merged = runtime.mergeHydratedHistory({
    previousHistory,
    nextHistory: hydrated,
    chatPending: true,
  });

  const toolRows = merged.filter((item) => item.role === 'tool');
  assert.equal(toolRows.length, 1);
});


test('mergeHydratedHistory preserves local collapsed state for matching pending tool traces', () => {
  const pendingTool = {
    role: 'tool',
    body: 'fetching quote',
    created_at: '2026-03-25T10:00:01Z',
    pending: true,
    collapsed: true,
  };
  const previousHistory = [
    { id: 1, role: 'operator', body: 'run this', created_at: '2026-03-25T10:00:00Z' },
    pendingTool,
  ];
  const hydrated = [
    { id: 1, role: 'operator', body: 'run this', created_at: '2026-03-25T10:00:00Z' },
    { role: 'tool', body: 'fetching quote', created_at: '2026-03-25T10:00:01Z', pending: true },
  ];

  const merged = runtime.mergeHydratedHistory({
    previousHistory,
    nextHistory: hydrated,
    chatPending: true,
  });

  assert.equal(merged[1].collapsed, true);
});


test('mergeHydratedHistory prefers fuller local pending tool trace body over partial hydrated copy of the same pending message', () => {
  const pendingTool = {
    role: 'tool',
    body: 'todo\nread_file\nsearch_files',
    created_at: '2026-04-09T20:40:01Z',
    pending: true,
    collapsed: false,
  };
  const previousHistory = [
    { id: 1, role: 'operator', body: 'run this', created_at: '2026-04-09T20:40:00Z' },
    pendingTool,
  ];
  const hydrated = [
    { id: 1, role: 'operator', body: 'run this', created_at: '2026-04-09T20:40:00Z' },
    { role: 'tool', body: 'read_file\nsearch_files', created_at: '2026-04-09T20:40:01Z', pending: true },
  ];

  const merged = runtime.mergeHydratedHistory({
    previousHistory,
    nextHistory: hydrated,
    chatPending: true,
  });

  const toolRows = merged.filter((item) => item.role === 'tool');
  assert.equal(toolRows.length, 1);
  assert.equal(toolRows[0].body, 'todo\nread_file\nsearch_files');
});


test('mergeHydratedHistory does not duplicate singleton pending tool trace when hydrated and local created_at differ', () => {
  const previousHistory = [
    { id: 1, role: 'operator', body: 'run this', created_at: '2026-04-09T20:40:00Z' },
    { role: 'tool', body: 'read_file\nsearch_files', created_at: '2026-04-09T20:40:04Z', pending: true, collapsed: true },
  ];
  const hydrated = [
    { id: 1, role: 'operator', body: 'run this', created_at: '2026-04-09T20:40:00Z' },
    { role: 'tool', body: 'read_file\nsearch_files', created_at: '2026-04-09 20:40:05', pending: true },
  ];

  const merged = runtime.mergeHydratedHistory({
    previousHistory,
    nextHistory: hydrated,
    chatPending: true,
  });

  const toolRows = merged.filter((item) => item.role === 'tool');
  assert.equal(toolRows.length, 1);
  assert.equal(toolRows[0].body, 'read_file\nsearch_files');
  assert.equal(toolRows[0].collapsed, true);
});


test('mergeHydratedHistory collapses duplicate local pending tool rows created by repeated reload restores', () => {
  const previousHistory = [
    { id: 1, role: 'operator', body: 'run this', created_at: '2026-04-09T20:40:00Z' },
    { role: 'tool', body: 'read_file', created_at: '2026-04-09T20:40:04Z', pending: true, collapsed: false },
    { role: 'tool', body: 'read_file\nsearch_files\nwrite_file', created_at: '2026-04-09T20:40:05Z', pending: true, collapsed: true },
  ];
  const hydrated = [
    { id: 1, role: 'operator', body: 'run this', created_at: '2026-04-09T20:40:00Z' },
    { role: 'tool', body: 'read_file\nsearch_files', created_at: '2026-04-09 20:40:06', pending: true },
  ];

  const merged = runtime.mergeHydratedHistory({
    previousHistory,
    nextHistory: hydrated,
    chatPending: true,
  });

  const toolRows = merged.filter((item) => item.role === 'tool');
  assert.equal(toolRows.length, 1);
  assert.equal(toolRows[0].body, 'read_file\nsearch_files\nwrite_file');
  assert.equal(toolRows[0].collapsed, true);
});


test('mergeHydratedHistory collapses duplicate hydrated pending tool rows before preserving local UI state', () => {
  const previousHistory = [
    { id: 1, role: 'operator', body: 'run this', created_at: '2026-04-09T20:40:00Z' },
    { role: 'tool', body: 'read_file\nsearch_files\nwrite_file', created_at: '2026-04-09T20:40:05Z', pending: true, collapsed: true },
  ];
  const hydrated = [
    { id: 1, role: 'operator', body: 'run this', created_at: '2026-04-09T20:40:00Z' },
    { role: 'tool', body: 'read_file', created_at: '2026-04-09 20:40:04', pending: true },
    { role: 'tool', body: 'read_file\nsearch_files', created_at: '2026-04-09 20:40:06', pending: true },
  ];

  const merged = runtime.mergeHydratedHistory({
    previousHistory,
    nextHistory: hydrated,
    chatPending: true,
  });

  const toolRows = merged.filter((item) => item.role === 'tool');
  assert.equal(toolRows.length, 1);
  assert.equal(toolRows[0].body, 'read_file\nsearch_files\nwrite_file');
  assert.equal(toolRows[0].collapsed, true);
});


test('shouldUseAppendOnlyRender returns false when new history inserts before current tail', () => {
  const previousTail = {
    role: 'hermes',
    body: 'Working…',
    created_at: '2026-03-25T10:00:02Z',
    pending: true,
  };
  const nextHistory = [
    { id: 1, role: 'operator', body: 'run this', created_at: '2026-03-25T10:00:00Z' },
    { role: 'tool', body: 'calling API', created_at: '2026-03-25T10:00:01Z', pending: true },
    previousTail,
  ];

  const renderedMessageKeys = [
    'id:1',
    'local:hermes:pending:2026-03-25T10:00:02Z:1',
  ];

  const canAppendOnly = runtime.shouldUseAppendOnlyRender({
    history: nextHistory,
    previouslyRenderedLength: 2,
    renderedMessageKeys,
  });

  assert.equal(canAppendOnly, false);
});


test('shouldUseAppendOnlyRender returns true for clean tail append', () => {
  const nextHistory = [
    { id: 1, role: 'operator', body: 'run this', created_at: '2026-03-25T10:00:00Z' },
    { role: 'hermes', body: 'Working…', created_at: '2026-03-25T10:00:02Z', pending: true },
    { role: 'tool', body: 'calling API', created_at: '2026-03-25T10:00:03Z', pending: true },
  ];

  const renderedMessageKeys = [
    'id:1',
    'local:hermes:pending:2026-03-25T10:00:02Z:1',
  ];

  const canAppendOnly = runtime.shouldUseAppendOnlyRender({
    history: nextHistory,
    previouslyRenderedLength: 2,
    renderedMessageKeys,
  });

  assert.equal(canAppendOnly, true);
});
