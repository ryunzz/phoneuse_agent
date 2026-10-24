import type { PhoneAction } from './actions.js';
import type { Limits } from './config.js';
import type { Guards } from './guards.js';
import type { Frame, RigHub } from './rigs.js';
import type { EpisodeInfo, Outcome, TraceRecorder } from './traces.js';

export interface SessionDeps {
  readonly keyId: string;
  readonly hub: RigHub;
  readonly traces: TraceRecorder | null;
  readonly guards: Guards;
  readonly limits: Limits;
}

export interface ActOutcome {
  readonly ok: boolean;
  readonly rigId: string;
  readonly error?: string;
  readonly frame: Frame | null;
}

/**
 * One API key's view of its phone: lease, observation, guarded actions and trace
 * recording. MCP tools and the VLM runner both go through here, so every action
 * path gets the same safety rails and the same training data.
 */
export class PhoneSession {
  constructor(private readonly deps: SessionDeps) {}

  /** Trace writes never block the user's action; a failed write only loses training data. */
  private traced<T>(what: string, write: (traces: TraceRecorder) => T): T | null {
    if (!this.deps.traces) return null;
    try {
      return write(this.deps.traces);
    } catch (error) {
      console.error(`[traces] ${what} failed`, error);
      return null;
    }
  }

  rig(): string {
    const { hub, keyId } = this.deps;
    return hub.touch(keyId, hub.leaseFor(keyId) ?? hub.acquire(keyId));
  }

  /** Record that the agent was shown this frame. */
  observe(frame: Frame | null): Frame | null {
    if (!frame) return null;
    this.deps.guards.observed(this.deps.keyId);
    this.traced('observe', (traces) => traces.observe(this.deps.keyId, frame));
    return frame;
  }

  connect(rigId?: string, task?: string, family?: string): { rigId: string; episode: EpisodeInfo | null; frame: Frame | null } {
    const leased = this.deps.hub.acquire(this.deps.keyId, rigId);
    this.deps.guards.startTask(this.deps.keyId);
    const episode = this.traced('start episode', (traces) => traces.start(this.deps.keyId, leased, { instruction: task, group: family }));
    return { rigId: leased, episode, frame: this.observe(this.deps.hub.latestFrame(leased)) };
  }

  async screenshot(): Promise<{ rigId: string; frame: Frame | null }> {
    const rigId = this.rig();
    const frame = await this.deps.hub.nextFrame(rigId, Date.now() - 1500, 3000);
    return { rigId, frame: this.observe(frame) };
  }

  /** Guarded dispatch: fresh look required, budgeted, recorded, halts after unknown outcomes. */
  async act(action: PhoneAction, reason: string): Promise<ActOutcome> {
    const { keyId, hub, guards, limits } = this.deps;
    const rigId = this.rig();
    guards.beforeAction(keyId);
    const step = this.traced('begin step', (traces) => traces.beginStep(keyId, rigId, action, reason, hub.latestFrame(rigId)));
    const result = await hub.send(rigId, action);
    const endedAt = Date.now();
    let frame: Frame | null = null;
    if (result.ok) {
      const settledAt = endedAt + limits.settleMs;
      await new Promise((resolve) => setTimeout(resolve, limits.settleMs));
      frame = await hub.nextFrame(rigId, settledAt, 3000);
    }
    if (step) this.traced('complete step', (traces) => traces.completeStep(step, result, frame, endedAt));
    if (!result.ok || !frame) {
      guards.outcomeUnknown(keyId);
      return { ok: false, rigId, frame: null, error: result.ok ? 'No settled screen after the action; outcome unknown.' : (result.error ?? 'unknown error') };
    }
    return { ok: true, rigId, frame: this.observe(frame) };
  }

  finish(outcome: Outcome, note: string, by: 'agent' | 'gateway'): EpisodeInfo | null {
    return this.traced('finish episode', (traces) => traces.finish(this.deps.keyId, outcome, note, by));
  }

  disconnect(): string | null {
    this.finish('abandoned', 'disconnected without phone_task_done', 'gateway');
    return this.deps.hub.release(this.deps.keyId);
  }
}
