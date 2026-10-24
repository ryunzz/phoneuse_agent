import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, test } from 'bun:test';
import { DEFAULT_LIMITS, type Config } from '../src/config.js';
import { createGateway, type Gateway } from '../src/http.js';
import { JsonFileStore } from '../src/store.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const TOKEN = 'review-token-'.padEnd(40, 'x');
const EPISODE = 'a'.repeat(32);

let dir: string;
let traceDir: string;
let gateway: Gateway;
let base: string;

function frame(folder: string, name: string, source: string) {
  const data = readFileSync(path.join(REPO, source));
  writeFileSync(path.join(folder, name), data);
  return { source: 'gateway', frame_seq: 1, width: 636, height: 1402, image: name, sha256: createHash('sha256').update(data).digest('hex') };
}

function writeEpisode(root: string): void {
  const folder = path.join(root, EPISODE);
  mkdirSync(folder, { recursive: true });
  writeFileSync(path.join(folder, 'episode.json'), JSON.stringify({
    schema_version: 1, episode_id: EPISODE, instruction: 'Open Settings', group: 'settings-nav', split: 'train',
    started_at: 1792880000.5, source: 'gateway', rig_id: 'rig_a', key_id: 'key_1',
  }));
  const rows = [
    { event: 'intent', step: 1, action: { type: 'tap', x: 0.2, y: 0.5 }, before: frame(folder, '00001-before.jpg', 'iphone-home-after-test.png'), label: 'unreviewed', note: 'Tap the Settings icon', dispatched_at: 1792880001 },
    { event: 'result', step: 1, status: 'complete', receipt: { ok: true }, dispatch_ended_at: 1792880001.2, after: frame(folder, '00001-after.jpg', 'iphone-settings-test.png'), recorded_at: 1792880002 },
    { event: 'intent', step: 2, action: { type: 'home' }, before: frame(folder, '00002-before.jpg', 'iphone-settings-test.png'), label: 'unreviewed', note: '', dispatched_at: 1792880003 },
    { event: 'result', step: 2, status: 'complete', receipt: { ok: true }, dispatch_ended_at: 1792880003.2, after: frame(folder, '00002-after.jpg', 'iphone-home-after-test.png'), recorded_at: 1792880004 },
  ];
  writeFileSync(path.join(folder, 'steps.jsonl'), rows.map((row) => JSON.stringify(row)).join('\n') + '\n');
  writeFileSync(path.join(folder, 'outcome.jsonl'), JSON.stringify({ outcome: 'failed', note: '', finished_at: 1792880005, reported_by: 'agent' }) + '\n');
}

async function start(reviewToken: string | null): Promise<{ gateway: Gateway; base: string }> {
  const store = new JsonFileStore(path.join(dir, `store-${reviewToken ? 'on' : 'off'}.json`));
  const config: Config = { host: '127.0.0.1', port: 0, publicUrl: 'http://placeholder', dataDir: dir, traceDir, reviewToken, limits: DEFAULT_LIMITS };
  const instance = createGateway(config, store);
  await new Promise<void>((resolve) => instance.server.listen(0, '127.0.0.1', resolve));
  return { gateway: instance, base: `http://127.0.0.1:${(instance.server.address() as AddressInfo).port}` };
}

const auth = { Authorization: `Bearer ${TOKEN}` };
const post = (url: string, body: unknown) =>
  fetch(url, { method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

beforeAll(async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'review-'));
  traceDir = path.join(dir, 'demonstrations');
  writeEpisode(traceDir);
  ({ gateway, base } = await start(TOKEN));
});

afterAll(() => {
  gateway?.server.close();
  rmSync(dir, { recursive: true, force: true });
});

test('review API requires the review token', async () => {
  assert.equal((await fetch(`${base}/v1/episodes`)).status, 401);
  assert.equal((await fetch(`${base}/v1/episodes`, { headers: { Authorization: 'Bearer wrong' } })).status, 401);
  const page = await fetch(`${base}/review`);
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-security-policy') ?? '', /img-src 'self' data: blob:/);
});

test('lists episodes and returns step detail', async () => {
  const list = await (await fetch(`${base}/v1/episodes`, { headers: auth })).json();
  assert.equal(list.length, 1);
  assert.deepEqual(
    { id: list[0].episode_id, steps: list[0].steps, outcome: list[0].outcome, by: list[0].reported_by, reviewed: list[0].reviewed, exportable: list[0].exportable },
    { id: EPISODE, steps: 2, outcome: 'failed', by: 'agent', reviewed: 0, exportable: false },
  );
  const detail = await (await fetch(`${base}/v1/episodes/${EPISODE}`, { headers: auth })).json();
  assert.equal(detail.meta.instruction, 'Open Settings');
  assert.deepEqual(detail.steps[0], {
    step: 1, action: { type: 'tap', x: 0.2, y: 0.5 }, note: 'Tap the Settings icon', label: 'unreviewed',
    status: 'complete', error: null, before_image: '00001-before.jpg', after_image: '00001-after.jpg',
  });
});

test('serves frames and rejects path traversal', async () => {
  const image = await fetch(`${base}/v1/episodes/${EPISODE}/images/00001-before.jpg`, { headers: auth });
  assert.equal(image.status, 200);
  assert.equal(image.headers.get('content-type'), 'image/jpeg');
  for (const bad of [`${EPISODE}/images/..%2Fepisode.json`, `${EPISODE}/images/episode.json`, `..%2F..%2Fetc/images/00001-before.jpg`, `${'b'.repeat(32)}/images/00001-before.jpg`]) {
    assert.equal((await fetch(`${base}/v1/episodes/${bad}`, { headers: auth })).status, 404, bad);
  }
});

test('labels and outcome feed the Python exporter', async () => {
  assert.equal((await post(`${base}/v1/episodes/${EPISODE}/steps/9/label`, { label: 'correct' })).status, 404);
  assert.equal((await post(`${base}/v1/episodes/${EPISODE}/steps/1/label`, { label: 'great' })).status, 400);
  assert.equal((await post(`${base}/v1/episodes/${EPISODE}/steps/1/label`, { label: 'correct', note: 'right icon' })).status, 200);
  assert.equal((await post(`${base}/v1/episodes/${EPISODE}/steps/2/label`, { label: 'mistake' })).status, 200);
  assert.equal((await post(`${base}/v1/episodes/${EPISODE}/outcome`, { outcome: 'success' })).status, 200);

  const annotation = JSON.parse(readFileSync(path.join(traceDir, EPISODE, 'annotations.jsonl'), 'utf8').split('\n')[0]);
  assert.deepEqual(Object.keys(annotation).sort(), ['at', 'boxes', 'coordinate_space', 'label', 'note', 'reviewer', 'step']);
  assert.ok(annotation.at > 1e9 && annotation.at < 1e11, 'timestamps are Unix seconds');

  const [summary] = await (await fetch(`${base}/v1/episodes`, { headers: auth })).json();
  assert.equal(summary.reviewed, 2);
  assert.equal(summary.exportable, true);
  assert.equal(summary.reported_by, 'reviewer');

  const out = path.join(dir, 'export');
  const run = spawnSync('uv', ['run', 'episodes.py', 'export', '--root', traceDir, '--output', out], { cwd: REPO, encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(JSON.parse(run.stdout.trim().split('\n').at(-1) ?? '{}'), { train: 1, eval: 0 });
  const row = JSON.parse(readFileSync(path.join(out, 'train.jsonl'), 'utf8').trim());
  assert.equal(row.step, 1);
  assert.equal(row.instruction, 'Open Settings');
  assert.deepEqual(row.target_action, { type: 'tap', x: 0.2, y: 0.5 });
});

test('a truncated trailing line does not break reading', async () => {
  appendFileSync(path.join(traceDir, EPISODE, 'annotations.jsonl'), '{"step": 2, "lab');
  const detail = await (await fetch(`${base}/v1/episodes/${EPISODE}`, { headers: auth })).json();
  assert.equal(detail.steps[1].label, 'mistake');
});

test('review is disabled without a review token', async () => {
  const off = await start(null);
  try {
    assert.equal((await fetch(`${off.base}/v1/episodes`, { headers: auth })).status, 404);
  } finally {
    off.gateway.server.close();
  }
});
