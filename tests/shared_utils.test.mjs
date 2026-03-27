import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const shared = require('../static/app_shared_utils.js');

test('parseSseEvent returns eventName and event aliases for structured payloads', () => {
  const parsed = shared.parseSseEvent('event: tool\ndata: {"display":"Calling API"}\n\n');
  assert.ok(parsed);
  assert.equal(parsed.eventName, 'tool');
  assert.equal(parsed.event, 'tool');
  assert.deepEqual(parsed.payload, { display: 'Calling API' });
});

test('parseSseEvent returns text fallback payload for non-JSON data', () => {
  const parsed = shared.parseSseEvent('event: meta\ndata: queue running\n\n');
  assert.ok(parsed);
  assert.equal(parsed.eventName, 'meta');
  assert.equal(parsed.payload.text, 'queue running');
});

test('parseSseEvent returns null for empty data events', () => {
  assert.equal(shared.parseSseEvent('event: chunk\n\n'), null);
  assert.equal(shared.parseSseEvent(''), null);
});

test('parseSseEvent preserves message default when event field is omitted', () => {
  const parsed = shared.parseSseEvent('data: {"ok":true}\n\n');
  assert.ok(parsed);
  assert.equal(parsed.eventName, 'message');
  assert.equal(parsed.event, 'message');
  assert.deepEqual(parsed.payload, { ok: true });
});
