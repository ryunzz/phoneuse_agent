import { FONT_LINKS, PAGE_CSP, THEME_CSS } from './theme.js';

export const DASHBOARD_CSP = PAGE_CSP;

const PAGE_CSS = `
body { min-height: 100vh; display: flex; flex-direction: column; }
.project { height: 28px; display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 0 16px; border-bottom: 1px solid var(--line); background: var(--panel-000); font: 600 11px/16px var(--font-ui); letter-spacing: .08em; text-transform: uppercase; color: var(--ink-faint); }
.project b { color: var(--ink); font-weight: 600; }
.project .right { display: flex; align-items: center; gap: 12px; min-width: 0; }
#msg { font: 400 12px/16px var(--font-mono); letter-spacing: 0; text-transform: none; color: var(--ink-muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
#msg.err { color: var(--rec); }
.linkbtn { border: 0; padding: 0; font: 400 12px/16px var(--font-mono); color: var(--ink-faint); letter-spacing: 0; text-transform: none; }
.linkbtn:hover { background: none; color: var(--playhead); }
main { flex: 1; display: grid; gap: 6px; padding: 6px; grid-template-columns: minmax(0, 1fr) minmax(0, 1.65fr); grid-template-rows: auto minmax(0, 1fr); }
.panel { display: flex; flex-direction: column; }
.body { padding: 16px; flex: 1; min-height: 0; }

/* Program: hero number */
.label { font: 500 12px/16px var(--font-mono); letter-spacing: .24em; text-transform: uppercase; color: var(--ink-faint); }
.hero { font: 400 76px/0.95 var(--font-display); letter-spacing: -0.01em; margin: 10px 0 18px; font-variant-numeric: lining-nums; }
.readout { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); border-top: 1px solid var(--line); }
.readout .in { color: var(--clip-image); } .readout .out { color: var(--clip-video); }
@media (max-width: 760px) { .readout { grid-template-columns: repeat(2, minmax(0, 1fr)); row-gap: 10px; } .readout div:nth-child(3) { padding-left: 0; border-left: 0; } }
.readout div { padding: 10px 0 0; }
.readout div + div { padding-left: 12px; border-left: 1px solid var(--line); }
.readout .k { font: 600 11px/16px var(--font-ui); letter-spacing: .08em; text-transform: uppercase; color: var(--ink-faint); }
.readout .v { font: 500 14px/20px var(--font-mono); letter-spacing: .02em; margin-top: 2px; }
.readout .sub { font: 400 11px/14px var(--font-mono); color: var(--ink-faint); }
#keyform { display: flex; gap: 6px; margin-top: 14px; }
#keyform input { flex: 1; min-width: 0; }
.hint { color: var(--ink-muted); margin: 6px 0 0; }
[hidden] { display: none !important; }

/* Sequence: timeline */
.seq { display: grid; grid-template-columns: 112px minmax(0, 1fr); flex: 1; min-height: 168px; }
.heads { border-right: 1px solid var(--line); background: var(--panel-000); }
.heads .rulerpad { height: 22px; border-bottom: 1px solid var(--line); padding: 0 10px; display: flex; align-items: center; font: 400 10px/12px var(--font-mono); color: var(--ink-faint); }
.trackhead { display: flex; align-items: center; gap: 8px; padding: 0 10px; height: calc(100% - 22px); }
.trackhead .id { font: 500 11px/14px var(--font-mono); color: var(--ink); background: var(--panel-300); border: 1px solid var(--line); border-radius: var(--radius-sm); padding: 1px 5px; }
.trackhead .nm { color: var(--ink-muted); }
.lane-wrap { position: relative; min-width: 0; }
.ruler { position: relative; height: 22px; border-bottom: 1px solid var(--line); background: var(--panel-000); }
.tick { position: absolute; top: 0; height: 100%; border-left: 1px solid var(--line-strong); padding-left: 4px; font: 400 10px/22px var(--font-mono); color: var(--ink-faint); white-space: nowrap; }
.tick.end { border-left: 0; padding-left: 0; transform: translateX(-100%); padding-right: 10px; }
.lane { position: absolute; left: 0; right: 0; top: 22px; bottom: 0; background: repeating-linear-gradient(90deg, transparent 0, transparent calc(25% - 1px), var(--panel-200) calc(25% - 1px), var(--panel-200) 25%); }
.clip { position: absolute; bottom: 8px; background: var(--clip-video); border-radius: var(--radius-sm); min-height: 2px; }
.clip:hover { background: #8fb5ec; }
.playhead { position: absolute; top: 0; bottom: 0; right: 0; width: 1px; background: var(--playhead); pointer-events: none; }
.playhead::before { content: ""; position: absolute; top: 0; left: -5px; border: 5px solid transparent; border-top: 7px solid var(--playhead); }
.peak { position: absolute; top: 6px; left: 8px; font: 400 10px/12px var(--font-mono); color: var(--ink-faint); }

/* Bin and log */
.table-wrap { overflow-x: auto; }
table { width: 100%; border-collapse: collapse; }
th { font: 600 11px/16px var(--font-ui); letter-spacing: .08em; text-transform: uppercase; color: var(--ink-faint); text-align: left; padding: 8px 12px; border-bottom: 1px solid var(--line); white-space: nowrap; }
td { padding: 6px 12px; border-bottom: 1px solid var(--panel-200); white-space: nowrap; }
tr:last-child td { border-bottom: 0; }
tbody tr:hover td { background: var(--panel-200); }
.n { text-align: right; font-family: var(--font-mono); font-size: 12px; color: var(--ink-muted); }
th.n { font-family: var(--font-ui); font-size: 11px; color: var(--ink-faint); }
.sw { display: inline-block; width: 8px; height: 8px; border-radius: 1px; margin-right: 8px; vertical-align: 0; }
.empty td { color: var(--ink-faint); font-family: var(--font-mono); font-size: 12px; padding: 14px 12px; }
.log { list-style: none; margin: 0; padding: 6px; display: flex; flex-direction: column; gap: 3px; overflow-y: auto; max-height: 340px; }
.log li { display: grid; grid-template-columns: 76px minmax(0, 1fr) 36px 64px; align-items: center; gap: 10px; background: var(--panel-200); border-left: 3px solid var(--line-strong); border-radius: var(--radius-sm); padding: 4px 10px; font: 500 11px/14px var(--font-ui); }
.log .t { font: 400 11px/14px var(--font-mono); color: var(--ink-faint); }
.log .tool { overflow: hidden; text-overflow: ellipsis; }
.log .st { font: 500 10px/14px var(--font-mono); color: var(--clip-audio); }
.log .st.bad { color: var(--rec); }
.log .tok { text-align: right; font: 400 11px/14px var(--font-mono); color: var(--ink-muted); }
.log .none { background: none; border: 0; color: var(--ink-faint); font-family: var(--font-mono); display: block; padding: 8px 6px; }

.program { grid-column: 1; grid-row: 1; }
.sequence { grid-column: 2; grid-row: 1; }
.bin { grid-column: 1; grid-row: 2; }
.logpanel { grid-column: 2; grid-row: 2; }

@media (max-width: 760px) {
  main { grid-template-columns: minmax(0, 1fr); grid-template-rows: none; padding: 6px 12px; }
  .program, .sequence, .bin, .logpanel { grid-column: 1; grid-row: auto; }
  .menubar, .project, .footer { padding: 0 12px; }
  .hero { font-size: 60px; }
  .seq { grid-template-columns: 76px minmax(0, 1fr); }
  .trackhead .nm { display: none; }
  .log li { grid-template-columns: 64px minmax(0, 1fr) 30px 52px; gap: 8px; }
  .project .label-long { display: none; }
}
`;

const PAGE_HTML = `
<header class="menubar">
  <a class="wordmark" href="/dashboard">Phone Use <em>cloud phones</em></a>
  <div class="meta"><span>usage</span><span class="dot" id="live"></span><span id="updated">--:--:--</span></div>
</header>
<div class="project">
  <span>Project: <b>usage.prproj</b></span>
  <span class="right"><span id="msg">Enter your API key to load usage.</span><button class="linkbtn" id="change" type="button" hidden>change key</button></span>
</div>
<main>
  <section class="panel program" aria-labelledby="cap-program">
    <div class="cap" id="cap-program"><span>Program: <b>Tokens</b></span><span class="mono" id="calls-cap"></span></div>
    <div class="body">
      <div class="label">Tokens billed</div>
      <div class="hero" id="t-tokens">0</div>
      <div class="readout" id="readout">
        <div><div class="k">Tokens in</div><div class="v in" id="t-in">0</div><div class="sub">from the agent</div></div>
        <div><div class="k">Tokens out</div><div class="v out" id="t-out">0</div><div class="sub" id="t-image">0 image</div></div>
        <div><div class="k">Calls</div><div class="v" id="t-calls">0</div><div class="sub" id="t-failed">no failures</div></div>
        <div><div class="k">Rig time</div><div class="v timecode" id="t-rig">00:00:00</div><div class="sub">hh:mm:ss leased</div></div>
      </div>
      <form id="keyform" autocomplete="off">
        <input id="key" type="password" placeholder="pu_…" aria-label="API key" spellcheck="false">
        <button type="submit">Load</button>
      </form>
      <p class="hint" id="keyhint">Your key stays in this tab only.</p>
    </div>
  </section>

  <section class="panel sequence" aria-labelledby="cap-seq">
    <div class="cap" id="cap-seq"><span>Sequence: <b>Last 60 min</b></span><span class="timecode" id="now-tc">00:00:00</span></div>
    <div class="seq">
      <div class="heads"><div class="rulerpad">1 min</div><div class="trackhead"><span class="id">V1</span><span class="nm">Tokens</span></div></div>
      <div class="lane-wrap">
        <div class="ruler" id="ruler"></div>
        <div class="lane" id="lane"><span class="peak" id="peak"></span></div>
        <div class="playhead"></div>
      </div>
    </div>
  </section>

  <section class="panel bin" aria-labelledby="cap-bin">
    <div class="cap" id="cap-bin"><span>Bin: <b>Tools</b></span><span class="mono" id="tool-count"></span></div>
    <div class="table-wrap"><table>
      <thead><tr><th>Name</th><th class="n">Calls</th><th class="n">Tokens</th><th class="n">Price</th></tr></thead>
      <tbody id="tools"></tbody>
    </table></div>
  </section>

  <section class="panel logpanel" aria-labelledby="cap-log">
    <div class="cap" id="cap-log"><span>Log: <b>Recent calls</b></span><span class="mono">newest first</span></div>
    <ol class="log" id="recent"></ol>
  </section>
</main>
<footer class="footer"><span>/v1/usage · polling 3s</span><span>© 2026 Phone Use</span></footer>
`;

// Client script: all data is inserted with textContent / createElement, never innerHTML.
const PAGE_JS = `
(() => {
  const KEY = 'phoneuse.apiKey';
  const $ = (id) => document.getElementById(id);
  let key = '';
  let timer = null;
  try { key = sessionStorage.getItem(KEY) || ''; } catch (e) {}

  const fmt = (n) => Number(n || 0).toLocaleString();
  const pad = (n) => String(n).padStart(2, '0');
  const timecode = (ms) => { const s = Math.floor((ms || 0) / 1000); return pad(Math.floor(s / 3600)) + ':' + pad(Math.floor(s / 60) % 60) + ':' + pad(s % 60); };
  const clock = (d) => pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
  const status = (text, isError) => { $('msg').textContent = text; $('msg').className = isError ? 'err' : ''; };
  const el = (tag, cls, text) => { const node = document.createElement(tag); if (cls) node.className = cls; if (text !== undefined) node.textContent = text; return node; };

  const FREE = 'var(--line-strong)';
  function toolColor(name, price) {
    if (!price) return FREE;
    if (name === 'phone_screenshot') return 'var(--clip-image)';
    if (name === 'phone_type') return 'var(--clip-text)';
    if (name === 'phone_live_feed') return 'var(--clip-fx)';
    return 'var(--clip-video)';
  }

  function setKeyMode(hasKey) {
    $('keyform').hidden = hasKey;
    $('keyhint').hidden = hasKey;
    $('readout').hidden = !hasKey;
    $('change').hidden = !hasKey;
  }

  function ruler() {
    const r = $('ruler');
    r.replaceChildren();
    [['-60m', 0], ['-45m', 25], ['-30m', 50], ['-15m', 75], ['now', 100]].forEach(([label, pct]) => {
      const t = el('span', pct === 100 ? 'tick end' : 'tick', label);
      t.style.left = pct + '%';
      r.appendChild(t);
    });
  }

  function timeline(points) {
    const lane = $('lane');
    const peakLabel = $('peak');
    lane.replaceChildren(peakLabel);
    const list = Array.isArray(points) ? points : [];
    const max = Math.max(1, ...list.map((p) => p.tokens || 0));
    peakLabel.textContent = 'peak ' + fmt(max) + ' / min';
    const slot = 100 / Math.max(1, list.length);
    list.forEach((p, i) => {
      if (!p.tokens) return;
      const c = el('div', 'clip');
      c.style.left = 'calc(' + (i * slot) + '% + 1px)';
      c.style.width = 'calc(' + slot + '% - 2px)';
      c.style.height = 'calc((100% - 28px) * ' + (p.tokens / max).toFixed(4) + ')';
      c.title = new Date(p.minute).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) + ' · ' + fmt(p.tokens) + ' tokens';
      lane.appendChild(c);
    });
  }

  function tools(u) {
    const body = $('tools');
    body.replaceChildren();
    const pricing = u.pricing || {};
    const byTool = u.byTool || {};
    const names = [...new Set([...Object.keys(pricing), ...Object.keys(byTool)])]
      .sort((a, b) => ((byTool[b] || {}).tokens || 0) - ((byTool[a] || {}).tokens || 0) || a.localeCompare(b));
    $('tool-count').textContent = names.length + ' items';
    if (!names.length) {
      const tr = el('tr', 'empty');
      const td = el('td', '', 'No tools yet');
      td.colSpan = 4;
      tr.appendChild(td);
      body.appendChild(tr);
      return;
    }
    for (const name of names) {
      const s = byTool[name] || {};
      const tr = el('tr');
      const nameCell = el('td');
      const sw = el('span', 'sw');
      sw.style.background = toolColor(name, pricing[name]);
      nameCell.append(sw, document.createTextNode(name));
      tr.append(nameCell, el('td', 'n', fmt(s.calls)), el('td', 'n', fmt(s.tokens)), el('td', 'n', name in pricing ? fmt(pricing[name]) : '–'));
      body.appendChild(tr);
    }
  }

  function log(u) {
    const list = $('recent');
    list.replaceChildren();
    const rows = Array.isArray(u.recent) ? u.recent : [];
    if (!rows.length) { list.appendChild(el('li', 'none', 'No calls yet.')); return; }
    const pricing = u.pricing || {};
    for (const r of rows) {
      const li = el('li');
      li.style.borderLeftColor = toolColor(r.tool, pricing[r.tool]);
      li.append(
        el('span', 't', clock(new Date(r.at))),
        el('span', 'tool', r.tool),
        el('span', r.ok ? 'st' : 'st bad', r.ok ? 'OK' : 'ERR'),
        el('span', 'tok', fmt(r.tokens)),
      );
      list.appendChild(li);
    }
  }

  function render(u) {
    $('t-tokens').textContent = fmt(u.tokens);
    $('t-in').textContent = fmt(u.tokensIn || 0);
    $('t-out').textContent = fmt(u.tokensOut || 0);
    $('t-image').textContent = 'incl. ' + fmt(u.imageTokens) + ' image';
    $('t-calls').textContent = fmt(u.calls);
    $('t-failed').textContent = u.failedCalls ? fmt(u.failedCalls) + ' failed' : 'no failures';
    $('t-rig').textContent = timecode(u.rigMs);
    $('calls-cap').textContent = fmt(u.calls) + ' calls';
    timeline(u.perMinute);
    tools(u);
    log(u);
  }

  async function load() {
    if (!key) return;
    try {
      const res = await fetch('/v1/usage', { headers: { Authorization: 'Bearer ' + key }, cache: 'no-store' });
      if (res.status === 401) { stop(); setKeyMode(false); status('That API key was rejected. Check it and try again.', true); return; }
      if (res.status === 429) { status('Rate limited; retrying shortly.', true); return; }
      if (!res.ok) { status('Gateway returned HTTP ' + res.status + '; retrying.', true); return; }
      render(await res.json());
      const now = new Date();
      $('updated').textContent = clock(now);
      $('live').className = 'dot live';
      status('Connected', false);
    } catch (e) {
      $('live').className = 'dot';
      status('Could not reach the gateway; retrying.', true);
    }
  }
  function stop() { if (timer) clearInterval(timer); timer = null; $('live').className = 'dot'; }
  function start() { stop(); setKeyMode(true); load(); timer = setInterval(load, 3000); }

  setInterval(() => { $('now-tc').textContent = clock(new Date()); }, 1000);
  $('now-tc').textContent = clock(new Date());
  ruler();
  timeline([]);
  setKeyMode(false);

  $('keyform').addEventListener('submit', (event) => {
    event.preventDefault();
    const candidate = $('key').value.trim();
    if (!/^pu_[A-Za-z0-9_-]+$/.test(candidate)) { status('API keys start with pu_.', true); return; }
    key = candidate;
    try { sessionStorage.setItem(KEY, key); } catch (e) {}
    status('Loading…', false);
    start();
  });
  $('change').addEventListener('click', () => {
    stop();
    key = '';
    try { sessionStorage.removeItem(KEY); } catch (e) {}
    $('key').value = '';
    setKeyMode(false);
    status('Enter your API key to load usage.', false);
    $('key').focus();
  });
  if (key) start();
})();
`;

export function dashboardPage(): string {
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Phone Use usage</title>
${FONT_LINKS}
<style>${THEME_CSS}${PAGE_CSS}</style>
</head><body>${PAGE_HTML}<script>${PAGE_JS}</script></body></html>`;
}
