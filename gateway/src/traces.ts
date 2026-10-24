import { createHash, randomUUID } from 'node:crypto';
import { appendFileSync, closeSync, fsyncSync, mkdirSync, openSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { PhoneAction } from './actions.js';
import type { CommandResult, Frame } from './rigs.js';
import { jpegSize } from './usage.js';

/**
 * Records every gateway session as a training episode in the exact on-disk format of
 * episodes.py (episode.json, steps.jsonl, NNNNN-before/after.jpg, outcome.jsonl), so
 * `episodes.py export` and human review work unchanged. Steps start as `unreviewed`;
 * only human-labelled correct/recovery steps in successful episodes are ever exported.
 */

export type Split = 'train' | 'eval';
export type Outcome = 'success' | 'failed' | 'abandoned';

export interface EpisodeOptions {
  readonly instruction?: string;
  readonly group?: string;
  readonly split?: Split;
}

export interface EpisodeInfo {
  readonly episodeId: string;
  readonly rigId: string;
  readonly instruction: string;
  readonly steps: number;
}

export interface StepHandle {
  readonly keyId: string;
  readonly episodeId: string;
  readonly folder: string;
  readonly step: number;
}

interface OpenEpisode {
  readonly info: EpisodeInfo;
  readonly folder: string;
  readonly lastObservation: Frame | null;
}

export const UNSPECIFIED_INSTRUCTION = '(not provided)';
export const UNSPECIFIED_GROUP = 'unspecified';

const seconds = (ms: number): number => ms / 1000;

function appendDurable(file: string, row: unknown): void {
  const fd = openSync(file, 'a', 0o600);
  try {
    appendFileSync(fd, JSON.stringify(row) + '\n');
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function clean(value: string | undefined, fallback: string, limit: number): string {
  const trimmed = value?.trim();
  return trimmed ? trimmed.slice(0, limit) : fallback;
}

export class TraceRecorder {
  private open = new Map<string, OpenEpisode>();

  constructor(private readonly root: string, private readonly now: () => number = Date.now) {
    mkdirSync(root, { recursive: true, mode: 0o700 });
  }

  /** Start a new episode for this key, closing any open one as abandoned. */
  start(keyId: string, rigId: string, options: EpisodeOptions = {}): EpisodeInfo {
    this.finish(keyId, 'abandoned', 'superseded by a new session', 'gateway');
    const episodeId = randomUUID().replaceAll('-', '');
    const folder = path.join(this.root, episodeId);
    mkdirSync(folder, { mode: 0o700 });
    const instruction = clean(options.instruction, UNSPECIFIED_INSTRUCTION, 2000);
    const meta = {
      schema_version: 1,
      episode_id: episodeId,
      instruction,
      group: clean(options.group, UNSPECIFIED_GROUP, 200),
      split: options.split ?? 'train',
      started_at: seconds(this.now()),
      source: 'gateway',
      rig_id: rigId,
      key_id: keyId,
    };
    writeFileSync(path.join(folder, 'episode.json'), JSON.stringify(meta, null, 2), { mode: 0o600 });
    const info: EpisodeInfo = { episodeId, rigId, instruction, steps: 0 };
    this.open = new Map(this.open).set(keyId, { info, folder, lastObservation: null });
    return info;
  }

  active(keyId: string): EpisodeInfo | null {
    return this.open.get(keyId)?.info ?? null;
  }

  /** Remember the last frame returned to the agent: that is what it acted on. */
  observe(keyId: string, frame: Frame): void {
    const episode = this.open.get(keyId);
    if (episode) this.open = new Map(this.open).set(keyId, { ...episode, lastObservation: frame });
  }

  private saveImage(folder: string, step: number, phase: 'before' | 'after', frame: Frame, rigId: string) {
    const image = `${String(step).padStart(5, '0')}-${phase}.jpg`;
    writeFileSync(path.join(folder, image), frame.data, { mode: 0o600 });
    const size = jpegSize(frame.data);
    return {
      source: 'gateway',
      rig_id: rigId,
      frame_seq: frame.seq,
      received_at: seconds(frame.receivedAt),
      width: size?.width ?? null,
      height: size?.height ?? null,
      image,
      sha256: createHash('sha256').update(frame.data).digest('hex'),
    };
  }

  /**
   * Write the before-image and a durable intent row before dispatch. Auto-starts an
   * episode if the agent acts without phone_connect, and starts a fresh one if the rig changed.
   */
  beginStep(keyId: string, rigId: string, action: PhoneAction, note: string, current: Frame | null): StepHandle | null {
    let episode = this.open.get(keyId);
    if (!episode || episode.info.rigId !== rigId) {
      this.start(keyId, rigId);
      episode = this.open.get(keyId)!;
    }
    const before = episode.lastObservation ?? current;
    if (!before) return null;
    const step = episode.info.steps + 1;
    const intent = {
      event: 'intent',
      step,
      action,
      before: this.saveImage(episode.folder, step, 'before', before, rigId),
      label: 'unreviewed',
      note: note.slice(0, 2000),
      dispatched_at: seconds(this.now()),
    };
    appendDurable(path.join(episode.folder, 'steps.jsonl'), intent);
    this.open = new Map(this.open).set(keyId, { ...episode, info: { ...episode.info, steps: step } });
    return { keyId, episodeId: episode.info.episodeId, folder: episode.folder, step };
  }

  completeStep(handle: StepHandle, result: CommandResult, after: Frame | null, endedAt: number): void {
    const episode = this.open.get(handle.keyId);
    const rigId = episode?.info.rigId ?? 'unknown';
    const base = { event: 'result', step: handle.step, recorded_at: seconds(this.now()) };
    const row = result.ok && after
      ? { ...base, status: 'complete', receipt: result.receipt ?? null, dispatch_ended_at: seconds(endedAt), after: this.saveImage(handle.folder, handle.step, 'after', after, rigId) }
      : { ...base, status: 'failed_or_unknown', error: result.ok ? 'No settled after-frame from the rig' : (result.error ?? 'Action failed') };
    appendDurable(path.join(handle.folder, 'steps.jsonl'), row);
    if (row.status === 'complete' && after && episode?.info.episodeId === handle.episodeId) this.observe(handle.keyId, after);
  }

  /** Close the key's open episode. Agent-reported outcomes are claims; humans still label steps. */
  finish(keyId: string, outcome: Outcome, note: string, reportedBy: 'agent' | 'gateway' | 'reviewer'): EpisodeInfo | null {
    const episode = this.open.get(keyId);
    if (!episode) return null;
    appendDurable(path.join(episode.folder, 'outcome.jsonl'), {
      outcome,
      note: note.slice(0, 2000),
      finished_at: seconds(this.now()),
      reported_by: reportedBy,
    });
    const next = new Map(this.open);
    next.delete(keyId);
    this.open = next;
    return episode.info;
  }
}
