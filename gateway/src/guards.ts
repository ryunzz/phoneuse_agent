/**
 * Server-side safety rails for agents driving our phones (ported from phone_agent.py):
 * act only on a fresh observation, a per-task action budget, halt after an unknown
 * outcome until the agent looks again, and an operator stop switch.
 */

export interface GuardLimits {
  readonly observationMaxAgeMs: number;
  readonly actionsPerTask: number;
}

interface KeyState {
  readonly observedAt: number | null;
  readonly actions: number;
  readonly needsLook: boolean;
  readonly stoppedReason: string | null;
}

const FRESH: KeyState = { observedAt: null, actions: 0, needsLook: false, stoppedReason: null };

export class GuardError extends Error {}

export class Guards {
  private states = new Map<string, KeyState>();

  constructor(private readonly limits: GuardLimits, private readonly now: () => number = Date.now) {}

  private get(keyId: string): KeyState {
    return this.states.get(keyId) ?? FRESH;
  }

  private set(keyId: string, next: KeyState): void {
    this.states = new Map(this.states).set(keyId, next);
  }

  /** A new task (phone_connect) resets the budget and clears a stop. */
  startTask(keyId: string): void {
    this.set(keyId, FRESH);
  }

  /** The agent was just shown the screen (screenshot or an action's after-frame). */
  observed(keyId: string): void {
    this.set(keyId, { ...this.get(keyId), observedAt: this.now(), needsLook: false });
  }

  /** Throws unless the agent may dispatch one more action right now. */
  beforeAction(keyId: string): void {
    const state = this.get(keyId);
    if (state.stoppedReason) throw new GuardError(`Stopped by operator: ${state.stoppedReason}. Call phone_connect to start a new task.`);
    if (state.needsLook) throw new GuardError('The last action had an unknown outcome. Call phone_screenshot and check the screen before acting again.');
    if (state.observedAt === null || this.now() - state.observedAt > this.limits.observationMaxAgeMs) {
      throw new GuardError('Take a fresh phone_screenshot before acting; the agent must look at the current screen.');
    }
    if (state.actions >= this.limits.actionsPerTask) {
      throw new GuardError(`Action budget of ${this.limits.actionsPerTask} reached for this task. Call phone_task_done, then phone_connect for a new task.`);
    }
    this.set(keyId, { ...state, actions: state.actions + 1, observedAt: null });
  }

  /** After a failed or unknown action, require a new look instead of blind retries. */
  outcomeUnknown(keyId: string): void {
    this.set(keyId, { ...this.get(keyId), needsLook: true });
  }

  stop(keyId: string, reason: string): void {
    this.set(keyId, { ...this.get(keyId), stoppedReason: reason.slice(0, 200) || 'stop requested' });
  }

  status(keyId: string): { actions: number; budget: number; stopped: string | null } {
    const state = this.get(keyId);
    return { actions: state.actions, budget: this.limits.actionsPerTask, stopped: state.stoppedReason };
  }
}
