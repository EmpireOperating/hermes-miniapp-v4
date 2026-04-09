import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const renderTraceHelpers = require('../static/render_trace_helpers.js');
const renderTraceTextHelpers = require('../static/render_trace_text_helpers.js');
const renderTraceDebugHelpers = require('../static/render_trace_debug_helpers.js');
const renderTraceMessageHelpers = require('../static/render_trace_message_helpers.js');
const renderTraceHistoryHelpers = require('../static/render_trace_history_helpers.js');

test('render_trace_helpers facade re-exports split helper surfaces', () => {
  assert.equal(renderTraceHelpers.parseBooleanFlag('yes'), renderTraceDebugHelpers.parseBooleanFlag('yes'));
  assert.equal(typeof renderTraceHelpers.renderBody, 'function');
  assert.equal(typeof renderTraceHelpers.renderToolTraceBody, 'function');
  assert.equal(typeof renderTraceHelpers.messageStableKey, 'function');
  assert.equal(typeof renderTraceHelpers.createHistoryRenderController, 'function');
  assert.equal(typeof renderTraceHelpers.createController, 'function');
  assert.equal(typeof renderTraceTextHelpers.renderBody, 'function');
  assert.equal(typeof renderTraceMessageHelpers.renderToolTraceBody, 'function');
  assert.equal(typeof renderTraceHistoryHelpers.createHistoryRenderController, 'function');
});
