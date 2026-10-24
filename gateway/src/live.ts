import { randomBytes } from 'node:crypto';
import type { ServerResponse } from 'node:http';
import type { RigHub } from './rigs.js';
import { FONT_LINKS, THEME_CSS } from './theme.js';

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

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
}

export function livePage(token: string, rigName: string, expiresAt: number): string {
  const name = escapeHtml(rigName);
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${name} · Phone Use</title>
${FONT_LINKS}
<style>${THEME_CSS}
body { min-height: 100vh; display: flex; flex-direction: column; }
main { flex: 1; display: flex; padding: 8px; min-height: 0; }
.panel { flex: 1; display: flex; flex-direction: column; }
.monitor { flex: 1; display: grid; place-items: center; background: var(--black); padding: 24px 16px; min-height: 0; }
.monitor img { display: block; max-height: calc(100vh - 224px); max-width: 100%; border-radius: 22px; border: 1px solid var(--line); background: var(--panel-000); }
.empty { font: 400 28px/32px var(--font-display); color: var(--ink-muted); text-align: center; }
.empty small { display: block; margin-top: 8px; font: 500 12px/16px var(--font-mono); letter-spacing: .24em; text-transform: uppercase; color: var(--ink-faint); }
.transport { height: 44px; display: flex; align-items: center; justify-content: space-between; padding: 0 12px; border-top: 1px solid var(--line); gap: 12px; }
.transport .state { font: 500 11px/16px var(--font-mono); letter-spacing: .12em; text-transform: uppercase; color: var(--ink-muted); display: flex; align-items: center; gap: 8px; }
.transport .right { font: 400 12px/16px var(--font-mono); color: var(--ink-faint); text-align: right; }
.scrub { height: 2px; background: var(--panel-300); position: relative; }
.scrub i { position: absolute; inset: 0 auto 0 0; width: 0; background: var(--playhead); }
.ask { border-top: 1px solid var(--line); padding: 14px 12px; display: grid; gap: 10px; background: var(--panel-200); }
.ask[hidden] { display: none; }
.ask .k { font: 600 11px/16px var(--font-ui); letter-spacing: .08em; text-transform: uppercase; color: var(--gold); }
.ask p { margin: 0; font: 400 22px/28px var(--font-display); }
.ask form { display: flex; gap: 8px; }
.ask input { flex: 1; min-width: 0; font-size: 18px; letter-spacing: .12em; }
.ask .msg { font: 400 12px/16px var(--font-mono); color: var(--ink-faint); min-height: 16px; }
.stop { border-color: var(--rec); color: var(--rec); padding: 4px 10px; }
.stop:hover { background: color-mix(in srgb, var(--rec) 14%, transparent); }
@media (max-width: 560px) { .menubar .meta .hide-sm { display: none; } .monitor img { max-height: calc(100vh - 210px); } }
</style></head><body>
<header class="menubar"><span class="wordmark">Phone Use <em>live</em></span>
<span class="meta"><span class="hide-sm">${name}</span><span id="clock" class="mono">--:--:--</span></span></header>
<main><section class="panel" aria-label="Live phone screen">
<div class="cap"><span>Program: <b>${name}</b></span><span id="res" class="mono"></span></div>
<div class="monitor"><img id="feed" alt="Live screen of ${name}" src="/live/${token}/stream" hidden>
<p class="empty" id="empty">Waiting for the rig<small>no signal</small></p></div>
<section class="ask" id="ask" hidden aria-live="assertive">
<span class="k">The agent is asking you</span><p id="askq"></p>
<form id="askf" autocomplete="off"><input id="aska" aria-label="Your answer" required maxlength="500"><button type="submit">Send</button></form>
<span class="msg" id="askm"></span></section>
<div class="scrub" aria-hidden="true"><i id="scrub"></i></div>
<div class="transport"><span class="state"><span class="dot" id="dot"></span><span id="state">connecting</span></span>
<span class="timecode" id="tc">00:00:00:00</span>
<span class="right"><button class="stop" id="stop" type="button">Stop agent</button> · link expires <span id="ttl">--:--</span></span></div>
</section></main>
<footer class="footer"><span>mjpeg · read-only view</span><span>© 2026 Phone Use</span></footer>
<script>
const expiresAt = ${Math.floor(expiresAt)}, opened = Date.now(), ttlMs = expiresAt - opened;
const $ = (id) => document.getElementById(id);
const img = $('feed'), pad = (n) => String(n).padStart(2, '0');
let live = false;
img.addEventListener('load', () => {
  live = true; img.hidden = false; $('empty').hidden = true;
  $('dot').classList.add('live'); $('state').textContent = 'live';
  if (img.naturalWidth) $('res').textContent = img.naturalWidth + ' × ' + img.naturalHeight;
});
img.addEventListener('error', () => {
  live = false; img.hidden = true; $('empty').hidden = false;
  $('dot').classList.remove('live');
  $('state').textContent = Date.now() > expiresAt ? 'link expired' : 'signal lost';
  $('empty').firstChild.textContent = Date.now() > expiresAt ? 'This link has expired' : 'Signal lost';
});
function tick() {
  const now = Date.now(), elapsed = now - opened, left = Math.max(0, expiresAt - now);
  const s = Math.floor(elapsed / 1000), f = Math.floor((elapsed % 1000) / 1000 * 24);
  $('tc').textContent = pad(Math.floor(s / 3600)) + ':' + pad(Math.floor(s / 60) % 60) + ':' + pad(s % 60) + ':' + pad(f);
  $('ttl').textContent = pad(Math.floor(left / 60000)) + ':' + pad(Math.floor(left / 1000) % 60);
  $('clock').textContent = new Date(now).toLocaleTimeString([], { hour12: false });
  $('scrub').style.width = Math.min(100, (elapsed / ttlMs) * 100) + '%';
  if (!left && live) { live = false; img.removeAttribute('src'); img.dispatchEvent(new Event('error')); }
  requestAnimationFrame(tick);
}
tick();
const base = '/live/${token}';
let currentAsk = null;
async function pollAsks() {
  try {
    const res = await fetch(base + '/asks', { cache: 'no-store' });
    if (!res.ok) return;
    const data = await res.json();
    const ask = data.asks[0] || null;
    if (data.guard && data.guard.stopped) { $('stop').disabled = true; $('stop').textContent = 'Stopped'; }
    if (!ask) { $('ask').hidden = true; currentAsk = null; return; }
    if (currentAsk && currentAsk.id === ask.id) return;
    currentAsk = ask;
    $('askq').textContent = ask.question;
    const input = $('aska');
    input.value = '';
    input.inputMode = ask.kind === 'code' ? 'numeric' : 'text';
    input.autocomplete = ask.kind === 'code' ? 'one-time-code' : 'off';
    input.placeholder = ask.kind === 'confirm' ? 'yes or no' : ask.kind === 'code' ? '6-digit code' : 'Your answer';
    $('askm').textContent = '';
    $('ask').hidden = false;
    input.focus();
  } catch {}
}
$('askf').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!currentAsk) return;
  $('askm').textContent = 'Sending…';
  const res = await fetch(base + '/asks/' + currentAsk.id, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ answer: $('aska').value }) }).catch(() => null);
  const data = res ? await res.json().catch(() => ({})) : {};
  if (res && res.ok) { $('askm').textContent = 'Sent. The agent will continue.'; setTimeout(pollAsks, 800); }
  else $('askm').textContent = data.error || 'Could not send; try again.';
});
$('stop').addEventListener('click', async () => {
  if (!confirm('Stop the agent? It will not be able to act until a new task starts.')) return;
  const res = await fetch(base + '/stop', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ reason: 'stopped from the live view' }) }).catch(() => null);
  if (res && res.ok) { $('stop').disabled = true; $('stop').textContent = 'Stopped'; }
});
pollAsks();
setInterval(pollAsks, 2000);
</script></body></html>`;
}

export function expiredPage(): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Link expired · Phone Use</title>
${FONT_LINKS}
<style>${THEME_CSS}
body { min-height: 100vh; display: grid; place-items: center; text-align: center; padding: 16px; }
h1 { font: 400 44px/1 var(--font-display); margin: 0 0 12px; }
p { font: 500 12px/16px var(--font-mono); letter-spacing: .24em; text-transform: uppercase; color: var(--ink-faint); margin: 0; }
</style></head><body><main><h1>This link has expired</h1><p>ask your agent for a new phone_live_feed</p></main></body></html>`;
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
