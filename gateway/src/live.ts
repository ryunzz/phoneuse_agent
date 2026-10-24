import { randomBytes } from 'node:crypto';
import type { ServerResponse } from 'node:http';
import type { RigHub } from './rigs.js';

export interface LiveView {
  readonly keyId: string;
  readonly rigId: string;
  readonly expiresAt: number;
}

const BOUNDARY = 'phoneuse-frame';

/** Short-lived, unguessable view links so a browser can watch a rig without the API key. */
export class LiveViews {
  private views = new Map<string, LiveView>();

  constructor(private readonly ttlMs: number, private readonly now: () => number = Date.now) {}

  create(keyId: string, rigId: string): { token: string; view: LiveView } {
    this.prune();
    const token = randomBytes(24).toString('base64url');
    const view: LiveView = { keyId, rigId, expiresAt: this.now() + this.ttlMs };
    this.views = new Map(this.views).set(token, view);
    return { token, view };
  }

  resolve(token: string): LiveView | null {
    const view = this.views.get(token);
    return view && view.expiresAt > this.now() ? view : null;
  }

  private prune(): void {
    const now = this.now();
    this.views = new Map([...this.views].filter(([, view]) => view.expiresAt > now));
  }
}

export function livePage(token: string, rigName: string): string {
  const safeName = rigName.replace(/[^\w .-]/g, '');
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Phone Use live feed</title>
<style>
:root{color-scheme:light dark;--bg:#f4f4f2;--fg:#1b1b1b;--muted:#6b6b6b;--card:#fff}
@media (prefers-color-scheme:dark){:root{--bg:#121212;--fg:#ececec;--muted:#9a9a9a;--card:#1d1d1d}}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.4 system-ui,sans-serif;display:flex;flex-direction:column;align-items:center;min-height:100vh}
header{width:100%;max-width:520px;padding:16px;box-sizing:border-box;display:flex;justify-content:space-between;align-items:baseline}
h1{font-size:17px;margin:0}#status{color:var(--muted);font-size:13px}
.phone{background:var(--card);border-radius:28px;padding:10px;box-shadow:0 4px 24px #0002;margin:0 16px 24px}
img{display:block;max-height:80vh;max-width:calc(100vw - 52px);border-radius:20px}
</style></head><body>
<header><h1>${safeName}</h1><span id="status">connecting…</span></header>
<div class="phone"><img id="feed" alt="Live phone screen" src="/live/${token}/stream"></div>
<script>
const s=document.getElementById('status'),img=document.getElementById('feed');
img.onload=()=>{s.textContent='live'};
img.onerror=()=>{s.textContent='feed ended or link expired';};
</script></body></html>`;
}

/** Stream frames as MJPEG until the client disconnects or the view expires. */
export function streamFrames(res: ServerResponse, hub: RigHub, view: LiveView): void {
  res.writeHead(200, {
    'Content-Type': `multipart/x-mixed-replace; boundary=${BOUNDARY}`,
    'Cache-Control': 'no-store',
    Connection: 'close',
  });
  const write = (data: Buffer): void => {
    if (Date.now() > view.expiresAt) {
      cleanup();
      res.end();
      return;
    }
    res.write(`--${BOUNDARY}\r\nContent-Type: image/jpeg\r\nContent-Length: ${data.length}\r\n\r\n`);
    res.write(data);
    res.write('\r\n');
  };
  const latest = hub.latestFrame(view.rigId);
  if (latest) write(latest.data);
  const unsubscribe = hub.subscribe(view.rigId, (frame) => write(frame.data));
  const cleanup = (): void => {
    unsubscribe();
  };
  res.on('close', cleanup);
}
