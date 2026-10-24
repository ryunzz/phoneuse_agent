import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'bun:test';
import type { Frame } from '../src/rigs.js';
import { TraceRecorder, UNSPECIFIED_INSTRUCTION } from '../src/traces.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const home: Frame = { data: readFileSync(path.join(REPO, 'iphone-home-after-test.png')), receivedAt: 1_000_000, seq: 1 };
const settings: Frame = { data: readFileSync(path.join(REPO, 'iphone-settings-test.png')), receivedAt: 1_001_000, seq: 2 };

const rows = (file: string) => readFileSync(file, 'utf8').trim().split('\n').map((line) => JSON.parse(line));

function recorder() {
  const root = mkdtempSync(path.join(tmpdir(), 'traces-'));
  return { root, traces: new TraceRecorder(root, () => 1_002_000) };
}

test('writes an episodes.py-compatible episode with paired, hashed frames', () => {
  const { root, traces } = recorder();
  const { episodeId } = traces.start('key_1', 'rig_a', { instruction: 'Open Settings', group: 'settings' });
  traces.observe('key_1', home);
  const step = traces.beginStep('key_1', 'rig_a', { type: 'tap', x: 0.8, y: 0.9 }, 'tap the Settings icon', settings);
  assert.ok(step);
  traces.completeStep(step, { id: 'x', ok: true, receipt: { done: true } }, settings, 1_001_500);
  traces.finish('key_1', 'success', 'Settings is open', 'agent');

  const folder = path.join(root, episodeId);
  const meta = JSON.parse(readFileSync(path.join(folder, 'episode.json'), 'utf8'));
  assert.equal(meta.instruction, 'Open Settings');
  assert.equal(meta.split, 'train');
  const [intent, result] = rows(path.join(folder, 'steps.jsonl'));
  assert.equal(intent.label, 'unreviewed');
  assert.equal(intent.note, 'tap the Settings icon');
  assert.equal(intent.before.image, '00001-before.jpg');
  assert.equal(intent.before.width, 636);
  assert.equal(intent.before.sha256, createHash('sha256').update(home.data).digest('hex'), 'before = what the agent last saw');
  assert.equal(result.status, 'complete');
  assert.equal(result.after.sha256, createHash('sha256').update(settings.data).digest('hex'));
  assert.ok(existsSync(path.join(folder, '00001-after.jpg')));
  assert.deepEqual(rows(path.join(folder, 'outcome.jsonl'))[0].reported_by, 'agent');
});

test('failed actions are recorded as failed_or_unknown without an after frame', () => {
  const { root, traces } = recorder();
  const { episodeId } = traces.start('key_1', 'rig_a');
  const step = traces.beginStep('key_1', 'rig_a', { type: 'home' }, '', home)!;
  traces.completeStep(step, { id: 'x', ok: false, error: 'Rig timed out' }, null, 1_001_000);
  const [, result] = rows(path.join(root, episodeId, 'steps.jsonl'));
  assert.equal(result.status, 'failed_or_unknown');
  assert.equal(result.error, 'Rig timed out');
  assert.equal(result.after, undefined);
});

test('acting without phone_connect auto-starts; new sessions close the old one as abandoned', () => {
  const { root, traces } = recorder();
  traces.beginStep('key_1', 'rig_a', { type: 'home' }, '', home);
  const first = traces.active('key_1')!;
  assert.equal(first.instruction, UNSPECIFIED_INSTRUCTION);
  traces.start('key_1', 'rig_a', { instruction: 'Next task' });
  assert.equal(rows(path.join(root, first.episodeId, 'outcome.jsonl'))[0].outcome, 'abandoned');
  assert.equal(traces.beginStep('key_2', 'rig_b', { type: 'home' }, '', null), null, 'no frame, no step');
});

test('episodes.py export only takes human-labelled steps from successful episodes', () => {
  const { root, traces } = recorder();
  const { episodeId } = traces.start('key_1', 'rig_a', { instruction: 'Open Settings', group: 'settings' });
  traces.observe('key_1', home);
  const step = traces.beginStep('key_1', 'rig_a', { type: 'tap', x: 0.8, y: 0.9 }, '', null)!;
  traces.completeStep(step, { id: 'x', ok: true }, settings, 1_001_500);
  traces.finish('key_1', 'success', '', 'agent');
  const out = mkdtempSync(path.join(tmpdir(), 'export-'));
  const exportCounts = () =>
    JSON.parse(execFileSync('uv', ['run', 'episodes.py', 'export', '--root', root, '--output', out], { cwd: REPO, encoding: 'utf8' }));

  assert.deepEqual(exportCounts(), { train: 0, eval: 0 }, 'unreviewed agent steps are not training targets');
  execFileSync('uv', ['run', 'episodes.py', 'label', path.join(root, episodeId), '1', 'correct', '--reviewer', 'test'], { cwd: REPO });
  assert.deepEqual(exportCounts(), { train: 1, eval: 0 });
  const [example] = rows(path.join(out, 'train.jsonl'));
  assert.equal(example.instruction, 'Open Settings');
  assert.deepEqual(example.target_action, { type: 'tap', x: 0.8, y: 0.9 });
});
