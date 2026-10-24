export const DASHBOARD_CSP = "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src 'self' data:; connect-src 'self'";

/** Token-usage dashboard. Static HTML; the API key stays in the viewer's sessionStorage. */
export function dashboardPage(): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Phone Use usage</title>
<style>
:root{color-scheme:light dark;--bg:#f5f5f3;--fg:#1a1a1a;--muted:#6b6b6b;--card:#fff;--line:#e4e4e0;--accent:#2f6fde;--bad:#c4382f;--good:#2c8a4b}
@media (prefers-color-scheme:dark){:root{--bg:#111;--fg:#ececec;--muted:#999;--card:#1c1c1c;--line:#2c2c2c;--accent:#6c9bff;--bad:#ff6b5e;--good:#5ccf84}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.45 system-ui,-apple-system,sans-serif}
main{max-width:960px;margin:0 auto;padding:24px 16px 48px}
h1{font-size:22px;margin:0 0 4px}h2{font-size:15px;margin:0 0 12px}
.sub{color:var(--muted);margin:0 0 20px;font-size:14px}
form{display:flex;gap:8px;margin-bottom:12px}
input{flex:1;min-width:0;padding:9px 11px;border:1px solid var(--line);border-radius:8px;background:var(--card);color:var(--fg);font:inherit}
button{padding:9px 14px;border:0;border-radius:8px;background:var(--accent);color:#fff;font:inherit;cursor:pointer}
#msg{min-height:20px;font-size:14px;color:var(--muted);margin-bottom:12px}#msg.err{color:var(--bad)}
.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:12px;margin-bottom:16px}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:16px}
.tile .label{color:var(--muted);font-size:13px}.tile .value{font-size:28px;font-weight:600;font-variant-numeric:tabular-nums;margin-top:4px}
.tile .note{color:var(--muted);font-size:12px;min-height:16px}
.grid{display:grid;grid-template-columns:1fr;gap:12px}
@media (min-width:760px){.grid{grid-template-columns:1fr 1fr}.wide{grid-column:1/-1}}
svg{display:block;width:100%;height:140px}
.bar{fill:var(--accent)}.axis{fill:var(--muted);font-size:10px}
table{width:100%;border-collapse:collapse;font-size:14px;font-variant-numeric:tabular-nums}
th,td{text-align:left;padding:6px 4px;border-bottom:1px solid var(--line)}th{color:var(--muted);font-weight:500}
td.n,th.n{text-align:right}
.ok{color:var(--good)}.fail{color:var(--bad)}
.empty{color:var(--muted);font-size:14px}
</style></head><body><main>
<h1>Phone Use usage</h1>
<p class="sub">Tokens used on our cloud phones by this API key. Refreshes every 3 seconds.</p>
<form id="keyform"><input id="key" type="password" autocomplete="off" placeholder="Paste API key (pu_…)" aria-label="API key"><button type="submit">Show usage</button></form>
<div id="msg">Enter your API key to load usage.</div>
<section class="tiles">
  <div class="card tile"><div class="label">Tokens billed</div><div class="value" id="t-tokens">–</div><div class="note"></div></div>
  <div class="card tile"><div class="label">Image tokens</div><div class="value" id="t-image">–</div><div class="note">estimated, sent to the model</div></div>
  <div class="card tile"><div class="label">Tool calls</div><div class="value" id="t-calls">–</div><div class="note" id="t-failed"></div></div>
  <div class="card tile"><div class="label">Rig time</div><div class="value" id="t-rig">–</div><div class="note"></div></div>
</section>
<section class="grid">
  <div class="card wide"><h2>Tokens per minute, last 60 minutes</h2><svg id="chart" viewBox="0 0 600 140" preserveAspectRatio="none" role="img" aria-label="Tokens per minute"></svg></div>
  <div class="card"><h2>By tool</h2><table><thead><tr><th>Tool</th><th class="n">Calls</th><th class="n">Tokens</th><th class="n">Price</th></tr></thead><tbody id="tools"></tbody></table></div>
  <div class="card"><h2>Recent calls</h2><table><thead><tr><th>Time</th><th>Tool</th><th>Result</th><th class="n">Tokens</th></tr></thead><tbody id="recent"></tbody></table></div>
</section>
<script>
(() => {
  const KEY = 'phoneuse.apiKey';
  const $ = (id) => document.getElementById(id);
  const msg = $('msg');
  let key = '';
  let timer = null;
  try { key = sessionStorage.getItem(KEY) || ''; } catch (e) {}
  $('key').value = key;

  const fmt = (n) => Number(n || 0).toLocaleString();
  const rig = (ms) => { const s = Math.round((ms || 0) / 1000); return s < 60 ? s + ' s' : Math.floor(s / 60) + ' min ' + (s % 60) + ' s'; };
  const status = (text, isError) => { msg.textContent = text; msg.className = isError ? 'err' : ''; };
  const cell = (row, text, cls) => { const td = document.createElement('td'); td.textContent = text; if (cls) td.className = cls; row.appendChild(td); return td; };
  const emptyRow = (body, cols, text) => { const tr = document.createElement('tr'); const td = cell(tr, text, 'empty'); td.colSpan = cols; body.appendChild(tr); };

  function chart(points) {
    const svg = $('chart'), NS = 'http://www.w3.org/2000/svg';
    svg.replaceChildren();
    const list = Array.isArray(points) ? points : [];
    const max = Math.max(1, ...list.map((p) => p.tokens || 0));
    const w = 600 / Math.max(1, list.length), top = 14, h = 140 - top - 16;
    list.forEach((p, i) => {
      const bh = ((p.tokens || 0) / max) * h;
      const r = document.createElementNS(NS, 'rect');
      r.setAttribute('class', 'bar');
      r.setAttribute('x', String(i * w + 1));
      r.setAttribute('y', String(top + h - bh));
      r.setAttribute('width', String(Math.max(1, w - 2)));
      r.setAttribute('height', String(bh));
      const t = document.createElementNS(NS, 'title');
      t.textContent = new Date(p.minute).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) + ': ' + fmt(p.tokens) + ' tokens';
      r.appendChild(t);
      svg.appendChild(r);
    });
    const label = (x, text, anchor) => { const t = document.createElementNS(NS, 'text'); t.setAttribute('class', 'axis'); t.setAttribute('x', String(x)); t.setAttribute('y', '138'); t.setAttribute('text-anchor', anchor); t.textContent = text; svg.appendChild(t); };
    const peak = document.createElementNS(NS, 'text');
    peak.setAttribute('class', 'axis'); peak.setAttribute('x', '2'); peak.setAttribute('y', '10'); peak.textContent = 'peak ' + fmt(max);
    svg.appendChild(peak);
    label(2, '60 min ago', 'start'); label(598, 'now', 'end');
  }

  function render(u) {
    $('t-tokens').textContent = fmt(u.tokens);
    $('t-image').textContent = fmt(u.imageTokens);
    $('t-calls').textContent = fmt(u.calls);
    $('t-failed').textContent = u.failedCalls ? fmt(u.failedCalls) + ' failed' : 'no failures';
    $('t-rig').textContent = rig(u.rigMs);
    chart(u.perMinute);

    const tools = $('tools'); tools.replaceChildren();
    const pricing = u.pricing || {}, byTool = u.byTool || {};
    const names = [...new Set([...Object.keys(pricing), ...Object.keys(byTool)])].sort((a, b) => ((byTool[b] || {}).tokens || 0) - ((byTool[a] || {}).tokens || 0) || a.localeCompare(b));
    if (!names.length) emptyRow(tools, 4, 'No tools yet');
    for (const name of names) {
      const tr = document.createElement('tr'), s = byTool[name] || {};
      cell(tr, name); cell(tr, fmt(s.calls), 'n'); cell(tr, fmt(s.tokens), 'n'); cell(tr, name in pricing ? fmt(pricing[name]) : '–', 'n');
      tools.appendChild(tr);
    }

    const recent = $('recent'); recent.replaceChildren();
    const rows = Array.isArray(u.recent) ? u.recent : [];
    if (!rows.length) emptyRow(recent, 4, 'No calls yet');
    for (const r of rows) {
      const tr = document.createElement('tr');
      cell(tr, new Date(r.at).toLocaleTimeString());
      cell(tr, r.tool);
      cell(tr, r.ok ? 'ok' : 'failed', r.ok ? 'ok' : 'fail');
      cell(tr, fmt(r.tokens), 'n');
      recent.appendChild(tr);
    }
  }

  async function load() {
    if (!key) return;
    try {
      const res = await fetch('/v1/usage', { headers: { Authorization: 'Bearer ' + key }, cache: 'no-store' });
      if (res.status === 401) { stop(); status('That API key was rejected. Check it and try again.', true); return; }
      if (res.status === 429) { status('Rate limited; retrying shortly.', true); return; }
      if (!res.ok) { status('Gateway returned HTTP ' + res.status + '; retrying.', true); return; }
      render(await res.json());
      status('Updated ' + new Date().toLocaleTimeString() + '.', false);
    } catch (e) {
      status('Could not reach the gateway; retrying.', true);
    }
  }
  function stop() { if (timer) clearInterval(timer); timer = null; }
  function start() { stop(); load(); timer = setInterval(load, 3000); }

  $('keyform').addEventListener('submit', (event) => {
    event.preventDefault();
    key = $('key').value.trim();
    if (!/^pu_\\S+$/.test(key)) { status('API keys start with pu_.', true); return; }
    try { sessionStorage.setItem(KEY, key); } catch (e) {}
    status('Loading…', false);
    start();
  });
  if (key) start();
})();
</script>
</main></body></html>`;
}
