import assert from 'node:assert/strict';
import test from 'node:test';

import { createDedupe } from '../lib/dedupe.js';

test('dedupe evicts the oldest event at its fixed capacity', () => {
  const dedupe = createDedupe({ capacity: 2, ttlMs: 1000, now: () => 0 });

  assert.equal(dedupe.first('event-1'), true);
  assert.equal(dedupe.first('event-2'), true);
  assert.equal(dedupe.first('event-1'), false);
  assert.equal(dedupe.first('event-3'), true);
  assert.equal(dedupe.first('event-1'), true);
  assert.equal(dedupe.size, 2);
});

test('dedupe expires event ids after the configured TTL', () => {
  let now = 100;
  const dedupe = createDedupe({ capacity: 10, ttlMs: 50, now: () => now });

  assert.equal(dedupe.first('event-1'), true);
  now = 149;
  assert.equal(dedupe.first('event-1'), false);
  now = 150;
  assert.equal(dedupe.first('event-1'), true);
  assert.equal(dedupe.size, 1);
});

test('dedupe rejects invalid ids without consuming capacity', () => {
  const dedupe = createDedupe({ capacity: 1, ttlMs: 1000, now: () => 0 });

  assert.equal(dedupe.first(''), false);
  assert.equal(dedupe.first(undefined), false);
  assert.equal(dedupe.size, 0);
});
