import assert from 'node:assert/strict';
import { test } from 'bun:test';
import { AskError, Asks } from '../src/asks.js';
import { GuardError, Guards } from '../src/guards.js';
import { HttpVla, parseDecision, VlaError } from '../src/vla.js';

function guards(clock = { t: 0 }) {
  return { g: new Guards({ observationMaxAgeMs: 1000, actionsPerTask: 2 }, () => clock.t), clock };
}

test('actions need a fresh look, and each look allows one action', () => {
  const { g, clock } = guards();
  assert.throws(() => g.beforeAction('k'), /fresh phone_screenshot/);
  g.observed('k');
  g.beforeAction('k');
  assert.throws(() => g.beforeAction('k'), /fresh phone_screenshot/, 'must look again between actions');
  g.observed('k');
  clock.t = 2000;
  assert.throws(() => g.beforeAction('k'), GuardError, 'stale observation');
});

test('budget, unknown outcomes and operator stop', () => {
  const { g } = guards();
  for (let i = 0; i < 2; i++) {
    g.observed('k');
    g.beforeAction('k');
  }
  g.observed('k');
  assert.throws(() => g.beforeAction('k'), /budget of 2/);
  g.startTask('k');
  g.observed('k');
  g.outcomeUnknown('k');
  assert.throws(() => g.beforeAction('k'), /unknown outcome/);
  g.observed('k');
  g.beforeAction('k');
  g.stop('k', 'operator pressed stop');
  g.observed('k');
  assert.throws(() => g.beforeAction('k'), /Stopped by operator/);
  assert.equal(g.status('k').stopped, 'operator pressed stop');
  g.startTask('k');
  assert.equal(g.status('k').stopped, null, 'a new task clears the stop');
});

test('ask_user answers resolve waiters; validation by kind; isolation by key', async () => {
  const asks = new Asks(60_000);
  const ask = asks.create('k1', 'Enter the code', 'code');
  const waiting = asks.wait('k1', ask.id, 1000);
  assert.equal(asks.pending('k1').length, 1);
  assert.equal(asks.pending('k2').length, 0);
  assert.throws(() => asks.answer('k2', ask.id, '123456'), AskError, 'other keys cannot answer');
  assert.throws(() => asks.answer('k1', ask.id, '12 34'), /3-12 letters or digits/);
  asks.answer('k1', ask.id, ' 123456 ');
  assert.equal(await waiting, '123456');
  assert.throws(() => asks.answer('k1', ask.id, '654321'), /already answered/);
  assert.equal(asks.pending('k1').length, 0);
  assert.equal(await asks.wait('k1', asks.create('k1', 'ok?', 'confirm').id, 10), null, 'times out with null');
});

test('VLA decisions are validated; HTTP adapter speaks the documented contract', async () => {
  assert.deepEqual(parseDecision({ action: { type: 'tap', x: 0.5, y: 0.5 } }), { kind: 'act', action: { type: 'tap', x: 0.5, y: 0.5 }, reason: undefined });
  assert.equal(parseDecision({ done: true, outcome: 'success' }).kind, 'done');
  assert.throws(() => parseDecision({ action: { type: 'tap', x: 5, y: 0 } }), VlaError);

  let seen: Record<string, unknown> = {};
  let auth = '';
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      seen = (await req.json()) as Record<string, unknown>;
      auth = req.headers.get('authorization') ?? '';
      return Response.json({ action: { type: 'home' }, reason: 'go home' });
    },
  });
  try {
    const vla = new HttpVla(`http://127.0.0.1:${server.port}/act`, 'vla_secret');
    const decision = await vla.next({ instruction: 'go home', image: Buffer.from('jpeg'), step: 1, history: [] });
    assert.deepEqual(decision, { kind: 'act', action: { type: 'home' }, reason: 'go home' });
    assert.equal(seen.instruction, 'go home');
    assert.equal(seen.image_jpeg_base64, Buffer.from('jpeg').toString('base64'));
    assert.equal(auth, 'Bearer vla_secret');
  } finally {
    server.stop(true);
  }
  await assert.rejects(new HttpVla('http://127.0.0.1:9/none', null, 500).next({ instruction: 'x', image: Buffer.alloc(0), step: 1, history: [] }), VlaError);
});
