import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createWorkQueue } from '../lib/work-queue.js';

test('Explicit inspection is promoted ahead of queued automatic work', async () => {
  const queue = createWorkQueue(1), order = [];
  let release;
  const first = queue.schedule(() => new Promise((resolve) => { release = resolve; }));
  const automatic = queue.schedule(() => order.push('automatic'));
  const explicit = queue.schedule(() => order.push('explicit'));
  explicit.promote();
  await Promise.resolve(); release();
  await Promise.all([first.promise, automatic.promise, explicit.promise]);
  assert.deepEqual(order, ['explicit', 'automatic']);
});

test('Queued cancellation does not execute the cancelled work or cancel active inference', async () => {
  const queue = createWorkQueue(1);
  let release, ran = false;
  const active = queue.schedule(() => new Promise((resolve) => { release = resolve; }));
  const stale = queue.schedule(() => { ran = true; });
  const rejected = assert.rejects(stale.promise, /cancelled/);
  assert.equal(active.cancel(), false);
  assert.equal(stale.cancel(), true);
  await Promise.resolve(); release();
  await active.promise; await rejected;
  assert.equal(ran, false);
});
