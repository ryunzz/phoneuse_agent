import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
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
  const config: Config = { host: '127.0.0.1', port: 0, publicUrl: 'http://placeholder', dataDir, limits: { ...DEFAULT_LIMITS, settleMs: 100 } };
  gateway = createGateway(config, store);
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
    'phone_connect', 'phone_disconnect', 'phone_home', 'phone_live_feed', 'phone_screenshot',
    'phone_scroll', 'phone_tap', 'phone_type', 'rigs_list', 'usage_get',
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
  assert.equal(summary.byTool.phone_tap, 1);
  assert.ok(summary.images >= 2);

  const released = await client.callTool({ name: 'phone_disconnect', arguments: {} });
  assert.match(JSON.stringify(released.content), /Released rig_/);
  await client.close();
});
