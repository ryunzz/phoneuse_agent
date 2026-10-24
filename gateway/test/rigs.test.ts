import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_LIMITS } from '../src/config.js';
import { RateLimiter } from '../src/ratelimit.js';
import { RigError, RigHub } from '../src/rigs.js';

const limits = { ...DEFAULT_LIMITS, commandTimeoutMs: 200 };

function hub(clock = { t: 1_000_000 }) {
  const names = new Map([['rig_a', 'A'], ['rig_b', 'B']]);
  return { hub: new RigHub(() => names, limits, () => clock.t), clock };
}

test('offline rigs cannot be leased', () => {
  const { hub: h } = hub();
  assert.throws(() => h.acquire('key_1'), RigError);
});

test('one key per rig; leases expire after idle period', async () => {
  const { hub: h, clock } = hub();
  void h.poll('rig_a', 0);
  assert.equal(h.acquire('key_1'), 'rig_a');
  assert.throws(() => h.acquire('key_2', 'rig_a'), /offline or in use/);
  clock.t += limits.leaseIdleMs + 1;
  assert.equal(h.leaseFor('key_1'), null);
  void h.poll('rig_a', 0);
  assert.equal(h.acquire('key_2', 'rig_a'), 'rig_a');
});

test('commands reach a waiting poll and results resolve the sender', async () => {
  const { hub: h } = hub();
  const polled = h.poll('rig_a', 1000);
  const sent = h.send('rig_a', { type: 'tap', x: 0.5, y: 0.5 });
  const command = await polled;
  assert.ok(command);
  assert.deepEqual(command.action, { type: 'tap', x: 0.5, y: 0.5 });
  assert.equal(h.submitResult('rig_a', { id: command.id, ok: true, receipt: { done: true } }), true);
  assert.deepEqual((await sent).receipt, { done: true });
});

test('queued commands are delivered on the next poll', async () => {
  const { hub: h } = hub();
  await h.poll('rig_a', 0);
  const sent = h.send('rig_a', { type: 'home' });
  const command = await h.poll('rig_a', 0);
  assert.equal(command?.action.type, 'home');
  h.submitResult('rig_a', { id: command!.id, ok: false, error: 'nope' });
  assert.equal((await sent).ok, false);
});

test('unanswered commands time out as unknown outcome, never success', async () => {
  const { hub: h } = hub();
  await h.poll('rig_a', 0);
  const result = await h.send('rig_a', { type: 'home' });
  assert.equal(result.ok, false);
  assert.match(result.error ?? '', /outcome unknown/);
  assert.equal(await h.poll('rig_a', 0), null, 'timed-out command must not be delivered later');
});

test('nextFrame waits for a frame newer than the cutoff', async () => {
  const { hub: h, clock } = hub();
  h.pushFrame('rig_a', Buffer.from('old'));
  const cutoff = clock.t;
  const pending = h.nextFrame('rig_a', cutoff, 1000);
  clock.t += 10;
  h.pushFrame('rig_a', Buffer.from('new'));
  assert.equal((await pending)?.data.toString(), 'new');
  assert.equal(await h.nextFrame('rig_b', clock.t, 20), null);
});

test('rate limiter caps requests per window', () => {
  const clock = { t: 0 };
  const limiter = new RateLimiter(2, 1000, () => clock.t);
  assert.equal(limiter.allow('k'), true);
  assert.equal(limiter.allow('k'), true);
  assert.equal(limiter.allow('k'), false);
  clock.t = 1001;
  assert.equal(limiter.allow('k'), true);
});
