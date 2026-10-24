import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { PhoneAction } from './actions.js';
import type { Limits } from './config.js';
import type { LiveViews } from './live.js';
import type { TraceRecorder } from './traces.js';
import { RigError, type Frame, type RigHub } from './rigs.js';
import { estimateImageTokens, jpegSize, type UsageLedger } from './usage.js';

export interface McpContext {
  readonly keyId: string;
  readonly hub: RigHub;
  readonly usage: UsageLedger;
  readonly live: LiveViews;
  readonly publicUrl: string;
  readonly limits: Limits;
  readonly traces: TraceRecorder | null;
}

const INSTRUCTIONS = `Phone Use drives a real phone on a hardware rig.
Typical loop: phone_screenshot -> decide -> phone_tap / phone_scroll / phone_type / phone_home -> look at the returned screenshot -> repeat.
Coordinates are normalized 0-1 across the screenshot (x from left, y from top).
Actions affect a real device: never retry an action whose outcome is unknown without taking a screenshot first.
Give the user phone_live_feed's link if they want to watch.
Start each task with phone_connect(task=...) and end it with phone_task_done. Pass a short reason with each action.
Sessions are recorded (screens, actions, typed text, reasons) to train our phone model; do not type secrets you would not want stored.`;

const coordinate = z.number().min(0).max(1);
const reason = z.string().max(500).optional().describe('Briefly, what you are doing and why (recorded for training).');

function text(message: string): CallToolResult {
  return { content: [{ type: 'text', text: message }] };
}

function failure(message: string): CallToolResult {
  return { ...text(message), isError: true };
}

function withFrame(message: string, frame: Frame | null, now: number): CallToolResult {
  if (!frame) return text(`${message}\n(No fresh screenshot is available from the rig.)`);
  return {
    content: [
      { type: 'text', text: `${message}\nScreenshot age: ${now - frame.receivedAt} ms.` },
      { type: 'image', data: frame.data.toString('base64'), mimeType: 'image/jpeg' },
    ],
  };
}

function imageStats(result: CallToolResult): { images: number; imageBytes: number; imageTokens: number } {
  const buffers = result.content.flatMap((item) => (item.type === 'image' ? [Buffer.from(item.data, 'base64')] : []));
  return buffers.reduce(
    (stats, data) => {
      const size = jpegSize(data);
      return {
        images: stats.images + 1,
        imageBytes: stats.imageBytes + data.length,
        imageTokens: stats.imageTokens + (size ? estimateImageTokens(size.width, size.height) : 0),
      };
    },
    { images: 0, imageBytes: 0, imageTokens: 0 },
  );
}

export function createMcpServer(ctx: McpContext): McpServer {
  const server = new McpServer({ name: 'phoneuse', version: '0.1.0' }, { instructions: INSTRUCTIONS });

  /** Meter every call against the API key; rig errors become tool errors, not protocol errors. */
  const metered = <A>(tool: string, handler: (args: A) => Promise<CallToolResult>) =>
    async (args: A): Promise<CallToolResult> => {
      const started = Date.now();
      let result: CallToolResult;
      try {
        result = await handler(args);
      } catch (error) {
        result = failure(error instanceof RigError ? error.message : 'Gateway error; please try again.');
        if (!(error instanceof RigError)) console.error(`[mcp] ${tool} failed`, error);
      }
      const event = ctx.usage.record({
        keyId: ctx.keyId,
        tool,
        rigId: ctx.hub.leaseFor(ctx.keyId),
        ok: !result.isError,
        durationMs: Date.now() - started,
        ...imageStats(result),
      });
      // Tell the caller what this call cost so agents can budget.
      return event.tokens > 0 ? { ...result, content: [...result.content, { type: 'text', text: `Tokens billed: ${event.tokens}.` }] } : result;
    };

  const leasedRig = (): string => {
    const rigId = ctx.hub.leaseFor(ctx.keyId) ?? ctx.hub.acquire(ctx.keyId);
    return ctx.hub.touch(ctx.keyId, rigId);
  };

  const observed = (message: string, frame: Frame | null): CallToolResult => {
    if (frame) ctx.traces?.observe(ctx.keyId, frame);
    return withFrame(message, frame, Date.now());
  };

  /** Trace writes never block the user's action; a failed write only loses training data. */
  const traced = <T>(what: string, write: () => T): T | null => {
    try {
      return write();
    } catch (error) {
      console.error(`[traces] ${what} failed`, error);
      return null;
    }
  };

  const act = async (action: PhoneAction, label: string, why = ''): Promise<CallToolResult> => {
    const rigId = leasedRig();
    const step = ctx.traces && traced('begin step', () => ctx.traces!.beginStep(ctx.keyId, rigId, action, why, ctx.hub.latestFrame(rigId)));
    const result = await ctx.hub.send(rigId, action);
    const endedAt = Date.now();
    let frame: Frame | null = null;
    if (result.ok) {
      const settledAt = endedAt + ctx.limits.settleMs;
      await new Promise((resolve) => setTimeout(resolve, ctx.limits.settleMs));
      frame = await ctx.hub.nextFrame(rigId, settledAt, 3000);
    }
    if (step) traced('complete step', () => ctx.traces!.completeStep(step, result, frame, endedAt));
    if (!result.ok) return failure(`${label} failed: ${result.error ?? 'unknown error'}`);
    return observed(`${label} done on ${rigId}.`, frame);
  };

  server.registerTool(
    'rigs_list',
    { description: 'List Phone Use rigs and whether each is online and available to you.' },
    metered('rigs_list', async () => text(JSON.stringify(ctx.hub.list(ctx.keyId), null, 2))),
  );

  server.registerTool(
    'phone_connect',
    {
      description: 'Reserve a phone rig for this API key (any available one unless rig_id is given). Other phone tools connect automatically.',
      inputSchema: {
        rig_id: z.string().max(64).optional(),
        task: z.string().max(2000).optional().describe('The goal for this session in plain language, e.g. "Turn on Dark Mode in Settings".'),
        task_family: z.string().max(200).optional().describe('Short category for the task, e.g. "settings".'),
      },
    },
    metered('phone_connect', async ({ rig_id, task, task_family }: { rig_id?: string; task?: string; task_family?: string }) => {
      const rigId = ctx.hub.acquire(ctx.keyId, rig_id);
      const episode = ctx.traces && traced('start episode', () => ctx.traces!.start(ctx.keyId, rigId, { instruction: task, group: task_family }));
      const recording = episode ? ` Recording episode ${episode.episodeId}; finish with phone_task_done.` : '';
      return observed(`Connected to ${rigId}. The lease renews on each call and ends after ${ctx.limits.leaseIdleMs / 60000} idle minutes.${recording}`, ctx.hub.latestFrame(rigId));
    }),
  );

  server.registerTool(
    'phone_screenshot',
    { description: 'Get the current phone screen as an image.' },
    metered('phone_screenshot', async () => {
      const rigId = leasedRig();
      const frame = await ctx.hub.nextFrame(rigId, Date.now() - 1500, 3000);
      return frame ? observed(`Screen of ${rigId}.`, frame) : failure('The rig has not sent a fresh screen frame. It may be disconnected.');
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
    'phone_live_feed',
    { description: 'Get a browser link (valid 30 minutes) that shows the phone screen live. Share it with the user.' },
    metered('phone_live_feed', async () => {
      const rigId = leasedRig();
      const { token } = ctx.live.create(ctx.keyId, rigId);
      return text(`Live feed for ${rigId}: ${ctx.publicUrl}/live/${token}\nThe link expires in ${ctx.limits.liveTokenMs / 60000} minutes.`);
    }),
  );

  server.registerTool(
    'phone_disconnect',
    { description: 'Release your rig so others can use it.' },
    metered('phone_disconnect', async () => {
      if (ctx.traces) traced('finish episode', () => ctx.traces!.finish(ctx.keyId, 'abandoned', 'disconnected without phone_task_done', 'gateway'));
      const rigId = ctx.hub.release(ctx.keyId);
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
      const episode = ctx.traces && traced('finish episode', () => ctx.traces!.finish(ctx.keyId, outcome, note ?? '', 'agent'));
      if (!episode) return text(`Noted: ${outcome}. No recorded session was open.`);
      return text(`Recorded ${outcome} for episode ${episode.episodeId} (${episode.steps} steps). Call phone_connect with a new task to start another.`);
    }),
  );

  server.registerTool(
    'usage_get',
    { description: 'Show usage for this API key: tool calls, images returned and rig time.' },
    metered('usage_get', async () => text(JSON.stringify(ctx.usage.summary(ctx.keyId), null, 2))),
  );

  return server;
}
