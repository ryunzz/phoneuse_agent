import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'bun:test';
import { estimateImageTokens, jpegSize, UsageLedger } from '../src/usage.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const base = { keyId: 'key_1', rigId: 'rig_a', durationMs: 1000, images: 1, imageBytes: 10, imageTokens: 400 };

function ledger(now = () => Date.parse('2026-10-24T12:00:30Z')) {
  return new UsageLedger(path.join(mkdtempSync(path.join(tmpdir(), 'usage-')), 'usage.jsonl'), { phone_tap: 100 }, now);
}

test('successful calls bill base price plus image tokens; failures are free', () => {
  const usage = ledger();
  assert.equal(usage.record({ ...base, tool: 'phone_tap', ok: true }).tokens, 500);
  assert.equal(usage.record({ ...base, tool: 'phone_tap', ok: false }).tokens, 0);
  assert.equal(usage.record({ ...base, tool: 'unpriced', ok: true, imageTokens: 0 }).tokens, 0);
  const summary = usage.summary('key_1');
  assert.equal(summary.tokens, 500);
  assert.equal(summary.failedCalls, 1);
  assert.deepEqual(summary.byTool.phone_tap, { calls: 2, tokens: 500 });
});

test('report gives 60 zero-filled minutes and newest-first recent calls', () => {
  const usage = ledger();
  usage.record({ ...base, tool: 'phone_tap', ok: true });
  usage.record({ ...base, tool: 'phone_screenshot', ok: true });
  const report = usage.report('key_1');
  assert.equal(report.perMinute.length, 60);
  assert.equal(report.perMinute.at(-1)?.minute, '2026-10-24T12:00:00.000Z');
  assert.equal(report.perMinute.at(-1)?.tokens, 900);
  assert.equal(report.recent[0].tool, 'phone_screenshot');
  assert.deepEqual(report.pricing, { phone_tap: 100 });
});

test('ledger reloads from disk, including lines written before token metering', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'usage-'));
  const file = path.join(dir, 'usage.jsonl');
  writeFileSync(file, JSON.stringify({ keyId: 'key_1', tool: 'phone_tap', rigId: null, ok: true, durationMs: 5, images: 0, imageBytes: 0, at: '2026-10-24T11:00:00Z' }) + '\nnot json\n');
  const first = new UsageLedger(file, { phone_tap: 100 });
  first.record({ ...base, tool: 'phone_tap', ok: true });
  const reloaded = new UsageLedger(file, { phone_tap: 100 });
  assert.equal(reloaded.summary('key_1').calls, 2);
  assert.equal(reloaded.summary('key_1').tokens, 500);
});

test('reads JPEG dimensions from a real phone capture', () => {
  const size = jpegSize(readFileSync(path.join(REPO, 'iphone-home-after-test.png')));
  assert.deepEqual(size, { width: 636, height: 1402 });
  assert.equal(jpegSize(Buffer.from('not a jpeg')), null);
  assert.equal(estimateImageTokens(636, 1402), Math.ceil((636 * 1402) / 750));
  assert.ok(estimateImageTokens(3000, 6000) < Math.ceil((3000 * 6000) / 750), 'large images are downscaled');
});
