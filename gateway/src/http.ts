import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { commandResultSchema } from './actions.js';
import { bearerToken } from './auth.js';
import type { Config } from './config.js';
import { DASHBOARD_CSP, dashboardPage } from './dashboard.js';
import { expiredPage, livePage, LiveViews, streamFrames } from './live.js';
import { createMcpServer } from './mcp.js';
import { PAGE_CSP } from './theme.js';
import { RateLimiter } from './ratelimit.js';
import { createReviewApi, REVIEW_CSP, ReviewError, reviewPage } from './review.js';
import { RigHub } from './rigs.js';
import { TraceRecorder } from './traces.js';
import type { Store } from './store.js';
import { UsageLedger } from './usage.js';

export interface Gateway {
  readonly server: Server;
  readonly hub: RigHub;
}

class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

function send(res: ServerResponse, status: number, body: unknown, type = 'application/json', extra: Record<string, string> = {}): void {
  const data = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...extra });
  res.end(data);
}

function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length'] ?? 0);
    if (declared > limit) return reject(new HttpError(413, 'Request body too large'));
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        reject(new HttpError(413, 'Request body too large'));
        req.destroy();
      } else chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function readJson(req: IncomingMessage, limit: number): Promise<unknown> {
  try {
    return JSON.parse((await readBody(req, limit)).toString('utf8'));
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(400, 'Body must be JSON');
  }
}

export function createGateway(config: Config, store: Store): Gateway {
  const { limits } = config;
  const hub = new RigHub(() => new Map(store.listRigs().map((rig) => [rig.id, rig.name])), limits);
  const usage = new UsageLedger(`${config.dataDir}/usage.jsonl`);
  const live = new LiveViews(limits.liveTokenMs);
  const limiter = new RateLimiter(limits.mcpRequestsPerMinute, 60_000);
  const traces = config.traceDir ? new TraceRecorder(config.traceDir) : null;

  const requireKey = (req: IncomingMessage): string => {
    const secret = bearerToken(req, 'pu');
    const key = secret ? store.findKeyBySecret(secret) : null;
    if (!key) throw new HttpError(401, 'Missing or invalid API key (Authorization: Bearer pu_...)');
    if (!limiter.allow(key.id)) throw new HttpError(429, 'Rate limit exceeded; slow down');
    return key.id;
  };

  const requireRig = (req: IncomingMessage): string => {
    const secret = bearerToken(req, 'rig');
    const rig = secret ? store.findRigBySecret(secret) : null;
    if (!rig) throw new HttpError(401, 'Missing or invalid rig token');
    return rig.id;
  };

  const handleMcp = async (req: IncomingMessage, res: ServerResponse, keyId: string): Promise<void> => {
    if (req.method !== 'POST') return send(res, 405, { error: 'This MCP endpoint is stateless; use POST' });
    const body = await readJson(req, limits.maxJsonBytes);
    // Stateless Streamable HTTP: fresh server per request; rig leases live on the API key.
    const server = createMcpServer({ keyId, hub, usage, live, publicUrl: config.publicUrl, limits, traces });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  };

  const route = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? '/', 'http://gateway');
    const { pathname } = url;

    if (pathname === '/health') return send(res, 200, { ok: true });
    if (pathname === '/mcp') return handleMcp(req, res, requireKey(req));
    if (pathname === '/v1/usage' && req.method === 'GET') return send(res, 200, usage.report(requireKey(req)));
    if (pathname === '/review' && req.method === 'GET') {
      return send(res, 200, reviewPage(), 'text/html; charset=utf-8', {
        'Content-Security-Policy': REVIEW_CSP,
        'X-Frame-Options': 'DENY',
        'Referrer-Policy': 'no-referrer',
      });
    }
    if (pathname.startsWith('/v1/episodes')) {
      try {
        const reviewed = await createReviewApi(config.traceDir, config.reviewToken).handle(req, pathname, () => readJson(req, limits.maxJsonBytes));
        if (reviewed) return send(res, reviewed.status, reviewed.body, reviewed.type);
      } catch (error) {
        if (error instanceof ReviewError) throw new HttpError(error.status, error.message);
        throw error;
      }
    }
    if (pathname === '/dashboard' && req.method === 'GET') {
      return send(res, 200, dashboardPage(), 'text/html; charset=utf-8', {
        'Content-Security-Policy': DASHBOARD_CSP,
        'X-Frame-Options': 'DENY',
        'Referrer-Policy': 'no-referrer',
      });
    }

    if (pathname === '/rig/v1/commands' && req.method === 'GET') {
      const rigId = requireRig(req);
      const wait = Math.min(Math.max(Number(url.searchParams.get('wait') ?? 25), 0), 30) * 1000;
      req.on('close', () => {
        if (!res.writableEnded) hub.cancelPoll(rigId);
      });
      const command = await hub.poll(rigId, wait);
      if (res.destroyed) return;
      if (!command) {
        res.writeHead(204).end();
        return;
      }
      return send(res, 200, command);
    }
    if (pathname === '/rig/v1/results' && req.method === 'POST') {
      const rigId = requireRig(req);
      const parsed = commandResultSchema.safeParse(await readJson(req, limits.maxJsonBytes));
      if (!parsed.success) throw new HttpError(400, 'Invalid result payload');
      return send(res, hub.submitResult(rigId, parsed.data) ? 200 : 404, { accepted: true });
    }
    if (pathname === '/rig/v1/frames' && req.method === 'POST') {
      const rigId = requireRig(req);
      if (req.headers['content-type'] !== 'image/jpeg') throw new HttpError(415, 'Frames must be image/jpeg');
      const data = await readBody(req, limits.maxFrameBytes);
      if (data.length < 4 || data[0] !== 0xff || data[1] !== 0xd8) throw new HttpError(400, 'Not a JPEG');
      const frame = hub.pushFrame(rigId, data);
      return send(res, 200, { seq: frame.seq });
    }

    const liveMatch = /^\/live\/([\w-]{20,64})(\/stream|\/frame\.jpg)?$/.exec(pathname);
    if (liveMatch && req.method === 'GET') {
      const view = live.resolve(liveMatch[1]);
      if (!view) {
        if (liveMatch[2]) throw new HttpError(404, 'This live-feed link is invalid or expired');
        return send(res, 404, expiredPage(), 'text/html; charset=utf-8', { 'Content-Security-Policy': PAGE_CSP });
      }
      if (liveMatch[2] === '/stream') return streamFrames(res, hub, view);
      if (liveMatch[2] === '/frame.jpg') {
        const frame = hub.latestFrame(view.rigId);
        return frame ? send(res, 200, frame.data, 'image/jpeg') : send(res, 503, { error: 'No frame yet' });
      }
      const name = store.listRigs().find((rig) => rig.id === view.rigId)?.name ?? view.rigId;
      return send(res, 200, livePage(liveMatch[1], name, view.expiresAt), 'text/html; charset=utf-8', {
        'Content-Security-Policy': PAGE_CSP,
        'X-Frame-Options': 'DENY',
        'Referrer-Policy': 'no-referrer',
      });
    }

    throw new HttpError(404, 'Not found');
  };

  const server = createServer((req, res) => {
    route(req, res).catch((error: unknown) => {
      if (res.headersSent) {
        res.destroy();
        return;
      }
      if (error instanceof HttpError) return send(res, error.status, { error: error.message });
      console.error('[http] unhandled error', error);
      send(res, 500, { error: 'Internal error' });
    });
  });
  // Rig long polls hold requests open; keep sockets alive past the default timeouts.
  server.requestTimeout = 60_000;
  server.headersTimeout = 15_000;
  return { server, hub };
}
