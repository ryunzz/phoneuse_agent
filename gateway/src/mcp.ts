import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { PhoneAction } from './actions.js';
import type { Limits } from './config.js';
import type { LiveViews } from './live.js';
import { RigError, type Frame, type RigHub } from './rigs.js';
import { estimateImageTokens, jpegSize, type UsageLedger } from './usage.js';

export interface McpContext {
  readonly keyId: string;
  readonly hub: RigHub;
  readonly usage: UsageLedger;
  readonly live: LiveViews;
  readonly publicUrl: string;
  readonly limits: Limits;
}

const INSTRUCTIONS = `Phone Use drives a real phone on a hardware rig.
Typical loop: phone_screenshot -> decide -> phone_tap / phone_scroll / phone_type / phone_home -> look at the returned screenshot -> repeat.
Coordinates are normalized 0-1 across the screenshot (x from left, y from top).
Actions affect a real device: never retry an action whose outcome is unknown without taking a screenshot first.
Give the user phone_live_feed's link if they want to watch.`;

const coordinate = z.number().min(0).max(1);

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

  const act = async (action: PhoneAction, label: string): Promise<CallToolResult> => {
    const rigId = leasedRig();
    const result = await ctx.hub.send(rigId, action);
    if (!result.ok) return failure(`${label} failed: ${result.error ?? 'unknown error'}`);
    const settledAt = Date.now() + ctx.limits.settleMs;
    await new Promise((resolve) => setTimeout(resolve, ctx.limits.settleMs));
    const frame = await ctx.hub.nextFrame(rigId, settledAt, 3000);
    return withFrame(`${label} done on ${rigId}.`, frame, Date.now());
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
      inputSchema: { rig_id: z.string().max(64).optional() },
    },
    metered('phone_connect', async ({ rig_id }: { rig_id?: string }) => {
      const rigId = ctx.hub.acquire(ctx.keyId, rig_id);
      return withFrame(`Connected to ${rigId}. The lease renews on each call and ends after ${ctx.limits.leaseIdleMs / 60000} idle minutes.`, ctx.hub.latestFrame(rigId), Date.now());
    }),
  );

  server.registerTool(
    'phone_screenshot',
    { description: 'Get the current phone screen as an image.' },
    metered('phone_screenshot', async () => {
      const rigId = leasedRig();
      const frame = await ctx.hub.nextFrame(rigId, Date.now() - 1500, 3000);
      return frame ? withFrame(`Screen of ${rigId}.`, frame, Date.now()) : failure('The rig has not sent a fresh screen frame. It may be disconnected.');
    }),
  );

  server.registerTool(
    'phone_tap',
    {
      description: 'Tap the phone screen at normalized coordinates (0-1) of the latest screenshot. Returns a screenshot after the tap.',
      inputSchema: { x: coordinate, y: coordinate },
    },
    metered('phone_tap', async ({ x, y }: { x: number; y: number }) => act({ type: 'tap', x, y }, `Tap at (${x.toFixed(3)}, ${y.toFixed(3)})`)),
  );

  server.registerTool(
    'phone_scroll',
    {
      description: 'Scroll from an anchor point. dy is a signed pixel delta: negative scrolls content up (reveals content further down).',
      inputSchema: { x: coordinate, y: coordinate, dy: z.number().min(-1000).max(1000) },
    },
    metered('phone_scroll', async ({ x, y, dy }: { x: number; y: number; dy: number }) => act({ type: 'scroll', x, y, dy }, `Scroll ${dy}`)),
  );

  server.registerTool(
    'phone_type',
    {
      description: 'Type text into the focused field. Tap the field first.',
      inputSchema: { text: z.string().min(1).max(500) },
    },
    metered('phone_type', async ({ text: value }: { text: string }) => act({ type: 'type', text: value }, `Typed ${value.length} characters`)),
  );

  server.registerTool(
    'phone_home',
    { description: 'Go to the phone home screen.' },
    metered('phone_home', async () => act({ type: 'home' }, 'Home')),
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
      const rigId = ctx.hub.release(ctx.keyId);
      return text(rigId ? `Released ${rigId}.` : 'You had no rig reserved.');
    }),
  );

  server.registerTool(
    'usage_get',
    { description: 'Show usage for this API key: tool calls, images returned and rig time.' },
    metered('usage_get', async () => text(JSON.stringify(ctx.usage.summary(ctx.keyId), null, 2))),
  );

  return server;
}
