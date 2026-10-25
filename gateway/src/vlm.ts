import { z } from 'zod';
import { phoneActionSchema, type PhoneAction } from './actions.js';

/**
 * Vision-language-action provider: (instruction, current screen, recent actions) -> next action.
 * Selected by VLM_PROVIDER; vendor details stay inside the adapter so swapping models is env-only.
 *
 * Custom VLM HTTP contract (VLM_PROVIDER=http):
 *   POST $VLM_URL   Authorization: Bearer $VLM_API_KEY (optional)
 *   { instruction, image_jpeg_base64, step, history: [{ action }] }
 *   -> { action: <phone action> }  or  { done: true, outcome: "success"|"failed", note? }
 */

export interface VlmInput {
  readonly instruction: string;
  readonly image: Buffer;
  readonly step: number;
  readonly history: readonly { readonly action: PhoneAction }[];
}

export type VlmDecision =
  | { readonly kind: 'act'; readonly action: PhoneAction; readonly reason?: string }
  | { readonly kind: 'done'; readonly outcome: 'success' | 'failed'; readonly note?: string };

export interface VlmProvider {
  readonly name: string;
  next(input: VlmInput, signal?: AbortSignal): Promise<VlmDecision>;
}

export class VlmError extends Error {}

const responseSchema = z.union([
  z.object({ action: phoneActionSchema, reason: z.string().max(500).optional() }),
  z.object({ done: z.literal(true), outcome: z.enum(['success', 'failed']), note: z.string().max(2000).optional() }),
]);

export function parseDecision(body: unknown): VlmDecision {
  const parsed = responseSchema.safeParse(body);
  if (!parsed.success) throw new VlmError('VLM returned an invalid decision');
  return 'action' in parsed.data
    ? { kind: 'act', action: parsed.data.action, reason: parsed.data.reason }
    : { kind: 'done', outcome: parsed.data.outcome, note: parsed.data.note };
}

export class HttpVlm implements VlmProvider {
  readonly name = 'http';

  constructor(private readonly url: string, private readonly apiKey: string | null, private readonly timeoutMs = 20_000) {}

  async next(input: VlmInput, signal?: AbortSignal): Promise<VlmDecision> {
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
      throw new VlmError('VLM endpoint unreachable or timed out');
    }
    if (!response.ok) throw new VlmError(`VLM endpoint returned HTTP ${response.status}`);
    return parseDecision(await response.json().catch(() => null));
  }
}

/** Scripted provider for tests and demos without a model. */
export class ScriptedVlm implements VlmProvider {
  readonly name = 'scripted';

  constructor(private readonly decisions: readonly VlmDecision[]) {}

  async next(input: VlmInput): Promise<VlmDecision> {
    return this.decisions[input.step - 1] ?? { kind: 'done', outcome: 'failed', note: 'script exhausted' };
  }
}

export function createVlmProvider(env: NodeJS.ProcessEnv = process.env): VlmProvider | null {
  const provider = (env.VLM_PROVIDER ?? 'none').toLowerCase();
  if (provider === 'none') return null;
  if (provider === 'http') {
    const url = env.VLM_URL ?? '';
    if (!/^https?:\/\//.test(url)) throw new Error('VLM_PROVIDER=http needs VLM_URL (http/https)');
    return new HttpVlm(url, env.VLM_API_KEY?.trim() || null);
  }
  throw new Error(`Unknown VLM_PROVIDER "${provider}" (supported: none, http)`);
}
