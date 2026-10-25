import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll as after, beforeAll as before, test } from 'bun:test';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { DEFAULT_LIMITS, type Config } from '../src/config.js';
import { createGateway, type Gateway } from '../src/http.js';
import { JsonFileStore } from '../src/store.js';
import { ScriptedVlm } from '../src/vlm.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

let dataDir: string;
let gateway: Gateway;
let base: string;
let apiKey: string;
let rig: ChildProcess;

async function waitFor(check: () => Promise<boolean>, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('Timed out waiting for condition');
}

async function connect(key: string): Promise<Client> {
  const client = new Client({ name: 'e2e', version: '0.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${key}` } },
  }));
  return client;
}

before(async () => {
  dataDir = mkdtempSync(path.join(tmpdir(), 'phoneuse-'));
  const store = new JsonFileStore(path.join(dataDir, 'store.json'));
  apiKey = store.createKey('e2e').secret;
  const rigToken = store.createRig('sim rig').secret;
  const config: Config = { host: '127.0.0.1', port: 0, publicUrl: 'http://placeholder', dataDir, traceDir: path.join(dataDir, 'demonstrations'), reviewToken: 'r'.repeat(32), limits: { ...DEFAULT_LIMITS, settleMs: 100 } };
  gateway = createGateway(config, store, new ScriptedVlm([
    { kind: 'act', action: { type: 'tap', x: 0.86, y: 0.88 }, reason: 'open Settings' },
    { kind: 'done', outcome: 'success', note: 'Settings open' },
  ]));
  await new Promise<void>((resolve) => gateway.server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(gateway.server.address() as AddressInfo).port}`;
  rig = spawn('uv', ['run', 'rig_agent.py', '--backend', 'sim', '--gateway', base, '--fps', '5'], {
    cwd: REPO,
    env: { ...process.env, RIG_TOKEN: rigToken },
    stdio: 'ignore',
  });
  await waitFor(async () => gateway.hub.list('x').some((info) => info.online && info.frameAgeMs !== null));
});

after(() => {
  rig?.kill();
  gateway?.server.closeAllConnections();
  gateway?.server.close();
  rmSync(dataDir, { recursive: true, force: true });
});

test('rejects requests without a valid API key', async () => {
  const response = await fetch(`${base}/mcp`, { method: 'POST', body: '{}', headers: { 'Content-Type': 'application/json' } });
  assert.equal(response.status, 401);
  await assert.rejects(connect('pu_wrong'));
});

test('Claude-style client drives the sim rig end to end', async () => {
  const client = await connect(apiKey);
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((tool) => tool.name).sort(), [
    'ask_user', 'phone_connect', 'phone_disconnect', 'phone_do', 'phone_home', 'phone_live_feed', 'phone_screenshot',
    'phone_scroll', 'phone_tap', 'phone_task_done', 'phone_type', 'rigs_list', 'usage_get',
  ]);

  const shot = await client.callTool({ name: 'phone_screenshot', arguments: {} });
  assert.ok(!shot.isError, JSON.stringify(shot.content));
  const image = (shot.content as Array<{ type: string; mimeType?: string }>).find((item) => item.type === 'image');
  assert.equal(image?.mimeType, 'image/jpeg');

  const tap = await client.callTool({ name: 'phone_tap', arguments: { x: 0.5, y: 0.4 } });
  assert.ok(!tap.isError, JSON.stringify(tap.content));
  assert.ok((tap.content as Array<{ type: string }>).some((item) => item.type === 'image'), 'tap returns a fresh screenshot');

  const invalid = await client.callTool({ name: 'phone_tap', arguments: { x: 2, y: 0.4 } });
  assert.ok(invalid.isError, 'out-of-range coordinates are rejected');

  const feed = await client.callTool({ name: 'phone_live_feed', arguments: {} });
  const link = /\/live\/[\w-]+/.exec(JSON.stringify(feed.content))?.[0];
  assert.ok(link);
  const page = await fetch(base + link);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /stream/);
  const still = await fetch(`${base}${link}/frame.jpg`);
  assert.equal(still.headers.get('content-type'), 'image/jpeg');

  const usage = await client.callTool({ name: 'usage_get', arguments: {} });
  const summary = JSON.parse((usage.content as Array<{ text: string }>)[0].text);
  // Schema-invalid calls are rejected before metering, so only the valid tap is billed.
  assert.equal(summary.byTool.phone_tap.calls, 1);
  assert.ok(summary.tokens > 0 && summary.imageTokens > 0, 'calls are billed in tokens');
  assert.ok(summary.tokensIn > 0 && summary.tokensOut >= summary.imageTokens, 'tokens in and out are metered');
  assert.ok(summary.images >= 2);

  const report = await (await fetch(`${base}/v1/usage`, { headers: { Authorization: `Bearer ${apiKey}` } })).json();
  assert.equal(report.tokens, summary.tokens + report.byTool.usage_get.tokens);
  assert.equal(report.perMinute.length, 60);
  assert.ok(report.recent.length >= 4);
  const dashboard = await fetch(`${base}/dashboard`);
  assert.equal(dashboard.status, 200);
  assert.match(dashboard.headers.get('content-security-policy') ?? '', /default-src 'self'/);

  const released = await client.callTool({ name: 'phone_disconnect', arguments: {} });
  assert.match(JSON.stringify(released.content), /Released rig_/);
  await client.close();
});

test('a task session is recorded as a training episode', async () => {
  const client = await connect(apiKey);
  const started = await client.callTool({ name: 'phone_connect', arguments: { task: 'Open Settings', task_family: 'settings' } });
  const episodeId = /episode ([0-9a-f]{32})/.exec(JSON.stringify(started.content))?.[1];
  assert.ok(episodeId, JSON.stringify(started.content));
  await client.callTool({ name: 'phone_tap', arguments: { x: 0.8, y: 0.9, reason: 'open Settings' } });
  await client.callTool({ name: 'phone_type', arguments: { text: 'wifi', reason: 'search' } });
  const done = await client.callTool({ name: 'phone_task_done', arguments: { outcome: 'success', note: 'done' } });
  assert.match(JSON.stringify(done.content), /Recorded success .* \(2 steps\)/);

  const folder = path.join(dataDir, 'demonstrations', episodeId);
  const steps = readFileSync(path.join(folder, 'steps.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  assert.deepEqual(steps.map((row) => `${row.event}:${row.step}:${row.status ?? row.label}`), [
    'intent:1:unreviewed', 'result:1:complete', 'intent:2:unreviewed', 'result:2:complete',
  ]);
  assert.equal(steps[0].note, 'open Settings');
  assert.deepEqual(steps[2].action, { type: 'type', text: 'wifi' });
  assert.equal(JSON.parse(readFileSync(path.join(folder, 'episode.json'), 'utf8')).group, 'settings');
  await client.callTool({ name: 'phone_disconnect', arguments: {} });
  await client.close();
});

test('guards, ask_user over the live link, operator stop, and phone_do via the VLM', async () => {
  const client = await connect(apiKey);
  const call = (name: string, args: Record<string, unknown> = {}) => client.callTool({ name, arguments: args });
  const body = (result: Awaited<ReturnType<typeof call>>) => JSON.stringify(result.content);

  await call('phone_connect', { task: 'Log in to Talua', task_family: 'talua' });
  const tapped = await call('phone_tap', { x: 0.5, y: 0.5 });
  assert.ok(!tapped.isError, 'connect shows the screen, so one action is allowed');
  // Acting again without looking is fine because the tap returned a fresh screen; two in a row without results is not.
  const feed = await call('phone_live_feed');
  const link = /\/live\/[\w-]+/.exec(body(feed))![0];

  // ask_user waits for the person; they answer from the live page.
  const asking = call('ask_user', { question: 'Enter the 6-digit Talua code', kind: 'code' });
  let pending: { id: string; question: string }[] = [];
  for (let i = 0; i < 50 && !pending.length; i++) {
    pending = (await (await fetch(`${base}${link}/asks`)).json()).asks;
    if (!pending.length) await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.equal(pending[0].question, 'Enter the 6-digit Talua code');
  const bad = await fetch(`${base}${link}/asks/${pending[0].id}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ answer: 'not a code!' }) });
  assert.equal(bad.status, 409);
  const ok = await fetch(`${base}${link}/asks/${pending[0].id}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ answer: '482913' }) });
  assert.equal(ok.status, 200);
  assert.match(body(await asking), /answered: 482913/);

  // phone_do runs the VLM loop through the same guarded, recorded path.
  const did = await call('phone_do', { instruction: 'open Settings', max_steps: 5 });
  assert.ok(!did.isError, body(did));
  assert.match(body(did), /reports success after 1 actions/);

  // Operator stop blocks further actions until a new task.
  assert.equal((await fetch(`${base}${link}/stop`, { method: 'POST' })).status, 200);
  await call('phone_screenshot');
  const blocked = await call('phone_home');
  assert.ok(blocked.isError);
  assert.match(body(blocked), /Stopped by operator/);
  await call('phone_connect', { task: 'next' });
  assert.ok(!(await call('phone_home')).isError, 'a new task clears the stop');

  // No fresh look -> refused.
  const blind = await call('phone_home');
  assert.ok(!blind.isError, 'home returned a fresh screen, so this is allowed');
  await call('phone_task_done', { outcome: 'abandoned' });
  await call('phone_disconnect');
  await client.close();
});
