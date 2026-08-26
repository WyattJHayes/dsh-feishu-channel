import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPromptQueue } from '../lib/prompt-queue.js';

test('prompt queue runs tasks FIFO and cancelPending skips queued tasks', async () => {
  const queue = createPromptQueue();
  const order = [];
  let release;
  const first = queue.push(() => new Promise((resolve) => {
    release = () => {
      order.push('first');
      resolve();
    };
  }));
  const second = queue.push(async () => order.push('second'));
  const third = queue.push(async () => order.push('third'));

  assert.equal(first.position, 1);
  assert.equal(second.position, 2);
  queue.cancelPending();
  release();
  await Promise.all([first.promise, second.promise, third.promise]);

  assert.deepEqual(order, ['first']);
});
