import { randomUUID } from 'node:crypto';
import type { Limits } from './config.js';
import type { PhoneAction } from './actions.js';

export interface Frame {
  readonly data: Buffer;
  readonly receivedAt: number;
  readonly seq: number;
}

export interface Command {
  readonly id: string;
  readonly action: PhoneAction;
}

export interface CommandResult {
  readonly id: string;
  readonly ok: boolean;
  readonly receipt?: unknown;
  readonly error?: string;
}

export interface Lease {
  readonly keyId: string;
  readonly expiresAt: number;
}

export interface RigInfo {
  readonly id: string;
  readonly name: string;
  readonly online: boolean;
  readonly available: boolean;
  readonly leasedByYou: boolean;
  readonly frameAgeMs: number | null;
}

interface Pending {
  readonly resolve: (result: CommandResult) => void;
  readonly timer: NodeJS.Timeout;
}

type FrameListener = (frame: Frame) => void;

interface RigState {
  lastPollAt: number;
  queue: readonly Command[];
  waiter: ((command: Command | null) => void) | null;
  frame: Frame | null;
  lease: Lease | null;
  readonly pending: Map<string, Pending>;
  readonly listeners: Set<FrameListener>;
}

export class RigError extends Error {}

/**
 * In-memory routing between API-key holders and connected rigs. Rigs connect outbound
 * with HTTP long polls; one key leases a rig at a time.
 */
export class RigHub {
  private readonly rigs = new Map<string, RigState>();

  constructor(
    private readonly names: () => ReadonlyMap<string, string>,
    private readonly limits: Limits,
    private readonly now: () => number = Date.now,
  ) {}

  private state(rigId: string): RigState {
    let state = this.rigs.get(rigId);
    if (!state) {
      state = { lastPollAt: 0, queue: [], waiter: null, frame: null, lease: null, pending: new Map(), listeners: new Set() };
      this.rigs.set(rigId, state);
    }
    return state;
  }

  private online(state: RigState): boolean {
    return this.now() - state.lastPollAt < this.limits.rigOnlineMs;
  }

  private activeLease(state: RigState): Lease | null {
    return state.lease && state.lease.expiresAt > this.now() ? state.lease : null;
  }

  // ---- rig side ----

  /** Long poll: resolves with the next command, or null after waitMs. */
  poll(rigId: string, waitMs: number): Promise<Command | null> {
    const state = this.state(rigId);
    state.lastPollAt = this.now();
    const [next, ...rest] = state.queue;
    if (next) {
      state.queue = rest;
      return Promise.resolve(next);
    }
    // A newer poll replaces an older one (e.g. the rig restarted mid-poll).
    state.waiter?.(null);
    return new Promise((resolve) => {
      const timer = setTimeout(() => finish(null), waitMs);
      const finish = (command: Command | null): void => {
        clearTimeout(timer);
        if (state.waiter === finish) state.waiter = null;
        state.lastPollAt = this.now();
        resolve(command);
      };
      state.waiter = finish;
    });
  }

  /** Called when the rig's HTTP connection closes before a command was delivered. */
  cancelPoll(rigId: string): void {
    this.rigs.get(rigId)?.waiter?.(null);
  }

  submitResult(rigId: string, result: CommandResult): boolean {
    const pending = this.rigs.get(rigId)?.pending.get(result.id);
    if (!pending) return false;
    pending.resolve(result);
    return true;
  }

  pushFrame(rigId: string, data: Buffer): Frame {
    const state = this.state(rigId);
    const frame: Frame = { data, receivedAt: this.now(), seq: (state.frame?.seq ?? 0) + 1 };
    state.frame = frame;
    for (const listener of state.listeners) listener(frame);
    return frame;
  }

  // ---- client side ----

  list(keyId: string): readonly RigInfo[] {
    return [...this.names()].map(([id, name]) => {
      const state = this.rigs.get(id);
      const lease = state ? this.activeLease(state) : null;
      const online = state ? this.online(state) : false;
      return {
        id,
        name,
        online,
        available: online && (!lease || lease.keyId === keyId),
        leasedByYou: lease?.keyId === keyId,
        frameAgeMs: state?.frame ? this.now() - state.frame.receivedAt : null,
      };
    });
  }

  leaseFor(keyId: string): string | null {
    for (const [id, state] of this.rigs) {
      if (this.activeLease(state)?.keyId === keyId) return id;
    }
    return null;
  }

  /** Lease a specific rig, or any available one. Renews an existing lease. */
  acquire(keyId: string, rigId?: string): string {
    const current = this.leaseFor(keyId);
    if (current && (!rigId || rigId === current)) return this.touch(keyId, current);
    if (current) this.release(keyId);
    const candidates = rigId ? [rigId] : [...this.names().keys()];
    for (const id of candidates) {
      if (!this.names().has(id)) throw new RigError(`Unknown rig ${id}`);
      const state = this.state(id);
      if (this.online(state) && !this.activeLease(state)) {
        state.lease = { keyId, expiresAt: this.now() + this.limits.leaseIdleMs };
        return id;
      }
    }
    throw new RigError(rigId ? `Rig ${rigId} is offline or in use` : 'No rig is available right now; try again shortly');
  }

  touch(keyId: string, rigId: string): string {
    const state = this.state(rigId);
    if (this.activeLease(state)?.keyId !== keyId) throw new RigError('Your rig lease expired; call phone_connect again');
    state.lease = { keyId, expiresAt: this.now() + this.limits.leaseIdleMs };
    return rigId;
  }

  release(keyId: string): string | null {
    const rigId = this.leaseFor(keyId);
    if (rigId) this.state(rigId).lease = null;
    return rigId;
  }

  /** Queue an action for the rig and wait for its terminal result. No automatic retries. */
  send(rigId: string, action: PhoneAction): Promise<CommandResult> {
    const state = this.state(rigId);
    if (!this.online(state)) return Promise.reject(new RigError('Rig went offline'));
    const command: Command = { id: randomUUID(), action };
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        state.pending.delete(command.id);
        state.queue = state.queue.filter((queued) => queued.id !== command.id);
        resolve({ id: command.id, ok: false, error: 'Rig did not answer in time; outcome unknown. Take a screenshot before retrying.' });
      }, this.limits.commandTimeoutMs);
      state.pending.set(command.id, {
        timer,
        resolve: (result) => {
          clearTimeout(timer);
          state.pending.delete(command.id);
          resolve(result);
        },
      });
      if (state.waiter) state.waiter(command);
      else state.queue = [...state.queue, command];
    });
  }

  latestFrame(rigId: string): Frame | null {
    return this.rigs.get(rigId)?.frame ?? null;
  }

  /** Wait for a frame received after `after` (ms epoch). */
  nextFrame(rigId: string, after: number, timeoutMs: number): Promise<Frame | null> {
    const state = this.state(rigId);
    if (state.frame && state.frame.receivedAt > after) return Promise.resolve(state.frame);
    return new Promise((resolve) => {
      const listener: FrameListener = (frame) => {
        if (frame.receivedAt <= after) return;
        done(frame);
      };
      const timer = setTimeout(() => done(null), timeoutMs);
      const done = (frame: Frame | null): void => {
        clearTimeout(timer);
        state.listeners.delete(listener);
        resolve(frame);
      };
      state.listeners.add(listener);
    });
  }

  subscribe(rigId: string, listener: FrameListener): () => void {
    const state = this.state(rigId);
    state.listeners.add(listener);
    return () => state.listeners.delete(listener);
  }
}
