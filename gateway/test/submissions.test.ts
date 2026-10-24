import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll as after, beforeAll as before, test } from 'bun:test';
import { DEFAULT_LIMITS, type Config } from '../src/config.js';
import { createGateway, type Gateway } from '../src/http.js';
import { JsonFileStore } from '../src/store.js';
import { CONSENT_VERSION } from '../src/submissions.js';

let dataDir: string;
let gateway: Gateway;
let base: string;
let alice: string;
let bob: string;
let apiKey: string;

const video = Buffer.concat([Buffer.from('\x00\x00\x00\x18ftypmp42'), Buffer.alloc(64_000, 7)]);
const sha = createHash('sha256').update(video).digest('hex');

function attempt(overrides: Record<string, unknown> = {}) {
  return {
    attemptId: randomUUID(),
    taskId: 'translate-mandarin',
    taskVersion: 1,
    consentVersion: CONSENT_VERSION,
    consentedAt: new Date().toISOString(),
    outcome: 'succeeded',
    note: 'worked',
    durationSeconds: 21.5,
    device: { model: 'iPhone16,1', systemVersion: '26.0', locale: 'en_US' },
    ...overrides,
  };
}

function call(pathname: string, key: string | null, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  if (key) headers.set('Authorization', `Bearer ${key}`);
  if (typeof init.body === 'string') headers.set('Content-Type', 'application/json');
  return fetch(`${base}${pathname}`, { ...init, headers });
}

async function submit(key: string, body = attempt()): Promise<{ id: string; state: string }> {
  const created = await call('/c/v1/submissions', key, { method: 'POST', body: JSON.stringify(body) });
  assert.ok(created.ok, await created.clone().text());
  const { id } = (await created.json()) as { id: string };
  const upload = await call(`/c/v1/submissions/${id}/media`, key, { method: 'PUT', body: video, headers: { 'Content-Type': 'video/mp4' } });
  assert.equal(upload.status, 200, await upload.clone().text());
  const done = await call(`/c/v1/submissions/${id}/complete`, key, { method: 'POST', body: JSON.stringify({ sha256: sha }) });
  assert.equal(done.status, 200, await done.clone().text());
  return (await done.json()) as { id: string; state: string };
}

function admin(pathname: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  if (typeof init.body === 'string') headers.set('Content-Type', 'application/json');
  return fetch(`${base}${pathname}`, { ...init, headers });
}

before(async () => {
  dataDir = mkdtempSync(path.join(tmpdir(), 'phoneuse-sub-'));
  const store = new JsonFileStore(path.join(dataDir, 'store.json'));
  alice = store.createContributor('alice').secret;
  bob = store.createContributor('bob').secret;
  apiKey = store.createKey('dev').secret;
  const config: Config = { host: '127.0.0.1', port: 0, publicUrl: 'http://placeholder', dataDir, traceDir: null, reviewToken: null, limits: { ...DEFAULT_LIMITS, maxVideoBytes: 200_000 } };
  gateway = createGateway(config, store);
  await new Promise<void>((resolve) => gateway.server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(gateway.server.address() as AddressInfo).port}`;
});

after(() => {
  gateway?.server.closeAllConnections();
  gateway?.server.close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('contributor routes need a contributor key', async () => {
  assert.equal((await call('/c/v1/tasks', null)).status, 401);
  assert.equal((await call('/c/v1/submissions', null)).status, 401);
  assert.equal((await call('/c/v1/tasks', apiKey)).status, 401);
  const tasks = (await (await call('/c/v1/tasks', alice)).json()) as { tasks: Array<{ id: string; reward: unknown }> };
  assert.ok(tasks.tasks.some((task) => task.id === 'translate-mandarin'));
  assert.ok(tasks.tasks.every((task) => task.reward === null));
});

test('contributor keys cannot reach MCP or rig routes', async () => {
  assert.equal((await call('/mcp', alice, { method: 'POST', body: '{}' })).status, 401);
  assert.equal((await call('/rig/v1/commands?wait=0', alice)).status, 401);
  assert.equal((await call('/v1/usage', alice)).status, 401);
});

test('upload, complete, and retry without duplicates', async () => {
  const body = attempt();
  const done = await submit(alice, body);
  assert.equal(done.state, 'pending_review');

  // The app retries the whole sequence after a dropped connection.
  const again = await call('/c/v1/submissions', alice, { method: 'POST', body: JSON.stringify(body) });
  assert.equal(again.status, 200);
  assert.equal(((await again.json()) as { id: string }).id, done.id);
  const complete = await call(`/c/v1/submissions/${done.id}/complete`, alice, { method: 'POST', body: JSON.stringify({ sha256: sha }) });
  assert.equal(complete.status, 200);
  const mine = (await (await call('/c/v1/submissions', alice)).json()) as { submissions: Array<{ attemptId: string }> };
  assert.equal(mine.submissions.filter((item) => item.attemptId === body.attemptId).length, 1);

  const replace = await call(`/c/v1/submissions/${done.id}/media`, alice, { method: 'PUT', body: video, headers: { 'Content-Type': 'video/mp4' } });
  assert.equal(replace.status, 409);
});

test('complete rejects a checksum that does not match the stored file', async () => {
  const created = await call('/c/v1/submissions', alice, { method: 'POST', body: JSON.stringify(attempt()) });
  const { id } = (await created.json()) as { id: string };
  assert.equal((await call(`/c/v1/submissions/${id}/complete`, alice, { method: 'POST', body: JSON.stringify({ sha256: sha }) })).status, 409);
  await call(`/c/v1/submissions/${id}/media`, alice, { method: 'PUT', body: video, headers: { 'Content-Type': 'video/mp4' } });
  const wrong = await call(`/c/v1/submissions/${id}/complete`, alice, { method: 'POST', body: JSON.stringify({ sha256: '0'.repeat(64) }) });
  assert.equal(wrong.status, 409);
  const queue = (await (await admin('/admin/v1/submissions')).json()) as { submissions: Array<{ id: string }> };
  assert.ok(!queue.submissions.some((item) => item.id === id), 'unfinished upload must stay out of the queue');
});

test('rejects bad payloads, wrong types, and oversize videos', async () => {
  assert.equal((await call('/c/v1/submissions', alice, { method: 'POST', body: JSON.stringify(attempt({ outcome: 'great' })) })).status, 400);
  assert.equal((await call('/c/v1/submissions', alice, { method: 'POST', body: JSON.stringify(attempt({ taskId: 'nope' })) })).status, 404);
  assert.equal((await call('/c/v1/submissions', alice, { method: 'POST', body: JSON.stringify(attempt({ taskVersion: 9 })) })).status, 409);
  const created = await call('/c/v1/submissions', alice, { method: 'POST', body: JSON.stringify(attempt()) });
  const { id } = (await created.json()) as { id: string };
  assert.equal((await call(`/c/v1/submissions/${id}/media`, alice, { method: 'PUT', body: video, headers: { 'Content-Type': 'image/png' } })).status, 415);
  const big = Buffer.alloc(300_000);
  assert.equal((await call(`/c/v1/submissions/${id}/media`, alice, { method: 'PUT', body: big, headers: { 'Content-Type': 'video/mp4' } })).status, 413);
});

test('one contributor cannot see or change another contributor\'s submission', async () => {
  const done = await submit(alice);
  assert.equal((await call(`/c/v1/submissions/${done.id}/complete`, bob, { method: 'POST', body: JSON.stringify({ sha256: sha }) })).status, 404);
  assert.equal((await call(`/c/v1/submissions/${done.id}/media`, bob, { method: 'PUT', body: video, headers: { 'Content-Type': 'video/mp4' } })).status, 404);
  const bobs = (await (await call('/c/v1/submissions', bob)).json()) as { submissions: unknown[] };
  assert.equal(bobs.submissions.length, 0);
});

test('reviewer approves and rejects; the contributor sees decisions and history', async () => {
  const first = await submit(alice);
  const second = await submit(alice, attempt({ outcome: 'blocked', note: 'option missing' }));

  const media = await admin(`/admin/v1/submissions/${first.id}/media`, { headers: { Range: 'bytes=0-99' } });
  assert.equal(media.status, 206);
  assert.equal((await media.arrayBuffer()).byteLength, 100);
  assert.equal((await admin(`/admin/v1/submissions/${first.id}/media`)).headers.get('content-type'), 'video/mp4');

  assert.equal((await admin(`/admin/v1/submissions/${second.id}/review`, { method: 'POST', body: JSON.stringify({ decision: 'rejected', reason: '' }) })).status, 400);
  assert.equal((await admin(`/admin/v1/submissions/${first.id}/review`, { method: 'POST', body: JSON.stringify({ decision: 'approved' }) })).status, 200);
  assert.equal((await admin(`/admin/v1/submissions/${second.id}/review`, { method: 'POST', body: JSON.stringify({ decision: 'rejected', reason: 'Recording cuts off early' }) })).status, 200);
  await admin(`/admin/v1/submissions/${first.id}/review`, { method: 'POST', body: JSON.stringify({ decision: 'approved', reason: 'Rechecked' }) });

  const mine = (await (await call('/c/v1/submissions', alice)).json()) as { submissions: Array<{ id: string; state: string; outcome: string; reviews: Array<{ reason: string }> }> };
  const a = mine.submissions.find((item) => item.id === first.id)!;
  const b = mine.submissions.find((item) => item.id === second.id)!;
  assert.equal(a.state, 'approved');
  assert.equal(a.reviews.length, 2);
  assert.equal(b.state, 'rejected');
  assert.equal(b.outcome, 'blocked');
  assert.equal(b.reviews.at(-1)?.reason, 'Recording cuts off early');

  const queue = (await (await admin('/admin/v1/submissions')).json()) as { stats: Record<string, number> };
  assert.ok(queue.stats.approved >= 1 && queue.stats.rejected >= 1 && queue.stats.reportedBlocked >= 1);
});

test('admin routes refuse contributor keys from other hosts and cross-site writes', async () => {
  const done = await submit(alice);
  const spoofedHost = await admin('/admin/v1/submissions', { headers: { Host: 'evil.example' } });
  assert.equal(spoofedHost.status, 403);
  const crossSite = await admin(`/admin/v1/submissions/${done.id}/review`, {
    method: 'POST',
    body: JSON.stringify({ decision: 'approved' }),
    headers: { Origin: 'https://evil.example' },
  });
  assert.equal(crossSite.status, 403);
  const noJson = await fetch(`${base}/admin/v1/submissions/${done.id}/review`, { method: 'POST', body: 'decision=approved', headers: { 'Content-Type': 'text/plain' } });
  assert.equal(noJson.status, 415);
  const page = await admin('/review/submissions');
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Review/);
});

test('submissions survive a gateway restart', async () => {
  const done = await submit(alice);
  const store = new JsonFileStore(path.join(dataDir, 'store.json'));
  const config: Config = { host: '127.0.0.1', port: 0, publicUrl: 'http://placeholder', dataDir, traceDir: null, reviewToken: null, limits: DEFAULT_LIMITS };
  const reborn = createGateway(config, store);
  assert.equal(reborn.submissions.get(done.id).state, 'pending_review');
});
