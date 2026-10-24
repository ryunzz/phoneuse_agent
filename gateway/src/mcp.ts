import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { PhoneAction } from './actions.js';
import { AskError, type Asks } from './asks.js';
import type { Limits } from './config.js';
import { GuardError, type Guards } from './guards.js';
import type { LiveViews } from './live.js';
import { RigError, type Frame, type RigHub } from './rigs.js';
import { PhoneSession } from './session.js';
import type { TraceRecorder } from './traces.js';
import { estimateImageTokens, estimateTextTokens, jpegSize, type UsageLedger } from './usage.js';
import { VlaError, type VlaProvider } from './vla.js';

export interface McpContext {
  readonly keyId: string;
  readonly hub: RigHub;
  readonly usage: UsageLedger;
  readonly live: LiveViews;
  readonly publicUrl: string;
  readonly limits: Limits;
  readonly traces: TraceRecorder | null;
  readonly guards: Guards;
  readonly asks: Asks;
  readonly vla: VlaProvider | null;
}

const INSTRUCTIONS = `Phone Use drives a real phone on a hardware rig.
Typical loop: phone_screenshot -> decide -> phone_tap / phone_scroll / phone_type / phone_home -> look at the returned screenshot -> repeat.
Coordinates are normalized 0-1 across the screenshot (x from left, y from top).
Rules enforced by the server: act only right after looking at the screen; after a failed or unknown action, take a new screenshot first; each task has an action budget; an operator can stop you.
When you need something only the person has (a 2FA code, a confirmation), call ask_user and wait for the answer. Never guess codes.
Start each task with phone_connect(task=...) and end it with phone_task_done. Pass a short reason with each action.
Give the user phone_live_feed's link if they want to watch.
Sessions are recorded (screens, actions, typed text, reasons) to train our phone model; do not type secrets you would not want stored.`;

const coordinate = z.number().min(0).max(1);
const reason = z.string().max(500).optional().describe('Briefly, what you are doing and why (recorded for training).');
const EXPECTED_ERRORS = [RigError, GuardError, AskError, VlaError];

function text(message: string): CallToolResult {
  return { content: [{ type: 'text', text: message }] };
}

function failure(message: string): CallToolResult {
  return { ...text(message), isError: true };
}

function withFrame(message: string, frame: Frame | null): CallToolResult {
  if (!frame) return text(`${message}\n(No fresh screenshot is available from the rig.)`);
  return {
    content: [
      { type: 'text', text: `${message}\nScreenshot age: ${Date.now() - frame.receivedAt} ms.` },
      { type: 'image', data: frame.data.toString('base64'), mimeType: 'image/jpeg' },
    ],
  };
}

/** Image and text token estimates for what we send back to the agent. */
function outputStats(result: CallToolResult): { images: number; imageBytes: number; imageTokens: number; textTokens: number } {
  return result.content.reduce(
    (stats, item) => {
      if (item.type === 'text') return { ...stats, textTokens: stats.textTokens + estimateTextTokens(item.text) };
      if (item.type !== 'image') return stats;
      const data = Buffer.from(item.data, 'base64');
      const size = jpegSize(data);
      return {
        ...stats,
        images: stats.images + 1,
        imageBytes: stats.imageBytes + data.length,
        imageTokens: stats.imageTokens + (size ? estimateImageTokens(size.width, size.height) : 0),
      };
    },
    { images: 0, imageBytes: 0, imageTokens: 0, textTokens: 0 },
  );
}

export function createMcpServer(ctx: McpContext): McpServer {
  const server = new McpServer({ name: 'phoneuse', version: '0.2.0' }, { instructions: INSTRUCTIONS });
  const session = new PhoneSession({ keyId: ctx.keyId, hub: ctx.hub, traces: ctx.traces, guards: ctx.guards, limits: ctx.limits });

  /** Meter every call against the API key; expected errors become tool errors, not protocol errors. */
  const metered = <A>(tool: string, handler: (args: A) => Promise<CallToolResult>) =>
    async (args: A): Promise<CallToolResult> => {
      const started = Date.now();
      let result: CallToolResult;
      try {
        result = await handler(args);
      } catch (error) {
        const expected = EXPECTED_ERRORS.some((type) => error instanceof type);
        result = failure(expected ? (error as Error).message : 'Gateway error; please try again.');
        if (!expected) console.error(`[mcp] ${tool} failed`, error);
      }
      const { textTokens, ...images } = outputStats(result);
      const event = ctx.usage.record({
        keyId: ctx.keyId,
        tool,
        rigId: ctx.hub.leaseFor(ctx.keyId),
        ok: !result.isError,
        durationMs: Date.now() - started,
        tokensIn: estimateTextTokens(JSON.stringify(args ?? {})),
        tokensOut: textTokens + images.imageTokens,
        ...images,
      });
      // Tell the caller what this call cost so agents can budget.
      return event.tokens > 0 ? { ...result, content: [...result.content, { type: 'text', text: `Tokens billed: ${event.tokens}.` }] } : result;
    };

  const act = async (action: PhoneAction, label: string, why = ''): Promise<CallToolResult> => {
    const outcome = await session.act(action, why);
    if (!outcome.ok) return failure(`${label} failed: ${outcome.error}. Take a screenshot before trying again.`);
    return withFrame(`${label} done on ${outcome.rigId}.`, outcome.frame);
  };

  server.registerTool(
    'rigs_list',
    { description: 'List Phone Use rigs and whether each is online and available to you.' },
    metered('rigs_list', async () => text(JSON.stringify(ctx.hub.list(ctx.keyId), null, 2))),
  );

  server.registerTool(
    'phone_connect',
    {
      description: 'Reserve a phone rig and start a task (any available rig unless rig_id is given). Resets the action budget.',
      inputSchema: {
        rig_id: z.string().max(64).optional(),
        task: z.string().max(2000).optional().describe('The goal for this session in plain language, e.g. "Turn on Dark Mode in Settings".'),
        task_family: z.string().max(200).optional().describe('Short category for the task, e.g. "settings".'),
      },
    },
    metered('phone_connect', async ({ rig_id, task, task_family }: { rig_id?: string; task?: string; task_family?: string }) => {
      const { rigId, episode, frame } = session.connect(rig_id, task, task_family);
      const recording = episode ? ` Recording episode ${episode.episodeId}; finish with phone_task_done.` : '';
      const budget = ctx.guards.status(ctx.keyId).budget;
      return withFrame(`Connected to ${rigId}. Action budget: ${budget}. The lease ends after ${ctx.limits.leaseIdleMs / 60000} idle minutes.${recording}`, frame);
    }),
  );

  server.registerTool(
    'phone_screenshot',
    { description: 'Get the current phone screen as an image. Required before acting.' },
    metered('phone_screenshot', async () => {
      const { rigId, frame } = await session.screenshot();
      return frame ? withFrame(`Screen of ${rigId}.`, frame) : failure('The rig has not sent a fresh screen frame. It may be disconnected.');
    }),
  );

  server.registerTool(
    'phone_tap',
    {
      description: 'Tap the phone screen at normalized coordinates (0-1) of the latest screenshot. Returns a screenshot after the tap.',
      inputSchema: { x: coordinate, y: coordinate, reason },
    },
    metered('phone_tap', async ({ x, y, reason: why }: { x: number; y: number; reason?: string }) => act({ type: 'tap', x, y }, `Tap at (${x.toFixed(3)}, ${y.toFixed(3)})`, why)),
  );

  server.registerTool(
    'phone_scroll',
    {
      description: 'Scroll from an anchor point. dy is a signed pixel delta: negative scrolls content up (reveals content further down).',
      inputSchema: { x: coordinate, y: coordinate, dy: z.number().min(-1000).max(1000), reason },
    },
    metered('phone_scroll', async ({ x, y, dy, reason: why }: { x: number; y: number; dy: number; reason?: string }) => act({ type: 'scroll', x, y, dy }, `Scroll ${dy}`, why)),
  );

  server.registerTool(
    'phone_type',
    {
      description: 'Type text into the focused field. Tap the field first.',
      inputSchema: { text: z.string().min(1).max(500), reason },
    },
    metered('phone_type', async ({ text: value, reason: why }: { text: string; reason?: string }) => act({ type: 'type', text: value }, `Typed ${value.length} characters`, why)),
  );

  server.registerTool(
    'phone_home',
    { description: 'Go to the phone home screen.', inputSchema: { reason } },
    metered('phone_home', async ({ reason: why }: { reason?: string }) => act({ type: 'home' }, 'Home', why)),
  );

  server.registerTool(
    'ask_user',
    {
      description:
        'Ask the person for something only they have (a 2FA code, a yes/no confirmation) and wait for their answer. ' +
        'If no answer arrives in time, call again with the returned ask_id to keep waiting.',
      inputSchema: {
        question: z.string().min(1).max(500).optional().describe('What to ask, e.g. "Enter the 6-digit Talua code from your authenticator app."'),
        kind: z.enum(['code', 'text', 'confirm']).optional().describe('code = short code, confirm = yes/no.'),
        ask_id: z.string().uuid().optional().describe('Keep waiting on an earlier question instead of asking a new one.'),
      },
    },
    metered('ask_user', async ({ question, kind, ask_id }: { question?: string; kind?: 'code' | 'text' | 'confirm'; ask_id?: string }) => {
      let id = ask_id;
      let where = '';
      if (!id) {
        if (!question) return failure('Provide a question, or an ask_id to keep waiting.');
        id = ctx.asks.create(ctx.keyId, question, kind ?? 'text').id;
        const rigId = ctx.hub.leaseFor(ctx.keyId);
        if (rigId) where = ` The person can answer at ${ctx.publicUrl}/live/${ctx.live.create(ctx.keyId, rigId).token}`;
      }
      const answer = await ctx.asks.wait(ctx.keyId, id, ctx.limits.askWaitMs);
      if (answer === null) return text(`Still waiting for the person (ask_id ${id}).${where} Call ask_user with this ask_id to keep waiting.`);
      return text(`The person answered: ${answer}`);
    }),
  );

  server.registerTool(
    'phone_do',
    {
      description:
        'Hand a short sub-task to our phone VLA model (e.g. "open Settings and search for Wi-Fi"). It looks, acts and repeats on the phone until done or max_steps. ' +
        'Uses the same action budget and recording as the other tools.',
      inputSchema: {
        instruction: z.string().min(1).max(1000),
        max_steps: z.number().int().min(1).max(20).optional(),
      },
    },
    metered('phone_do', async ({ instruction, max_steps }: { instruction: string; max_steps?: number }) => {
      if (!ctx.vla) return failure('No VLA model is configured on this gateway (set VLA_PROVIDER). Use the individual phone tools instead.');
      const steps: string[] = [];
      const history: { action: PhoneAction }[] = [];
      let last: Frame | null = null;
      for (let step = 1; step <= (max_steps ?? 10); step++) {
        const { frame } = await session.screenshot();
        if (!frame) return failure(`Stopped at step ${step}: no fresh screen from the rig.`);
        last = frame;
        const decision = await ctx.vla.next({ instruction, image: frame.data, step, history });
        if (decision.kind === 'done') {
          return withFrame(`VLA (${ctx.vla.name}) reports ${decision.outcome} after ${steps.length} actions.${decision.note ? ` ${decision.note}` : ''}\n${steps.join('\n')}`, last);
        }
        const outcome = await session.act(decision.action, `vla:${ctx.vla.name} ${decision.reason ?? ''}`.trim());
        ctx.usage.record({ keyId: ctx.keyId, tool: 'vla_step', rigId: outcome.rigId, ok: outcome.ok, durationMs: 0, images: 0, imageBytes: 0, imageTokens: 0, tokensIn: 0, tokensOut: 0 });
        steps.push(`${step}. ${JSON.stringify(decision.action)} -> ${outcome.ok ? 'ok' : `failed: ${outcome.error}`}`);
        if (!outcome.ok) return failure(`VLA action failed; stopped.\n${steps.join('\n')}`);
        history.push({ action: decision.action });
        last = outcome.frame;
      }
      return withFrame(`VLA used all ${max_steps ?? 10} steps without finishing.\n${steps.join('\n')}`, last);
    }),
  );

  server.registerTool(
    'phone_live_feed',
    { description: 'Get a browser link (valid 30 minutes) that shows the phone screen live and lets the person answer questions or stop the task.' },
    metered('phone_live_feed', async () => {
      const rigId = session.rig();
      const { token } = ctx.live.create(ctx.keyId, rigId);
      return text(`Live feed for ${rigId}: ${ctx.publicUrl}/live/${token}\nThe link expires in ${ctx.limits.liveTokenMs / 60000} minutes.`);
    }),
  );

  server.registerTool(
    'phone_disconnect',
    { description: 'Release your rig so others can use it.' },
    metered('phone_disconnect', async () => {
      const rigId = session.disconnect();
      return text(rigId ? `Released ${rigId}.` : 'You had no rig reserved.');
    }),
  );

  server.registerTool(
    'phone_task_done',
    {
      description: 'Report how the current task ended. Call this when the goal is reached or you give up.',
      inputSchema: {
        outcome: z.enum(['success', 'failed', 'abandoned']),
        note: z.string().max(2000).optional().describe('What happened, especially for failures.'),
      },
    },
    metered('phone_task_done', async ({ outcome, note }: { outcome: 'success' | 'failed' | 'abandoned'; note?: string }) => {
      const episode = session.finish(outcome, note ?? '', 'agent');
      if (!episode) return text(`Noted: ${outcome}. No recorded session was open.`);
      return text(`Recorded ${outcome} for episode ${episode.episodeId} (${episode.steps} steps). Call phone_connect with a new task to start another.`);
    }),
  );

  server.registerTool(
    'usage_get',
    { description: 'Show usage for this API key: tokens in and out, tokens billed, tool calls and rig time.' },
    metered('usage_get', async () => text(JSON.stringify({ ...ctx.usage.summary(ctx.keyId), guard: ctx.guards.status(ctx.keyId) }, null, 2))),
  );

  return server;
}
