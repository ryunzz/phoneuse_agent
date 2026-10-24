import { FONT_LINKS, PAGE_CSP, THEME_CSS } from './theme.js';

export const REVIEW_CSP = PAGE_CSP;

const PAGE_CSS = `
body { min-height: 100vh; display: flex; flex-direction: column; }
.stats { display: grid; grid-template-columns: repeat(6, minmax(0, 1fr)); border-bottom: 1px solid var(--line); background: var(--panel-000); }
.stats div { padding: 10px 16px; }
.stats div + div { border-left: 1px solid var(--line); }
.stats .k { font: 600 11px/16px var(--font-ui); letter-spacing: .08em; text-transform: uppercase; color: var(--ink-faint); }
.stats .v { font: 400 28px/1.1 var(--font-display); margin-top: 2px; }
main { flex: 1; display: grid; gap: 6px; padding: 6px; grid-template-columns: minmax(260px, 1fr) minmax(0, 2.2fr); min-height: 0; }
.panel { display: flex; flex-direction: column; min-height: 0; }
#list { overflow-y: auto; flex: 1; }
.row { display: block; width: 100%; text-align: left; border: 0; border-bottom: 1px solid var(--panel-200); border-radius: 0; padding: 10px 12px; color: var(--ink); background: transparent; }
.row:hover { background: var(--panel-200); }
.row[aria-current="true"] { background: var(--panel-300); box-shadow: inset 2px 0 0 var(--playhead); }
.row .t { font-weight: 600; }
.row .m { font: 400 11px/16px var(--font-mono); color: var(--ink-faint); margin-top: 2px; display: flex; gap: 8px; flex-wrap: wrap; }
.pill { font: 600 10px/14px var(--font-ui); letter-spacing: .08em; text-transform: uppercase; padding: 1px 6px; border-radius: var(--radius-sm); border: 1px solid var(--line); color: var(--ink-muted); }
.pill.pending_review { color: var(--gold); border-color: var(--gold); }
.pill.approved { color: var(--clip-audio); border-color: var(--clip-audio); }
.pill.rejected { color: var(--rec); border-color: var(--rec); }
.pill.out-failed, .pill.out-blocked { color: var(--clip-text); border-color: var(--clip-text); }
#detail { padding: 12px; overflow-y: auto; flex: 1; display: grid; grid-template-columns: minmax(0, 340px) minmax(0, 1fr); gap: 16px; align-content: start; }
video { width: 100%; max-height: 72vh; background: #000; border: 1px solid var(--line); border-radius: var(--radius-md); }
h2 { font: 400 28px/1.1 var(--font-display); margin: 0 0 6px; }
h3 { font: 600 11px/16px var(--font-ui); letter-spacing: .08em; text-transform: uppercase; color: var(--ink-faint); margin: 16px 0 6px; }
dl { display: grid; grid-template-columns: max-content minmax(0, 1fr); gap: 4px 12px; margin: 0; }
dt { color: var(--ink-faint); }
dd { margin: 0; font-family: var(--font-mono); font-size: 12px; overflow-wrap: anywhere; }
ol { margin: 0; padding-left: 18px; color: var(--ink-muted); }
p { margin: 0 0 6px; color: var(--ink-muted); }
.note { white-space: pre-wrap; color: var(--ink); background: var(--panel-000); border: 1px solid var(--line); border-radius: var(--radius-sm); padding: 8px; }
textarea { width: 100%; min-height: 64px; font: 400 12px/16px var(--font-mono); color: var(--ink); background: var(--panel-000); border: 1px solid var(--line); border-radius: var(--radius-sm); padding: 8px; resize: vertical; }
.actions { display: flex; gap: 8px; margin-top: 8px; }
button.reject { color: var(--rec); border-color: var(--rec); }
button.approve { color: var(--clip-audio); border-color: var(--clip-audio); }
#msg { font: 400 12px/16px var(--font-mono); color: var(--ink-muted); }
#msg.err { color: var(--rec); }
.empty { padding: 16px; color: var(--ink-faint); font-family: var(--font-mono); font-size: 12px; }
@media (max-width: 900px) { main, #detail { grid-template-columns: 1fr; } .stats { grid-template-columns: repeat(3, 1fr); } }
`;

const PAGE_HTML = `
<header class="menubar"><a class="wordmark" href="/review">Phone Use <em>review</em></a><div class="meta"><span id="msg">Loading…</span><span class="dot live" id="live"></span></div></header>
<section class="stats" aria-label="Totals">
  <div><div class="k">Submissions</div><div class="v" id="s-total">0</div></div>
  <div><div class="k">Pending</div><div class="v" id="s-pending">0</div></div>
  <div><div class="k">Approved</div><div class="v" id="s-approved">0</div></div>
  <div><div class="k">Rejected</div><div class="v" id="s-rejected">0</div></div>
  <div><div class="k">Review rate</div><div class="v" id="s-rate">0%</div></div>
  <div><div class="k">Failed / blocked</div><div class="v" id="s-fb">0 / 0</div></div>
</section>
<main>
  <section class="panel"><div class="cap"><span>Queue</span><b id="count"></b></div><div id="list"></div></section>
  <section class="panel"><div class="cap"><span>Submission</span><b id="sel-id"></b></div><div id="detail"><div class="empty">Select a submission.</div></div></section>
</main>
<footer class="footer"><span>Video demonstrations, not action traces</span><span>Mac only · payments not enabled</span></footer>`;

const PAGE_JS = `
(() => {
  const $ = (id) => document.getElementById(id);
  let data = { submissions: [], tasks: [], stats: {} };
  let selected = null;

  function el(tag, attrs, children) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (k === 'text') node.textContent = v; else node.setAttribute(k, v);
    }
    for (const child of children || []) if (child) node.append(child);
    return node;
  }
  function status(text, err) { $('msg').textContent = text; $('msg').className = err ? 'err' : ''; }
  function when(iso) { return iso ? new Date(iso).toLocaleString() : '—'; }
  const STATE = { pending_review: 'Pending', approved: 'Approved', rejected: 'Rejected' };

  function renderStats() {
    const s = data.stats;
    $('s-total').textContent = s.total || 0;
    $('s-pending').textContent = s.pending || 0;
    $('s-approved').textContent = s.approved || 0;
    $('s-rejected').textContent = s.rejected || 0;
    $('s-rate').textContent = Math.round((s.reviewRate || 0) * 100) + '%';
    $('s-fb').textContent = (s.reportedFailed || 0) + ' / ' + (s.reportedBlocked || 0);
  }

  function renderList() {
    const list = $('list');
    list.replaceChildren();
    $('count').textContent = String(data.submissions.length);
    if (!data.submissions.length) { list.append(el('div', { class: 'empty', text: 'No completed submissions yet.' })); return; }
    for (const sub of data.submissions) {
      const row = el('button', { class: 'row', type: 'button', 'aria-current': String(sub.id === selected) }, [
        el('div', { class: 't', text: sub.taskTitle }),
        el('div', { class: 'm' }, [
          el('span', { class: 'pill ' + sub.state, text: STATE[sub.state] || sub.state }),
          el('span', { class: 'pill out-' + sub.outcome, text: 'reported ' + sub.outcome }),
          el('span', { text: sub.contributorName }),
          el('span', { text: when(sub.completedAt) }),
        ]),
      ]);
      row.addEventListener('click', () => { selected = sub.id; renderList(); renderDetail(true); });
      list.append(row);
    }
  }

  function renderDetail(reloadVideo) {
    const sub = data.submissions.find((item) => item.id === selected);
    const detail = $('detail');
    $('sel-id').textContent = sub ? sub.id : '';
    if (!sub) { detail.replaceChildren(el('div', { class: 'empty', text: 'Select a submission.' })); return; }
    const existing = detail.querySelector('video');
    const video = reloadVideo || !existing || existing.dataset.id !== sub.id
      ? el('video', { controls: '', preload: 'metadata', playsinline: '', src: '/admin/v1/submissions/' + sub.id + '/media' })
      : existing;
    video.dataset.id = sub.id;
    const task = data.tasks.find((item) => item.id === sub.taskId);
    const reason = el('textarea', { id: 'reason', placeholder: 'Feedback for the contributor (required to reject)' });
    const approve = el('button', { class: 'approve', type: 'button', text: 'Approve' });
    const reject = el('button', { class: 'reject', type: 'button', text: 'Reject' });
    approve.addEventListener('click', () => decide(sub.id, 'approved', reason.value));
    reject.addEventListener('click', () => decide(sub.id, 'rejected', reason.value));
    const history = sub.reviews.length
      ? el('ol', {}, sub.reviews.map((r) => el('li', { text: when(r.at) + ' — ' + r.decision + (r.reason ? ': ' + r.reason : '') })))
      : el('p', { text: 'Not reviewed yet.' });
    const info = el('div', {}, [
      el('h2', { text: sub.taskTitle }),
      el('div', { class: 'm' }, [el('span', { class: 'pill ' + sub.state, text: STATE[sub.state] || sub.state }), document.createTextNode(' '), el('span', { class: 'pill out-' + sub.outcome, text: 'reported ' + sub.outcome })]),
      el('h3', { text: 'Contributor note' }),
      sub.note ? el('div', { class: 'note', text: sub.note }) : el('p', { text: 'No note.' }),
      el('h3', { text: 'Decision' }),
      reason,
      el('div', { class: 'actions' }, [approve, reject]),
      el('h3', { text: 'Review history' }),
      history,
      el('h3', { text: 'Task v' + sub.taskVersion }),
      task ? el('div', {}, [
        el('p', { text: task.summary }),
        el('p', { text: 'Start: ' + task.startingConditions }),
        el('ol', {}, task.steps.map((step) => el('li', { text: step }))),
        el('p', { text: 'Evidence: ' + task.evidence }),
      ]) : el('p', { text: 'Task no longer in the catalog.' }),
      el('h3', { text: 'Recording' }),
      el('dl', {}, [
        el('dt', { text: 'Contributor' }), el('dd', { text: sub.contributorName }),
        el('dt', { text: 'Device' }), el('dd', { text: sub.device.model + ' · iOS ' + sub.device.systemVersion + ' · ' + sub.device.locale }),
        el('dt', { text: 'Duration' }), el('dd', { text: sub.durationSeconds.toFixed(1) + ' s (reported)' }),
        el('dt', { text: 'File' }), el('dd', { text: sub.media.contentType + ' · ' + (sub.media.bytes / 1e6).toFixed(1) + ' MB' }),
        el('dt', { text: 'SHA-256' }), el('dd', { text: sub.media.sha256 }),
        el('dt', { text: 'Source' }), el('dd', { text: sub.recordingSource }),
        el('dt', { text: 'Consent' }), el('dd', { text: sub.consent.version + ' at ' + when(sub.consent.at) }),
        el('dt', { text: 'Attempt' }), el('dd', { text: sub.attemptId }),
        el('dt', { text: 'Submitted' }), el('dd', { text: when(sub.completedAt) }),
      ]),
    ]);
    detail.replaceChildren(video, info);
  }

  async function decide(id, decision, reason) {
    if (decision === 'rejected' && !reason.trim()) { status('A rejection needs a reason.', true); $('reason').focus(); return; }
    status('Saving…', false);
    try {
      const res = await fetch('/admin/v1/submissions/' + id + '/review', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ decision, reason: reason.trim() }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || res.statusText);
      status('Saved: ' + decision + '.', false);
      await load(false);
    } catch (error) { status(error.message, true); }
  }

  async function load(initial) {
    try {
      const res = await fetch('/admin/v1/submissions');
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || res.statusText);
      const before = JSON.stringify(data.submissions.find((s) => s.id === selected) || null);
      data = body;
      if (!selected && data.submissions.length) selected = (data.submissions.find((s) => s.state === 'pending_review') || data.submissions[0]).id;
      renderStats();
      renderList();
      const after = JSON.stringify(data.submissions.find((s) => s.id === selected) || null);
      if (initial || before !== after) {
        const typing = document.activeElement && document.activeElement.id === 'reason';
        if (!typing) renderDetail(false);
      }
      if (initial) status('Up to date.', false);
      $('live').className = 'dot live';
    } catch (error) { status(error.message, true); $('live').className = 'dot'; }
  }

  load(true);
  setInterval(() => load(false), 4000);
})();
`;

export function reviewPage(): string {
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Phone Use review</title>
${FONT_LINKS}
<style>${THEME_CSS}${PAGE_CSS}</style>
</head><body>${PAGE_HTML}<script>${PAGE_JS}</script></body></html>`;
}
