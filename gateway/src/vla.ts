import { z } from 'zod';
import { phoneActionSchema, type PhoneAction } from './actions.js';

/**
 * Vision-language-action provider: (instruction, current screen, recent actions) -> next action.
 * Selected by VLA_PROVIDER; vendor details stay inside the adapter so swapping models is env-only.
 *
 * Custom VLA HTTP contract (VLA_PROVIDER=http):
 *   POST $VLA_URL   Authorization: Bearer $VLA_API_KEY (optional)
 *   { instruction, image_jpeg_base64, step, history: [{ action }] }
 *   -> { action: <phone action> }  or  { done: true, outcome: "success"|"failed", note? }
 */

export interface VlaInput {
  readonly instruction: string;
  readonly image: Buffer;
  readonly step: number;
  readonly history: readonly { readonly action: PhoneAction }[];
}

export type VlaDecision =
  | { readonly kind: 'act'; readonly action: PhoneAction; readonly reason?: string }
  | { readonly kind: 'done'; readonly outcome: 'success' | 'failed'; readonly note?: string };

export interface VlaProvider {
  readonly name: string;
  next(input: VlaInput, signal?: AbortSignal): Promise<VlaDecision>;
}

export class VlaError extends Error {}

const responseSchema = z.union([
  z.object({ action: phoneActionSchema, reason: z.string().max(500).optional() }),
  z.object({ done: z.literal(true), outcome: z.enum(['success', 'failed']), note: z.string().max(2000).optional() }),
]);

export function parseDecision(body: unknown): VlaDecision {
  const parsed = responseSchema.safeParse(body);
  if (!parsed.success) throw new VlaError('VLA returned an invalid decision');
  return 'action' in parsed.data
    ? { kind: 'act', action: parsed.data.action, reason: parsed.data.reason }
    : { kind: 'done', outcome: parsed.data.outcome, note: parsed.data.note };
}

export class HttpVla implements VlaProvider {
  readonly name = 'http';

  constructor(private readonly url: string, private readonly apiKey: string | null, private readonly timeoutMs = 20_000) {}

  async next(input: VlaInput, signal?: AbortSignal): Promise<VlaDecision> {
    const timeout = AbortSignal.timeout(this.timeoutMs);
    let response: Response;
    try {
      response = await fetch(this.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}) },
        body: JSON.stringify({
          instruction: input.instruction,
          image_jpeg_base64: input.image.toString('base64'),
          step: input.step,
          history: input.history,
        }),
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });
    } catch {
      throw new VlaError('VLA endpoint unreachable or timed out');
    }
    if (!response.ok) throw new VlaError(`VLA endpoint returned HTTP ${response.status}`);
    return parseDecision(await response.json().catch(() => null));
  }
}

/** Scripted provider for tests and demos without a model. */
export class ScriptedVla implements VlaProvider {
  readonly name = 'scripted';

  constructor(private readonly decisions: readonly VlaDecision[]) {}

  async next(input: VlaInput): Promise<VlaDecision> {
    return this.decisions[input.step - 1] ?? { kind: 'done', outcome: 'failed', note: 'script exhausted' };
  }
}

export function createVlaProvider(env: NodeJS.ProcessEnv = process.env): VlaProvider | null {
  const provider = (env.VLA_PROVIDER ?? 'none').toLowerCase();
  if (provider === 'none') return null;
  if (provider === 'http') {
    const url = env.VLA_URL ?? '';
    if (!/^https?:\/\//.test(url)) throw new Error('VLA_PROVIDER=http needs VLA_URL (http/https)');
    return new HttpVla(url, env.VLA_API_KEY?.trim() || null);
  }
  throw new Error(`Unknown VLA_PROVIDER "${provider}" (supported: none, http)`);
}
