import { randomUUID } from 'node:crypto';

/**
 * Human-in-the-loop questions (2FA codes, confirmations). The agent asks through
 * ask_user; the person answers from the live page or the API; the agent's call
 * returns the answer. Answers are never written to traces or logs.
 */

export type AskKind = 'code' | 'text' | 'confirm';

export interface Ask {
  readonly id: string;
  readonly keyId: string;
  readonly question: string;
  readonly kind: AskKind;
  readonly createdAt: number;
  readonly expiresAt: number;
  readonly answer: string | null;
}

export type PublicAsk = Omit<Ask, 'answer' | 'keyId'> & { readonly answered: boolean };

type Waiter = (answer: string | null) => void;

export class AskError extends Error {}

export class Asks {
  private asks = new Map<string, Ask>();
  private waiters = new Map<string, Set<Waiter>>();

  constructor(private readonly ttlMs: number, private readonly now: () => number = Date.now) {}

  create(keyId: string, question: string, kind: AskKind): Ask {
    this.prune();
    const ask: Ask = { id: randomUUID(), keyId, question: question.slice(0, 500), kind, createdAt: this.now(), expiresAt: this.now() + this.ttlMs, answer: null };
    this.asks = new Map(this.asks).set(ask.id, ask);
    return ask;
  }

  get(keyId: string, id: string): Ask | null {
    const ask = this.asks.get(id);
    return ask && ask.keyId === keyId ? ask : null;
  }

  pending(keyId: string): readonly PublicAsk[] {
    return [...this.asks.values()]
      .filter((ask) => ask.keyId === keyId && ask.answer === null && ask.expiresAt > this.now())
      .map(({ id, question, kind, createdAt, expiresAt }) => ({ id, question, kind, createdAt, expiresAt, answered: false }));
  }

  answer(keyId: string, id: string, raw: string): void {
    const ask = this.get(keyId, id);
    if (!ask || ask.expiresAt <= this.now()) throw new AskError('This question is no longer open.');
    if (ask.answer !== null) throw new AskError('This question was already answered.');
    const value = raw.trim();
    if (ask.kind === 'code' && !/^[A-Za-z0-9-]{3,12}$/.test(value)) throw new AskError('Codes are 3-12 letters or digits.');
    if (ask.kind === 'confirm' && !['yes', 'no'].includes(value.toLowerCase())) throw new AskError('Answer yes or no.');
    if (!value || value.length > 500) throw new AskError('Answer must be 1-500 characters.');
    this.asks = new Map(this.asks).set(id, { ...ask, answer: value });
    for (const waiter of this.waiters.get(id) ?? []) waiter(value);
    this.waiters.delete(id);
  }

  /** Resolve with the answer, or null if none arrives within waitMs. */
  wait(keyId: string, id: string, waitMs: number): Promise<string | null> {
    const ask = this.get(keyId, id);
    if (!ask) return Promise.reject(new AskError('Unknown question id.'));
    if (ask.answer !== null) return Promise.resolve(ask.answer);
    return new Promise((resolve) => {
      const waiters = this.waiters.get(id) ?? new Set<Waiter>();
      const done: Waiter = (answer) => {
        clearTimeout(timer);
        waiters.delete(done);
        resolve(answer);
      };
      const timer = setTimeout(() => done(null), Math.max(0, Math.min(waitMs, ask.expiresAt - this.now())));
      waiters.add(done);
      this.waiters.set(id, waiters);
    });
  }

  private prune(): void {
    const now = this.now();
    this.asks = new Map([...this.asks].filter(([, ask]) => ask.expiresAt > now - 60_000));
  }
}
