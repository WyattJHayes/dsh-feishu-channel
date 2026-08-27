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

test('prompt queue rejects tasks above the configured capacity', async () => {
  const queue = createPromptQueue({ maxQueued: 2 });
  let release;
  const first = queue.push(() => new Promise((resolve) => {
    release = resolve;
  }));
  const second = queue.push(async () => {});

  assert.throws(() => queue.push(async () => {}), /FEISHU_PROMPT_QUEUE_FULL/);
  release();
  await Promise.all([first.promise, second.promise]);
});
