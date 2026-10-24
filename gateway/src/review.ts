import { createHash, timingSafeEqual } from 'node:crypto';
import { appendFileSync, existsSync, readdirSync, readFileSync } from 'node:fs';
import type { IncomingMessage } from 'node:http';
import path from 'node:path';
import { FONT_LINKS, PAGE_CSP, THEME_CSS } from './theme.js';

/**
 * Human review of recorded episodes (episodes.py on-disk format). Labels and outcomes are
 * appended, never rewritten, so the original trace stays intact for `episodes.py export`.
 */

export const REVIEW_CSP = PAGE_CSP.replace("img-src 'self' data:", "img-src 'self' data: blob:");

const EPISODE_ID = /^[0-9a-f]{32}$/;
const IMAGE_NAME = /^\d{5}-(before|after)\.jpg$/;
const STEP_LABELS = ['correct', 'mistake', 'recovery', 'unreviewed'] as const;
const OUTCOMES = ['success', 'failed', 'abandoned'] as const;

type StepLabel = (typeof STEP_LABELS)[number];
type Outcome = (typeof OUTCOMES)[number];
type Row = Record<string, unknown>;

export class ReviewError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

export interface ReviewResponse {
  readonly status: number;
  readonly body: unknown;
  readonly type?: string;
}

export interface EpisodeSummary {
  readonly episode_id: string;
  readonly instruction: string;
  readonly group: string;
  readonly split: string;
  readonly started_at: number;
  readonly steps: number;
  readonly outcome: string | null;
  readonly reported_by: string | null;
  readonly reviewed: number;
  readonly exportable: boolean;
}

export interface StepView {
  readonly step: number;
  readonly action: unknown;
  readonly note: string;
  readonly label: string;
  readonly status: string;
  readonly error: string | null;
  readonly before_image: string | null;
  readonly after_image: string | null;
}

/** Parse JSONL like episodes.events(): stop at the first unparseable (e.g. truncated) line. */
function events(file: string): Row[] {
  if (!existsSync(file)) return [];
  const rows: Row[] = [];
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line) continue;
    try {
      rows.push(JSON.parse(line) as Row);
    } catch {
      break;
    }
  }
  return rows;
}

function append(file: string, row: Row): void {
  appendFileSync(file, JSON.stringify(row) + '\n', { mode: 0o600 });
}

function imageName(frame: unknown): string | null {
  const name = (frame as Row | undefined)?.image;
  return typeof name === 'string' && IMAGE_NAME.test(name) ? name : null;
}

interface Loaded {
  readonly meta: Row;
  readonly outcome: Row | null;
  readonly steps: readonly StepView[];
}

function load(folder: string): Loaded {
  const meta = JSON.parse(readFileSync(path.join(folder, 'episode.json'), 'utf8')) as Row;
  const outcomes = events(path.join(folder, 'outcome.jsonl'));
  const log = events(path.join(folder, 'steps.jsonl'));
  const labels = new Map<number, Row>();
  for (const row of events(path.join(folder, 'annotations.jsonl'))) labels.set(Number(row.step), row);
  const results = new Map<number, Row>();
  for (const row of log) if (row.event === 'result') results.set(Number(row.step), row);
  const steps = log
    .filter((row) => row.event === 'intent')
    .map((intent): StepView => {
      const step = Number(intent.step);
      const result = results.get(step);
      return {
        step,
        action: intent.action,
        note: typeof intent.note === 'string' ? intent.note : '',
        label: String((labels.get(step) ?? intent).label ?? 'unreviewed'),
        status: typeof result?.status === 'string' ? result.status : 'pending',
        error: typeof result?.error === 'string' ? result.error : null,
        before_image: imageName(intent.before),
        after_image: imageName(result?.after),
      };
    });
  return { meta, outcome: outcomes.at(-1) ?? null, steps };
}

function summarize(id: string, { meta, outcome, steps }: Loaded): EpisodeSummary {
  const success = outcome?.outcome === 'success';
  return {
    episode_id: id,
    instruction: String(meta.instruction ?? ''),
    group: String(meta.group ?? ''),
    split: String(meta.split ?? ''),
    started_at: Number(meta.started_at ?? 0),
    steps: steps.length,
    outcome: typeof outcome?.outcome === 'string' ? outcome.outcome : null,
    reported_by: typeof outcome?.reported_by === 'string' ? outcome.reported_by : null,
    reviewed: steps.filter((step) => step.label !== 'unreviewed').length,
    exportable:
      success &&
      steps.length > 0 &&
      steps.every((step) => step.status === 'complete') &&
      steps.some((step) => step.label === 'correct' || step.label === 'recovery'),
  };
}

function tokenMatches(given: string, expected: string): boolean {
  // Hash both sides so timingSafeEqual always compares equal-length buffers.
  const a = createHash('sha256').update(given).digest();
  const b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b);
}

function optionalNote(value: unknown): string {
  if (value === undefined) return '';
  if (typeof value !== 'string' || value.length > 2000) throw new ReviewError(400, 'note must be text up to 2000 characters');
  return value;
}

export interface ReviewApi {
  /** Returns null when the path is not a review route. */
  handle(req: IncomingMessage, pathname: string, readJson: () => Promise<unknown>): Promise<ReviewResponse | null>;
}

export function createReviewApi(traceDir: string | null, reviewToken: string | null): ReviewApi {
  const folderFor = (id: string): string => {
    if (!traceDir || !EPISODE_ID.test(id)) throw new ReviewError(404, 'Episode not found');
    const folder = path.join(traceDir, id);
    if (!existsSync(path.join(folder, 'episode.json'))) throw new ReviewError(404, 'Episode not found');
    return folder;
  };

  const list = (): EpisodeSummary[] => {
    if (!traceDir || !existsSync(traceDir)) return [];
    const summaries: EpisodeSummary[] = [];
    for (const id of readdirSync(traceDir)) {
      if (!EPISODE_ID.test(id) || !existsSync(path.join(traceDir, id, 'episode.json'))) continue;
      try {
        summaries.push(summarize(id, load(path.join(traceDir, id))));
      } catch (error) {
        console.warn(`[review] skipping unreadable episode ${id}`, error);
      }
    }
    return summaries.sort((a, b) => b.started_at - a.started_at);
  };

  const authorize = (req: IncomingMessage): void => {
    const header = req.headers.authorization;
    const match = typeof header === 'string' ? /^Bearer\s+(\S+)$/i.exec(header.trim()) : null;
    if (!match || !reviewToken || !tokenMatches(match[1], reviewToken)) throw new ReviewError(401, 'Missing or invalid review token');
  };

  return {
    async handle(req, pathname, readJson) {
      if (!pathname.startsWith('/v1/episodes')) return null;
      if (!reviewToken || !traceDir) throw new ReviewError(404, 'Not found');
      authorize(req);

      if (pathname === '/v1/episodes' && req.method === 'GET') return { status: 200, body: list() };

      const detail = /^\/v1\/episodes\/([^/]+)$/.exec(pathname);
      if (detail && req.method === 'GET') {
        const loaded = load(folderFor(detail[1]));
        return { status: 200, body: { meta: loaded.meta, outcome: loaded.outcome, steps: loaded.steps } };
      }

      const image = /^\/v1\/episodes\/([^/]+)\/images\/([^/]+)$/.exec(pathname);
      if (image && req.method === 'GET') {
        const folder = folderFor(image[1]);
        if (!IMAGE_NAME.test(image[2])) throw new ReviewError(404, 'Image not found');
        const file = path.join(folder, image[2]);
        if (!existsSync(file)) throw new ReviewError(404, 'Image not found');
        return { status: 200, body: readFileSync(file), type: 'image/jpeg' };
      }

      const label = /^\/v1\/episodes\/([^/]+)\/steps\/(\d{1,6})\/label$/.exec(pathname);
      if (label && req.method === 'POST') {
        const folder = folderFor(label[1]);
        const step = Number(label[2]);
        const body = (await readJson()) as Row | null;
        const value = body?.label;
        if (typeof value !== 'string' || !STEP_LABELS.includes(value as StepLabel)) {
          throw new ReviewError(400, `label must be one of ${STEP_LABELS.join(', ')}`);
        }
        const note = optionalNote(body?.note);
        if (!load(folder).steps.some((item) => item.step === step)) throw new ReviewError(404, 'Step not found');
        // Same row shape as episodes.annotate(), so the Python exporter reads it unchanged.
        const row = { step, label: value, reviewer: 'web-review', note, boxes: [], coordinate_space: 'before_image_normalized', at: Date.now() / 1000 };
        append(path.join(folder, 'annotations.jsonl'), row);
        return { status: 200, body: row };
      }

      const outcome = /^\/v1\/episodes\/([^/]+)\/outcome$/.exec(pathname);
      if (outcome && req.method === 'POST') {
        const folder = folderFor(outcome[1]);
        const body = (await readJson()) as Row | null;
        const value = body?.outcome;
        if (typeof value !== 'string' || !OUTCOMES.includes(value as Outcome)) {
          throw new ReviewError(400, `outcome must be one of ${OUTCOMES.join(', ')}`);
        }
        const row = { outcome: value, note: optionalNote(body?.note), finished_at: Date.now() / 1000, reported_by: 'reviewer' };
        append(path.join(folder, 'outcome.jsonl'), row);
        return { status: 200, body: row };
      }

      throw new ReviewError(404, 'Not found');
    },
  };
}

const PAGE_CSS = `
body { min-height: 100vh; display: flex; flex-direction: column; }
[hidden] { display: none !important; }
.project { height: 28px; display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 0 16px; border-bottom: 1px solid var(--line); background: var(--panel-000); font: 600 11px/16px var(--font-ui); letter-spacing: .08em; text-transform: uppercase; color: var(--ink-faint); }
.project b { color: var(--ink); font-weight: 600; }
#msg { font: 400 12px/16px var(--font-mono); letter-spacing: 0; text-transform: none; color: var(--ink-muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
#msg.err { color: var(--rec); }
.linkbtn { border: 0; padding: 0; font: 400 12px/16px var(--font-mono); color: var(--ink-faint); letter-spacing: 0; text-transform: none; }
.linkbtn:hover { background: none; color: var(--playhead); }
main { flex: 1; display: grid; gap: 6px; padding: 6px; grid-template-columns: minmax(240px, 320px) minmax(0, 1fr); grid-template-rows: minmax(0, 1fr) auto; min-height: 0; }
.panel { display: flex; flex-direction: column; min-height: 0; }
.bin { grid-row: 1 / span 2; }
.cap .acts { display: flex; gap: 6px; text-transform: none; letter-spacing: 0; }
.cap button { padding: 2px 8px; font-size: 11px; }

/* Bin: episode list */
.episodes { list-style: none; margin: 0; padding: 0; overflow-y: auto; flex: 1; }
.episodes li { border-bottom: 1px solid var(--panel-200); }
.episodes button { all: unset; box-sizing: border-box; display: block; width: 100%; padding: 8px 12px; cursor: pointer; }
.episodes button:hover { background: var(--panel-200); }
.episodes button[aria-current="true"] { background: var(--panel-300); box-shadow: inset 2px 0 var(--playhead); }
.episodes button:focus-visible { outline: 2px solid var(--playhead); outline-offset: -2px; }
.ep-title { font: 500 13px/18px var(--font-ui); color: var(--ink); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ep-meta { display: flex; gap: 10px; margin-top: 2px; font: 400 11px/14px var(--font-mono); color: var(--ink-faint); }
.ep-meta .ok { color: var(--clip-audio); }
.ep-meta .bad { color: var(--rec); }
.none { padding: 14px 12px; color: var(--ink-faint); font: 400 12px/16px var(--font-mono); }

/* Program: before/after monitor */
.monitor { flex: 1; display: grid; grid-template-columns: 1fr 1fr; gap: 6px; padding: 10px; background: var(--black); min-height: 0; }
.frame { display: flex; flex-direction: column; align-items: center; gap: 6px; min-width: 0; min-height: 0; }
.frame .k { align-self: stretch; font: 500 11px/16px var(--font-mono); letter-spacing: .24em; text-transform: uppercase; color: var(--ink-faint); }
.shot { position: relative; display: inline-block; max-width: 100%; }
.shot img { display: block; max-width: 100%; max-height: calc(100vh - 345px); min-height: 120px; border-radius: 14px; border: 1px solid var(--line); background: var(--panel-000); }
.shot .missing { width: 180px; height: 320px; display: grid; place-items: center; border: 1px dashed var(--line); border-radius: 14px; font: 400 11px/14px var(--font-mono); color: var(--ink-faint); text-align: center; padding: 12px; }
.mark { position: absolute; pointer-events: none; }
.tap { width: 34px; height: 34px; margin: -17px 0 0 -17px; border: 2px solid var(--playhead); border-radius: 50%; box-shadow: 0 0 0 2px #0009, 0 0 14px var(--playhead); }
.tap::before, .tap::after { content: ""; position: absolute; background: var(--playhead); }
.tap::before { left: 50%; top: -9px; bottom: -9px; width: 1px; }
.tap::after { top: 50%; left: -9px; right: -9px; height: 1px; }
.scroll { width: 2px; margin-left: -1px; background: var(--playhead); box-shadow: 0 0 0 1px #0009; }
.scroll::after { content: ""; position: absolute; left: -6px; border: 7px solid transparent; }
.scroll.up::after { top: -12px; border-bottom: 9px solid var(--playhead); }
.scroll.down::after { bottom: -12px; border-top: 9px solid var(--playhead); }
.caption { left: 8px; right: 8px; bottom: 10px; background: #000c; border: 1px solid var(--playhead); border-radius: var(--radius-sm); padding: 4px 8px; font: 500 12px/16px var(--font-mono); color: var(--playhead); overflow-wrap: anywhere; }
.detail { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 12px; align-items: start; padding: 10px 12px; border-top: 1px solid var(--line); }
.action { font: 500 12px/16px var(--font-mono); color: var(--ink); overflow-wrap: anywhere; }
.note { margin-top: 4px; color: var(--ink-muted); }
.note.empty { color: var(--ink-faint); font-family: var(--font-mono); font-size: 12px; }
.status { font: 400 11px/14px var(--font-mono); color: var(--ink-faint); margin-top: 4px; }
.status.bad { color: var(--rec); }
.labels { display: flex; gap: 6px; flex-wrap: wrap; justify-content: flex-end; }
.labels button { display: flex; gap: 6px; align-items: center; }
.labels kbd { font: 400 10px/12px var(--font-mono); color: var(--ink-faint); border: 1px solid var(--line); border-radius: var(--radius-sm); padding: 0 4px; }
.labels button[data-label="correct"] { color: var(--clip-audio); border-color: var(--clip-audio); }
.labels button[data-label="mistake"] { color: var(--rec); border-color: var(--rec); }
.labels button[data-label="recovery"] { color: var(--clip-fx); border-color: var(--clip-fx); }
.labels button[aria-pressed="true"] { background: var(--panel-300); box-shadow: inset 0 -2px currentColor; }
.cur-label { font: 500 11px/16px var(--font-mono); letter-spacing: .12em; text-transform: uppercase; }

/* Sequence: step clips */
.seq { display: grid; grid-template-columns: 96px minmax(0, 1fr); min-height: 54px; }
.trackhead { display: flex; align-items: center; gap: 8px; padding: 0 10px; border-right: 1px solid var(--line); background: var(--panel-000); }
.trackhead .id { font: 500 11px/14px var(--font-mono); background: var(--panel-300); border: 1px solid var(--line); border-radius: var(--radius-sm); padding: 1px 5px; }
.trackhead .nm { color: var(--ink-muted); }
.clips { display: flex; gap: 3px; padding: 8px; overflow-x: auto; align-items: stretch; }
.clips button { all: unset; box-sizing: border-box; flex: 1 0 44px; max-width: 120px; height: 32px; border-radius: var(--radius-sm); background: var(--line-strong); color: var(--panel-000); font: 500 11px/14px var(--font-mono); padding: 4px 6px; cursor: pointer; position: relative; }
.clips button[data-label="correct"] { background: var(--clip-audio); }
.clips button[data-label="mistake"] { background: var(--rec); }
.clips button[data-label="recovery"] { background: var(--clip-fx); }
.clips button[aria-current="true"] { outline: 2px solid var(--playhead); outline-offset: 1px; }
.clips button[aria-current="true"]::before { content: ""; position: absolute; left: 50%; top: -9px; margin-left: -5px; border: 5px solid transparent; border-top: 6px solid var(--playhead); }
.clips button:focus-visible { outline: 2px solid var(--ink); }

#tokenform { display: flex; gap: 6px; max-width: 420px; margin: 0 auto; }
#tokenform input { flex: 1; min-width: 0; }
.gate { flex: 1; display: grid; place-items: center; text-align: center; padding: 24px 16px; }
.gate h1 { font: 400 44px/1 var(--font-display); margin: 0 0 8px; }
.gate p { font: 500 12px/16px var(--font-mono); letter-spacing: .24em; text-transform: uppercase; color: var(--ink-faint); margin: 0 0 18px; }

@media (max-width: 860px) {
  main { grid-template-columns: minmax(0, 1fr); grid-template-rows: auto; padding: 6px 12px; }
  .bin { grid-row: auto; max-height: 260px; }
  .menubar, .project, .footer { padding: 0 12px; }
  .shot img { max-height: 56vh; }
  .detail { grid-template-columns: minmax(0, 1fr); }
  .labels { justify-content: flex-start; }
  .seq { grid-template-columns: 56px minmax(0, 1fr); }
  .trackhead .nm { display: none; }
}
`;

const PAGE_HTML = `
<header class="menubar">
  <a class="wordmark" href="/dashboard">Phone Use <em>review</em></a>
  <div class="meta"><span id="count">--</span><span class="dot" id="live"></span></div>
</header>
<div class="project"><span>Project: <b>Episodes.prproj</b></span><span id="msg">Enter the review token.</span><button class="linkbtn" id="signout" type="button" hidden>change token</button></div>
<section class="gate" id="gate">
  <div><h1>Review episodes</h1><p>label agent steps for the VLM</p>
  <form id="tokenform"><label class="sr" for="token" hidden>Review token</label><input id="token" type="password" autocomplete="off" placeholder="REVIEW_TOKEN" aria-label="Review token"><button type="submit">Load</button></form></div>
</section>
<main id="workspace" hidden>
  <section class="panel bin" aria-label="Episodes">
    <div class="cap"><span>Project: <b>Episodes</b></span><span id="epcount" class="mono"></span></div>
    <ul class="episodes" id="episodes"></ul>
  </section>
  <section class="panel" aria-label="Selected step">
    <div class="cap"><span>Program: <b id="progtitle">No episode</b></span><span class="acts" id="outcomebar" hidden>
      <span id="outcome" class="mono"></span>
      <button type="button" data-outcome="success">Success</button><button type="button" data-outcome="failed">Failed</button><button type="button" data-outcome="abandoned">Abandoned</button></span></div>
    <div class="monitor">
      <div class="frame"><span class="k">Before · action</span><div class="shot" id="before"></div></div>
      <div class="frame"><span class="k">After</span><div class="shot" id="after"></div></div>
    </div>
    <div class="detail">
      <div><div class="action" id="action">Select an episode.</div><div class="note empty" id="note"></div><div class="status" id="status"></div></div>
      <div><div class="labels">
        <button type="button" data-label="correct">Correct <kbd>C</kbd></button>
        <button type="button" data-label="mistake">Mistake <kbd>M</kbd></button>
        <button type="button" data-label="recovery">Recovery <kbd>R</kbd></button>
      </div></div>
    </div>
  </section>
  <section class="panel" aria-label="Steps">
    <div class="cap"><span>Sequence: <b id="seqtitle">Steps</b></span><span class="timecode" id="pos">00 / 00</span></div>
    <div class="seq"><div class="trackhead"><span class="id">V1</span><span class="nm">Steps</span></div><div class="clips" id="clips"></div></div>
  </section>
</main>
<footer class="footer"><span>/v1/episodes · ← → steps · C M R label</span><span>© 2026 Phone Use</span></footer>
`;

const PAGE_JS = `
(() => {
  const KEY = 'phoneuse.reviewToken';
  const $ = (id) => document.getElementById(id);
  const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text !== undefined) n.textContent = text; return n; };
  const store = { get() { try { return sessionStorage.getItem(KEY); } catch { return null; } }, set(v) { try { v ? sessionStorage.setItem(KEY, v) : sessionStorage.removeItem(KEY); } catch {} } };
  let token = store.get(), episodes = [], current = null, stepIndex = 0, urls = [];

  function message(text, bad) { $('msg').textContent = text; $('msg').classList.toggle('err', !!bad); }
  async function api(path, options) {
    const res = await fetch(path, { ...options, headers: { Authorization: 'Bearer ' + token, ...(options && options.body ? { 'Content-Type': 'application/json' } : {}) } });
    if (res.status === 401) { signOut('Review token rejected.'); throw new Error('unauthorized'); }
    if (!res.ok) { let m = 'Request failed (' + res.status + ')'; try { m = (await res.json()).error || m; } catch {} throw new Error(m); }
    return res;
  }
  function signOut(text) {
    token = null; store.set(null); episodes = []; current = null;
    $('workspace').hidden = true; $('gate').hidden = false; $('signout').hidden = true; $('live').classList.remove('live');
    message(text || 'Enter the review token.', !!text);
  }

  async function loadList(selectId) {
    const res = await api('/v1/episodes');
    episodes = await res.json();
    $('gate').hidden = true; $('workspace').hidden = false; $('signout').hidden = false; $('live').classList.add('live');
    const exportable = episodes.filter((e) => e.exportable).length;
    $('count').textContent = episodes.length + ' episodes';
    $('epcount').textContent = exportable + ' exportable';
    message('Loaded ' + new Date().toLocaleTimeString([], { hour12: false }));
    renderList();
    const target = selectId || (current && current.id) || (episodes[0] && episodes[0].episode_id);
    if (target) await openEpisode(target, current && current.id === target ? stepIndex : 0);
  }

  function renderList() {
    const list = $('episodes');
    list.replaceChildren();
    if (!episodes.length) { list.append(el('li', 'none', 'No recorded episodes yet.')); return; }
    for (const ep of episodes) {
      const li = el('li'), b = el('button');
      b.type = 'button';
      b.setAttribute('aria-current', String(!!current && current.id === ep.episode_id));
      b.append(el('div', 'ep-title', ep.instruction || '(no task given)'));
      const meta = el('div', 'ep-meta');
      meta.append(el('span', '', ep.steps + ' steps'));
      meta.append(el('span', ep.outcome === 'success' ? 'ok' : ep.outcome === 'failed' ? 'bad' : '', ep.outcome ? ep.outcome + (ep.reported_by ? ' · ' + ep.reported_by : '') : 'open'));
      meta.append(el('span', '', ep.reviewed + '/' + ep.steps + ' reviewed'));
      if (ep.exportable) meta.append(el('span', 'ok', '● export'));
      b.append(meta);
      b.addEventListener('click', () => openEpisode(ep.episode_id, 0));
      li.append(b); list.append(li);
    }
  }

  async function openEpisode(id, index) {
    const data = await (await api('/v1/episodes/' + id)).json();
    current = { id, ...data };
    stepIndex = Math.min(Math.max(index, 0), Math.max(data.steps.length - 1, 0));
    renderList();
    $('progtitle').textContent = String(data.meta.instruction || '(no task given)');
    $('seqtitle').textContent = String(data.meta.group || 'Steps');
    $('outcomebar').hidden = false;
    $('outcome').textContent = data.outcome ? data.outcome.outcome + (data.outcome.reported_by ? ' (' + data.outcome.reported_by + ')' : '') : 'no outcome';
    renderStep();
  }

  // Each renderStep bumps this; a slower, superseded render must not touch the DOM.
  let renderGen = 0;

  async function imageInto(holder, name, gen) {
    if (!name) { holder.replaceChildren(el('div', 'missing', 'no frame')); return null; }
    const res = await api('/v1/episodes/' + current.id + '/images/' + name);
    const url = URL.createObjectURL(await res.blob());
    if (gen !== renderGen) { URL.revokeObjectURL(url); return null; }
    urls.push(url);
    const img = el('img'); img.src = url; img.alt = name;
    holder.replaceChildren(img);
    return img;
  }

  function describe(a) {
    if (!a || typeof a !== 'object') return 'unknown action';
    if (a.type === 'tap') return 'tap  x=' + a.x.toFixed(3) + '  y=' + a.y.toFixed(3);
    if (a.type === 'scroll') return 'scroll  x=' + a.x.toFixed(3) + '  y=' + a.y.toFixed(3) + '  dy=' + a.dy;
    if (a.type === 'type') return 'type  "' + a.text + '"';
    if (a.type === 'wait') return 'wait  ' + a.seconds + 's';
    return String(a.type);
  }

  function mark(holder, img, a) {
    if (!a || !img) return;
    const add = (cls, style, text) => { const m = el('div', 'mark ' + cls, text); Object.assign(m.style, style || {}); holder.append(m); };
    if (a.type === 'tap') add('tap', { left: a.x * 100 + '%', top: a.y * 100 + '%' });
    else if (a.type === 'scroll') {
      const h = img.naturalHeight || 1000, len = Math.min(0.45, Math.max(0.06, Math.abs(a.dy) / h));
      const up = a.dy < 0, top = up ? a.y - len : a.y;
      add('scroll ' + (up ? 'up' : 'down'), { left: a.x * 100 + '%', top: Math.max(0, top) * 100 + '%', height: len * 100 + '%' });
    } else if (a.type === 'type') add('caption', {}, 'type: ' + a.text);
    else add('caption', {}, a.type);
  }

  async function renderStep() {
    const gen = ++renderGen;
    for (const u of urls) URL.revokeObjectURL(u);
    urls = [];
    const steps = current ? current.steps : [];
    const clips = $('clips');
    clips.replaceChildren();
    steps.forEach((s, i) => {
      const b = el('button', '', String(s.step).padStart(2, '0'));
      b.type = 'button'; b.dataset.label = s.label; b.title = s.label + ' · ' + describe(s.action);
      b.setAttribute('aria-current', String(i === stepIndex));
      b.addEventListener('click', () => { stepIndex = i; renderStep(); });
      clips.append(b);
    });
    $('pos').textContent = String(steps.length ? stepIndex + 1 : 0).padStart(2, '0') + ' / ' + String(steps.length).padStart(2, '0');
    const step = steps[stepIndex];
    for (const btn of document.querySelectorAll('.labels button')) { btn.disabled = !step; btn.setAttribute('aria-pressed', String(!!step && btn.dataset.label === step.label)); }
    if (!step) {
      $('before').replaceChildren(); $('after').replaceChildren();
      $('action').textContent = current ? 'This episode has no steps.' : 'Select an episode.';
      $('note').textContent = ''; $('status').textContent = '';
      return;
    }
    $('action').textContent = 'step ' + step.step + ' · ' + describe(step.action);
    $('note').textContent = step.note || 'no agent note';
    $('note').classList.toggle('empty', !step.note);
    $('status').textContent = step.status + (step.error ? ' · ' + step.error : '') + ' · label ' + step.label;
    $('status').classList.toggle('bad', step.status !== 'complete');
    try {
      const [img] = await Promise.all([imageInto($('before'), step.before_image, gen), imageInto($('after'), step.after_image, gen)]);
      if (img && gen === renderGen) { if (img.complete) mark($('before'), img, step.action); else img.addEventListener('load', () => mark($('before'), img, step.action), { once: true }); }
    } catch (e) { if (e.message !== 'unauthorized') message(e.message, true); }
  }

  async function label(value) {
    const step = current && current.steps[stepIndex];
    if (!step) return;
    try {
      await api('/v1/episodes/' + current.id + '/steps/' + step.step + '/label', { method: 'POST', body: JSON.stringify({ label: value }) });
      message('Step ' + step.step + ' marked ' + value);
      const next = Math.min(stepIndex + 1, current.steps.length - 1);
      await loadList(current.id);
      stepIndex = next; renderStep();
    } catch (e) { if (e.message !== 'unauthorized') message(e.message, true); }
  }

  async function setOutcome(value) {
    if (!current) return;
    try {
      await api('/v1/episodes/' + current.id + '/outcome', { method: 'POST', body: JSON.stringify({ outcome: value }) });
      message('Episode marked ' + value);
      await loadList(current.id);
    } catch (e) { if (e.message !== 'unauthorized') message(e.message, true); }
  }

  $('tokenform').addEventListener('submit', (ev) => {
    ev.preventDefault();
    const value = $('token').value.trim();
    if (value.length < 24) { message('The review token is at least 24 characters.', true); return; }
    token = value; store.set(value); $('token').value = '';
    loadList().catch((e) => { if (e.message !== 'unauthorized') message('Could not reach the gateway: ' + e.message, true); });
  });
  $('signout').addEventListener('click', () => signOut());
  for (const b of document.querySelectorAll('.labels button')) b.addEventListener('click', () => label(b.dataset.label));
  for (const b of document.querySelectorAll('[data-outcome]')) b.addEventListener('click', () => setOutcome(b.dataset.outcome));
  document.addEventListener('keydown', (ev) => {
    if (!current || ev.target instanceof HTMLInputElement || ev.metaKey || ev.ctrlKey || ev.altKey) return;
    const k = ev.key.toLowerCase();
    if (k === 'c') label('correct');
    else if (k === 'm') label('mistake');
    else if (k === 'r') label('recovery');
    else if (k === 'arrowright' && stepIndex < current.steps.length - 1) { stepIndex++; renderStep(); }
    else if (k === 'arrowleft' && stepIndex > 0) { stepIndex--; renderStep(); }
    else return;
    ev.preventDefault();
  });

  if (token) loadList().catch((e) => { if (e.message !== 'unauthorized') message('Could not reach the gateway: ' + e.message, true); });
})();
`;

export function reviewPage(): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Episode review · Phone Use</title>
${FONT_LINKS}
<style>${THEME_CSS}${PAGE_CSS}</style></head><body>
${PAGE_HTML}
<script>${PAGE_JS}</script></body></html>`;
}
