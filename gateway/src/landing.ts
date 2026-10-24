import { FONT_LINKS, THEME_CSS } from './theme.js';
import { DEFAULT_PRICING } from './usage.js';

/** Public landing page, in the same editor-shell look as the dashboard, live feed and review. */

const REPO_URL = 'https://github.com/ryunzz/phoneuse_agent';

interface ToolRow {
  readonly name: string;
  readonly what: string;
  readonly clip: string;
}

const TOOLS: readonly ToolRow[] = [
  { name: 'phone_connect', what: 'Reserve a phone, start a recorded task', clip: '--line-strong' },
  { name: 'phone_screenshot', what: 'Current screen as an image', clip: '--clip-image' },
  { name: 'phone_tap', what: 'Tap at normalized x, y', clip: '--clip-video' },
  { name: 'phone_scroll', what: 'Scroll from an anchor point', clip: '--clip-video' },
  { name: 'phone_type', what: 'Type into the focused field', clip: '--clip-text' },
  { name: 'phone_home', what: 'Back to the home screen', clip: '--clip-video' },
  { name: 'phone_live_feed', what: 'Shareable live view link', clip: '--clip-fx' },
  { name: 'phone_task_done', what: 'Report how the task ended', clip: '--line-strong' },
  { name: 'ask_user', what: 'Pause for a human (2FA codes)', clip: '--clip-audio' },
  { name: 'phone_do', what: 'Hand a goal to the phone VLA', clip: '--playhead' },
  { name: 'usage_get', what: 'Tokens used by this key', clip: '--line-strong' },
];

const SEQUENCE: readonly { readonly label: string; readonly clip: string }[] = [
  { label: 'Connect', clip: '--line-strong' },
  { label: 'Screenshot', clip: '--clip-image' },
  { label: 'Tap / Type', clip: '--clip-video' },
  { label: 'Verify', clip: '--clip-image' },
  { label: 'Episode', clip: '--clip-text' },
  { label: 'Review', clip: '--clip-audio' },
  { label: 'VLA', clip: '--playhead' },
];

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
}

function price(tool: string): string {
  const tokens = DEFAULT_PRICING[tool];
  if (tokens === undefined) return '—';
  return tokens === 0 ? 'free' : String(tokens);
}

export function landingPage(publicUrl: string): string {
  const command = `claude mcp add --transport http phoneuse ${publicUrl}/mcp --header "Authorization: Bearer pu_…"`;
  const toolRows = TOOLS.map(
    (tool) => `<tr><td><i class="sw" style="background:var(${tool.clip})"></i>${tool.name}</td><td class="what">${tool.what}</td><td class="num">${price(tool.name)}</td></tr>`,
  ).join('');
  const clips = SEQUENCE.map(
    (clip, index) => `<li style="--c:var(${clip.clip})"><span class="n">${String(index + 1).padStart(2, '0')}</span>${clip.label}</li>`,
  ).join('');

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Phone Use · Cloud phones for AI agents</title>
<meta name="description" content="Real phones on hardware rigs that any AI agent can drive over MCP. Billed per token; every run teaches our phone model.">
${FONT_LINKS}
<style>${THEME_CSS}
body { min-height: 100vh; display: flex; flex-direction: column; }
.menubar nav { display: flex; gap: 4px; }
.menubar nav a { font: 400 13px/18px var(--font-ui); color: var(--ink-muted); text-decoration: none; padding: 4px 10px; border-radius: var(--radius-md); }
.menubar nav a:hover, .menubar nav a:focus-visible { color: var(--ink); background: var(--panel-200); }
main { flex: 1; width: 100%; max-width: 1180px; margin: 0 auto; padding: 8px; display: grid; gap: 8px; grid-template-columns: minmax(0, 1.25fr) minmax(0, 1fr); grid-template-areas: "hero program" "seq seq" "connect bin" "connect bin"; }
.hero { grid-area: hero; } .program { grid-area: program; } .seq { grid-area: seq; } .connect { grid-area: connect; } .bin { grid-area: bin; }
.hero .body { padding: 40px 28px 32px; }
.kicker { font: 500 12px/16px var(--font-mono); letter-spacing: .24em; text-transform: uppercase; color: var(--ink-faint); margin: 0 0 20px; }
h1 { font: 400 clamp(44px, 6.4vw, 84px)/.95 var(--font-display); letter-spacing: -0.01em; margin: 0; }
h1 em { display: block; color: var(--ink-muted); }
.lede { font: 400 15px/23px var(--font-ui); color: var(--ink-muted); max-width: 46ch; margin: 24px 0 28px; }
.lede b { color: var(--ink); font-weight: 500; }
.actions { display: flex; flex-wrap: wrap; gap: 8px; }
.btn.solid { background: var(--playhead); color: var(--on-playhead); }
.btn.solid:hover { background: color-mix(in srgb, var(--playhead) 85%, white); }
a.btn { text-decoration: none; display: inline-block; }
.btn.ghost { color: var(--ink-muted); border-color: var(--line); }
.btn.ghost:hover { color: var(--ink); background: var(--panel-200); }
.program .monitor { background: var(--black); display: grid; place-items: center; padding: 28px 16px; min-height: 360px; }
.phone { width: 176px; aspect-ratio: 9 / 19.5; border: 1px solid var(--line-strong); border-radius: 30px; padding: 9px; background: var(--panel-000); position: relative; }
.phone .screen { height: 100%; border-radius: 22px; background: var(--panel-100); border: 1px solid var(--line); position: relative; overflow: hidden; }
.phone .island { position: absolute; top: 8px; left: 50%; transform: translateX(-50%); width: 56px; height: 16px; border-radius: 10px; background: var(--black); }
.phone .grid { position: absolute; inset: 40px 14px auto; display: grid; grid-template-columns: repeat(4, 1fr); gap: 10px; }
.phone .grid i { aspect-ratio: 1; border-radius: 7px; background: var(--panel-300); }
.phone .grid i:nth-child(6) { background: color-mix(in srgb, var(--playhead) 30%, var(--panel-300)); }
.tapmark { position: absolute; top: 81px; left: 63px; width: 26px; height: 26px; border: 1.5px solid var(--playhead); border-radius: 50%; }
.tapmark::before, .tapmark::after { content: ""; position: absolute; background: var(--playhead); }
.tapmark::before { left: 50%; top: -7px; bottom: -7px; width: 1.5px; transform: translateX(-50%); }
.tapmark::after { top: 50%; left: -7px; right: -7px; height: 1.5px; transform: translateY(-50%); }
.phone .dock { position: absolute; left: 12px; right: 12px; bottom: 12px; height: 38px; border-radius: 14px; background: var(--panel-200); }
.transport { height: 40px; display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 0 12px; border-top: 1px solid var(--line); font: 400 12px/16px var(--font-mono); color: var(--ink-faint); }
.transport > span:last-child { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.transport .state { display: flex; align-items: center; gap: 8px; letter-spacing: .12em; text-transform: uppercase; font-size: 11px; color: var(--ink-muted); }
.caption { font: 400 12px/16px var(--font-mono); color: var(--ink-faint); padding: 10px 12px; border-top: 1px solid var(--line); }
.seq ol { list-style: none; margin: 0; padding: 12px; display: grid; grid-template-columns: repeat(7, minmax(0, 1fr)); gap: 4px; position: relative; }
.seq li { position: relative; height: 44px; display: flex; align-items: flex-end; gap: 8px; padding: 6px 8px; border-radius: var(--radius-sm); background: color-mix(in srgb, var(--c) 22%, var(--panel-000)); border-top: 2px solid var(--c); font: 500 12px/14px var(--font-ui); color: var(--ink); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.seq li .n { font: 400 10px/12px var(--font-mono); color: var(--ink-faint); }
.seq .ruler { display: flex; justify-content: space-between; padding: 6px 12px 0; font: 400 10px/12px var(--font-mono); color: var(--ink-faint); }
.connect .body { padding: 16px; display: grid; grid-template-columns: minmax(0, 1fr); gap: 14px; }
.connect p { margin: 0; color: var(--ink-muted); font: 400 14px/21px var(--font-ui); }
.snippet { display: flex; align-items: stretch; border: 1px solid var(--line); border-radius: var(--radius-sm); background: var(--panel-000); }
.snippet code { flex: 1; min-width: 0; padding: 10px 12px; font: 400 12px/18px var(--font-mono); color: var(--ink); overflow-x: auto; white-space: pre; }
.snippet button { border: 0; border-left: 1px solid var(--line); border-radius: 0; flex: none; }
.steps { margin: 0; padding: 0; list-style: none; display: grid; gap: 8px; }
.steps li { display: grid; grid-template-columns: 34px 1fr; gap: 8px; font: 400 13px/19px var(--font-ui); color: var(--ink-muted); }
.steps li span { font: 500 12px/19px var(--font-mono); color: var(--playhead); }
.steps a { color: var(--ink); }
.note { font: 400 12px/18px var(--font-mono); color: var(--ink-faint); border-top: 1px solid var(--line); padding-top: 12px; }
.bin .scroll { overflow-x: auto; }
table { width: 100%; border-collapse: collapse; }
th { font: 600 11px/16px var(--font-ui); letter-spacing: .08em; text-transform: uppercase; color: var(--ink-faint); text-align: left; padding: 8px 12px; border-bottom: 1px solid var(--line); }
td { padding: 7px 12px; border-bottom: 1px solid var(--panel-200); font: 400 12px/16px var(--font-mono); color: var(--ink); white-space: nowrap; }
td.what { font-family: var(--font-ui); color: var(--ink-muted); white-space: normal; }
th.num, td.num { text-align: right; }
.sw { display: inline-block; width: 8px; height: 8px; border-radius: 1px; margin-right: 8px; vertical-align: 1px; }
.bin .foot { padding: 10px 12px; font: 400 12px/16px var(--font-mono); color: var(--ink-faint); }
@media (max-width: 860px) {
  main { grid-template-columns: minmax(0, 1fr); grid-template-areas: "hero" "program" "seq" "connect" "bin"; padding: 8px 12px; }
  .hero .body { padding: 28px 16px 24px; }
  .seq ol { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .menubar nav a.hide-sm { display: none; }
  td.what, th.what { display: none; }
}
</style></head><body>
<header class="menubar"><a class="wordmark" href="/">Phone Use <em>cloud phones</em></a>
<nav aria-label="Primary"><a href="/dashboard">Usage</a><a class="hide-sm" href="/review">Review</a><a href="${REPO_URL}">GitHub</a></nav></header>
<main>
<section class="panel hero" aria-labelledby="title">
  <div class="cap"><span>Project: <b>PHONEUSE.PRPROJ</b></span><span class="mono">v0.1</span></div>
  <div class="body">
    <p class="kicker">Cal Hacks 13.0 · computer use for any screen</p>
    <h1 id="title">Cloud phones for AI agents.<em>No API required.</em></h1>
    <p class="lede">Real phones on our rigs. <b>Any agent drives them over MCP</b>: screenshot, tap, scroll, type. Usage is <b>billed per token</b>, and <b>every run teaches our phone model</b>.</p>
    <div class="actions"><a class="btn solid" href="#connect">Connect an agent</a><a class="btn ghost" href="/dashboard">View usage</a></div>
  </div>
</section>

<section class="panel program" aria-label="Phone monitor">
  <div class="cap"><span>Program: <b>Rig 01</b></span><span class="mono">636 × 1402</span></div>
  <div class="monitor"><div class="phone" aria-hidden="true"><div class="screen"><span class="island"></span><div class="grid">${'<i></i>'.repeat(12)}</div><span class="tapmark"></span><span class="dock"></span></div></div></div>
  <div class="caption">phone_tap(x=0.52, y=0.18, reason="open Settings")</div>
  <div class="transport"><span class="state"><span class="dot live"></span>live</span><span class="timecode">00:00:04:12</span><span>iPhone Mirroring · stylus rig in progress</span></div>
</section>

<section class="panel seq" aria-label="How a run works">
  <div class="cap"><span>Sequence: <b>One run</b></span><span class="mono">agent → rig → model</span></div>
  <div class="ruler" aria-hidden="true"><span>00:00</span><span>00:05</span><span>00:10</span><span>00:15</span></div>
  <ol>${clips}</ol>
</section>

<section class="panel connect" id="connect" aria-labelledby="connect-title">
  <div class="cap"><span id="connect-title">Connect: <b>Claude Code</b></span><span class="mono">remote MCP</span></div>
  <div class="body">
    <p>One URL and an API key. Nothing to install on your side.</p>
    <div class="snippet"><code id="cmd">${escapeHtml(command)}</code><button type="button" id="copy" aria-label="Copy command">Copy</button></div>
    <ol class="steps">
      <li><span>01</span><div>Get an API key (<code>pu_…</code>) from the team.</div></li>
      <li><span>02</span><div>Add the server above, then ask Claude to do something on the phone.</div></li>
      <li><span>03</span><div>Watch it live with <code>phone_live_feed</code>, and track tokens on <a href="/dashboard">the dashboard</a>.</div></li>
    </ol>
    <p class="note">Today the phone is driven through iPhone Mirroring with an operator present. The physical stylus rig is in progress and not yet verified.</p>
  </div>
</section>

<section class="panel bin" aria-labelledby="bin-title">
  <div class="cap"><span id="bin-title">Bin: <b>Tools</b></span><span class="mono">${TOOLS.length} items</span></div>
  <div class="scroll"><table><thead><tr><th>Name</th><th class="what">What it does</th><th class="num">Tokens</th></tr></thead><tbody>${toolRows}</tbody></table></div>
  <div class="foot">Billed = base + image tokens returned · failed calls are free</div>
</section>
</main>
<footer class="footer"><span><a href="${REPO_URL}" style="color:inherit">ryunzz/phoneuse_agent</a></span><span>© 2026 Phone Use</span></footer>
<script>
document.getElementById('copy').addEventListener('click', async (event) => {
  const button = event.currentTarget;
  try {
    await navigator.clipboard.writeText(document.getElementById('cmd').textContent);
    button.textContent = 'Copied';
  } catch {
    button.textContent = 'Select & copy';
  }
  setTimeout(() => { button.textContent = 'Copy'; }, 1600);
});
</script></body></html>`;
}
