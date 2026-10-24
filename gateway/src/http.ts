import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, rmSync, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { commandResultSchema } from './actions.js';
import { bearerToken } from './auth.js';
import type { Config } from './config.js';
import { DASHBOARD_CSP, dashboardPage } from './dashboard.js';
import { expiredPage, livePage, LiveViews, streamFrames } from './live.js';
import { landingPage } from './landing.js';
import { AskError, Asks } from './asks.js';
import { Guards } from './guards.js';
import { createMcpServer } from './mcp.js';
import { createVlaProvider, type VlaProvider } from './vla.js';
import { PAGE_CSP } from './theme.js';
import { RateLimiter } from './ratelimit.js';
import { createReviewApi, REVIEW_CSP, ReviewError, reviewPage } from './review.js';
import { RigHub } from './rigs.js';
import { TraceRecorder } from './traces.js';
import type { Store } from './store.js';
import { SUBMISSION_REVIEW_CSP, submissionReviewPage } from './submission-review.js';
import { createSubmissionSchema, loadTasks, reviewSchema, SubmissionError, SubmissionStore, VIDEO_TYPES } from './submissions.js';
import { UsageLedger } from './usage.js';

export interface Gateway {
  readonly server: Server;
  readonly hub: RigHub;
  readonly submissions: SubmissionStore;
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

/** Streams a request body to disk, hashing as it goes, so large videos never sit in memory. */
function streamToFile(req: IncomingMessage, file: string, limit: number): Promise<{ bytes: number; sha256: string }> {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length'] ?? 0);
    if (declared > limit) return reject(new HttpError(413, 'Recording is too large'));
    const hash = createHash('sha256');
    const out = createWriteStream(file, { mode: 0o600 });
    let bytes = 0;
    let failed = false;
    const fail = (error: unknown) => {
      if (failed) return;
      failed = true;
      out.destroy();
      rmSync(file, { force: true });
      reject(error);
    };
    req.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > limit) {
        fail(new HttpError(413, 'Recording is too large'));
        req.destroy();
        return;
      }
      hash.update(chunk);
      if (!out.write(chunk)) {
        req.pause();
        out.once('drain', () => req.resume());
      }
    });
    req.on('aborted', () => fail(new HttpError(400, 'Upload interrupted')));
    req.on('error', fail);
    out.on('error', fail);
    req.on('end', () => {
      if (failed) return;
      if (declared && bytes !== declared) return fail(new HttpError(400, 'Upload interrupted'));
      out.end(() => resolve({ bytes, sha256: hash.digest('hex') }));
    });
  });
}

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
const LOCAL_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * Review routes answer only on the Mac itself, even when the gateway listens on the LAN for
 * the iPhone app. The Host check stops DNS rebinding; the Origin and JSON checks stop other
 * sites in the reviewer's browser from posting decisions.
 */
function requireLocalAdmin(req: IncomingMessage, write: boolean): void {
  const host = req.headers.host ?? '';
  if (!LOOPBACK.has(req.socket.remoteAddress ?? '') || !LOCAL_HOSTNAMES.has(host.replace(/:\d+$/, ''))) {
    throw new HttpError(403, 'Review is only available on the Mac running the gateway (http://127.0.0.1)');
  }
  if (!write) return;
  const origin = req.headers.origin;
  if (origin && origin !== 'null') {
    let originHost = '';
    try {
      originHost = new URL(origin).host;
    } catch {}
    if (originHost !== host) throw new HttpError(403, 'Cross-site request refused');
  } else if (origin === 'null') throw new HttpError(403, 'Cross-site request refused');
  if (String(req.headers['content-type'] ?? '').split(';')[0].trim() !== 'application/json') {
    throw new HttpError(415, 'Use application/json');
  }
}

/** Serves a stored video with single-range support so browsers can seek. */
function sendVideo(req: IncomingMessage, res: ServerResponse, file: string, contentType: string): void {
  const size = statSync(file).size;
  const headers = { 'Content-Type': contentType, 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };
  const range = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range ?? ''));
  if (range && (range[1] || range[2])) {
    let start = range[1] ? Number(range[1]) : Math.max(size - Number(range[2]), 0);
    let end = range[1] && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
    if (start >= size || start > end) {
      res.writeHead(416, { 'Content-Range': `bytes */${size}` }).end();
      return;
    }
    start = Math.max(start, 0);
    end = Math.max(end, start);
    res.writeHead(206, { ...headers, 'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': String(end - start + 1) });
    createReadStream(file, { start, end }).pipe(res);
    return;
  }
  res.writeHead(200, { ...headers, 'Content-Length': String(size) });
  createReadStream(file).pipe(res);
}

export function createGateway(config: Config, store: Store, vla: VlaProvider | null = createVlaProvider()): Gateway {
  const { limits } = config;
  const hub = new RigHub(() => new Map(store.listRigs().map((rig) => [rig.id, rig.name])), limits);
  const usage = new UsageLedger(`${config.dataDir}/usage.jsonl`);
  const live = new LiveViews(limits.liveTokenMs);
  const limiter = new RateLimiter(limits.mcpRequestsPerMinute, 60_000);
  const submissions = new SubmissionStore(`${config.dataDir}/submissions`, loadTasks(config.tasksFile));
  const contributorLimiter = new RateLimiter(limits.mcpRequestsPerMinute, 60_000);
  const enrollLimiter = new RateLimiter(10, 60_000);
  const traces = config.traceDir ? new TraceRecorder(config.traceDir) : null;
  const guards = new Guards(limits);
  const asks = new Asks(limits.askTtlMs);

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

  const requireContributor = (req: IncomingMessage): string => {
    const secret = bearerToken(req, 'ct');
    const person = secret ? store.findContributorBySecret(secret) : null;
    if (!person) throw new HttpError(401, 'Missing or invalid contributor key (pair the app again)');
    if (!contributorLimiter.allow(person.id)) throw new HttpError(429, 'Rate limit exceeded; slow down');
    return person.id;
  };

  const handleMcp = async (req: IncomingMessage, res: ServerResponse, keyId: string): Promise<void> => {
    if (req.method !== 'POST') return send(res, 405, { error: 'This MCP endpoint is stateless; use POST' });
    const body = await readJson(req, limits.maxJsonBytes);
    // Stateless Streamable HTTP: fresh server per request; rig leases live on the API key.
    const server = createMcpServer({ keyId, hub, usage, live, publicUrl: config.publicUrl, limits, traces, guards, asks, vla });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  };

  const answerAsk = async (req: IncomingMessage, res: ServerResponse, keyId: string, id: string): Promise<void> => {
    const body = (await readJson(req, 4096)) as { answer?: unknown };
    if (typeof body?.answer !== 'string') throw new HttpError(400, 'Body must be {"answer": "..."}');
    try {
      asks.answer(keyId, id, body.answer);
    } catch (error) {
      if (error instanceof AskError) throw new HttpError(409, error.message);
      throw error;
    }
    return send(res, 200, { answered: true });
  };

  const stopTask = async (req: IncomingMessage, res: ServerResponse, keyId: string): Promise<void> => {
    const body = (await readJson(req, 4096).catch(() => ({}))) as { reason?: unknown };
    guards.stop(keyId, typeof body?.reason === 'string' ? body.reason : 'stopped from the live view');
    return send(res, 200, { stopped: true });
  };

  const route = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? '/', 'http://gateway');
    const { pathname } = url;

    if (pathname === '/health') return send(res, 200, { ok: true });
    if (pathname === '/' && req.method === 'GET') return send(res, 200, landingPage(config.publicUrl), 'text/html; charset=utf-8', { 'Content-Security-Policy': PAGE_CSP, 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'no-referrer' });
    if (pathname === '/mcp') return handleMcp(req, res, requireKey(req));
    if (pathname === '/v1/asks' && req.method === 'GET') return send(res, 200, { asks: asks.pending(requireKey(req)) });
    const apiAsk = /^\/v1\/asks\/([0-9a-f-]{36})$/.exec(pathname);
    if (apiAsk && req.method === 'POST') return answerAsk(req, res, requireKey(req), apiAsk[1]);
    if (pathname === '/v1/stop' && req.method === 'POST') return stopTask(req, res, requireKey(req));

    // Live-link holders (the person watching) can answer questions and stop the task.
    const liveControl = /^\/live\/([\w-]{20,64})\/(asks|stop|asks\/([0-9a-f-]{36}))$/.exec(pathname);
    if (liveControl) {
      const view = live.resolve(liveControl[1]);
      if (!view) throw new HttpError(404, 'This live-feed link is invalid or expired');
      if (liveControl[2] === 'asks' && req.method === 'GET') return send(res, 200, { asks: asks.pending(view.keyId), guard: guards.status(view.keyId) });
      if (liveControl[3] && req.method === 'POST') return answerAsk(req, res, view.keyId, liveControl[3]);
      if (liveControl[2] === 'stop' && req.method === 'POST') return stopTask(req, res, view.keyId);
      throw new HttpError(405, 'Method not allowed');
    }

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

    if (pathname === '/c/v1/enroll' && req.method === 'POST') {
      if (!config.openEnrollment) throw new HttpError(403, 'Enrollment is closed; pair with a pairing string from "bun run admin create-contributor"');
      if (!enrollLimiter.allow(req.socket.remoteAddress ?? 'unknown')) throw new HttpError(429, 'Too many enrollments; wait a minute');
      const body = (await readJson(req, limits.maxJsonBytes)) as { name?: unknown };
      const name = typeof body?.name === 'string' ? body.name.trim() : '';
      if (!name || name.length > 100) throw new HttpError(400, 'name must be 1-100 characters');
      const { record, secret } = store.createContributor(name);
      return send(res, 201, { contributorId: record.id, key: secret });
    }
    if (pathname === '/c/v1/tasks' && req.method === 'GET') {
      requireContributor(req);
      return send(res, 200, { tasks: submissions.listTasks() });
    }
    if (pathname === '/c/v1/submissions' && req.method === 'GET') {
      return send(res, 200, { submissions: submissions.forContributor(requireContributor(req)) });
    }
    if (pathname === '/c/v1/submissions' && req.method === 'POST') {
      const contributorId = requireContributor(req);
      const parsed = createSubmissionSchema.safeParse(await readJson(req, limits.maxJsonBytes));
      if (!parsed.success) throw new HttpError(400, `Invalid submission: ${parsed.error.issues[0]?.message ?? 'bad payload'}`);
      const { record, created } = submissions.create(contributorId, parsed.data);
      return send(res, created ? 201 : 200, record);
    }
    const subMatch = /^\/c\/v1\/submissions\/(sub_[0-9a-f]{16})\/(media|complete)$/.exec(pathname);
    if (subMatch && subMatch[2] === 'media' && req.method === 'PUT') {
      const contributorId = requireContributor(req);
      const contentType = String(req.headers['content-type'] ?? '').split(';')[0].trim();
      if (!VIDEO_TYPES[contentType]) throw new HttpError(415, 'Recordings must be video/mp4 or video/quicktime');
      const temp = submissions.uploadTarget(subMatch[1], contributorId);
      const { bytes, sha256 } = await streamToFile(req, temp, limits.maxVideoBytes);
      if (bytes === 0) {
        rmSync(temp, { force: true });
        throw new HttpError(400, 'Empty recording');
      }
      const record = submissions.attachMedia(subMatch[1], contributorId, temp, contentType, bytes, sha256);
      return send(res, 200, record);
    }
    if (subMatch && subMatch[2] === 'complete' && req.method === 'POST') {
      const contributorId = requireContributor(req);
      const body = (await readJson(req, limits.maxJsonBytes)) as { sha256?: unknown };
      if (typeof body?.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(body.sha256)) throw new HttpError(400, 'sha256 is required');
      return send(res, 200, submissions.complete(subMatch[1], contributorId, body.sha256));
    }

    if (pathname === '/review/submissions' && req.method === 'GET') {
      requireLocalAdmin(req, false);
      return send(res, 200, submissionReviewPage(), 'text/html; charset=utf-8', {
        'Content-Security-Policy': SUBMISSION_REVIEW_CSP,
        'X-Frame-Options': 'DENY',
        'Referrer-Policy': 'no-referrer',
      });
    }
    if (pathname === '/admin/v1/submissions' && req.method === 'GET') {
      requireLocalAdmin(req, false);
      const contributors = new Map(store.listContributors().map((person) => [person.id, person.name]));
      const queue = submissions.queue();
      return send(res, 200, {
        stats: queue.stats,
        tasks: submissions.listTasks(),
        submissions: queue.submissions.map((record) => ({ ...record, contributorName: contributors.get(record.contributorId) ?? record.contributorId })),
      });
    }
    const adminMatch = /^\/admin\/v1\/submissions\/(sub_[0-9a-f]{16})\/(media|review)$/.exec(pathname);
    if (adminMatch && adminMatch[2] === 'media' && req.method === 'GET') {
      requireLocalAdmin(req, false);
      const record = submissions.get(adminMatch[1]);
      return sendVideo(req, res, submissions.mediaPath(record), record.media!.contentType);
    }
    if (adminMatch && adminMatch[2] === 'review' && req.method === 'POST') {
      requireLocalAdmin(req, true);
      const parsed = reviewSchema.safeParse(await readJson(req, limits.maxJsonBytes));
      if (!parsed.success) throw new HttpError(400, parsed.error.issues[0]?.message ?? 'Invalid review');
      return send(res, 200, submissions.review(adminMatch[1], parsed.data));
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
      if (error instanceof HttpError || error instanceof SubmissionError) return send(res, error.status, { error: error.message });
      console.error('[http] unhandled error', error);
      send(res, 500, { error: 'Internal error' });
    });
  });
  // Rig long polls hold requests open, and recordings upload over Wi-Fi; allow long requests.
  server.requestTimeout = 15 * 60_000;
  server.headersTimeout = 15_000;
  return { server, hub, submissions };
}
