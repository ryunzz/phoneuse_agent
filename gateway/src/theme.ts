/**
 * Shared look for gateway pages, taken from ryunzz.tech: a dark video-editor shell
 * (panels, uppercase captions, timecodes) with Geist, Geist Mono and Instrument Serif.
 */

export const FONT_LINKS = `<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Geist:wght@400;500;600;700&family=Geist+Mono:wght@400;500&family=Instrument+Serif:ital@0;1&display=swap">`;

/** CSP for pages that use THEME_CSS; scripts stay inline-only. */
export const PAGE_CSP = [
  "default-src 'self'",
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline' https://fonts.googleapis.com",
  "font-src https://fonts.gstatic.com",
  "img-src 'self' data:",
  "connect-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ');

export const THEME_CSS = `
:root {
  --black: #070708; --panel-000: #0f0f11; --panel-100: #17171a; --panel-200: #1f1f23; --panel-300: #2a2a2f;
  --line: #34343b; --line-strong: #6b6b74;
  --ink: #ecebe8; --ink-muted: #a3a19c; --ink-faint: #8c8a85;
  --playhead: #00e5ff; --on-playhead: #140806; --rec: #ff4d4d;
  --clip-video: #6a9be0; --clip-image: #57bcbc; --clip-text: #c784d6; --clip-fx: #e0b451; --clip-audio: #58b787;
  --gold: #e9c25c;
  --radius-sm: 2px; --radius-md: 4px;
  --font-display: "Instrument Serif", "Times New Roman", serif;
  --font-ui: Geist, "Helvetica Neue", Arial, sans-serif;
  --font-mono: "Geist Mono", ui-monospace, Menlo, monospace;
  color-scheme: dark;
}
* { box-sizing: border-box; }
html, body { margin: 0; background: var(--black); color: var(--ink); font: 400 13px/18px var(--font-ui); -webkit-font-smoothing: antialiased; }
.menubar { height: 36px; display: flex; align-items: center; justify-content: space-between; padding: 0 16px; border-bottom: 1px solid var(--line); background: var(--panel-000); }
.wordmark { font: 400 21px/1 var(--font-display); letter-spacing: -0.01em; color: var(--ink); text-decoration: none; }
.wordmark em { font-style: italic; color: var(--ink-muted); }
.menubar .meta { font: 400 12px/16px var(--font-mono); color: var(--ink-muted); display: flex; gap: 16px; align-items: center; }
.panel { background: var(--panel-100); border: 1px solid var(--line); border-radius: var(--radius-md); min-width: 0; }
.cap { height: 28px; display: flex; align-items: center; justify-content: space-between; padding: 0 12px; border-bottom: 1px solid var(--line); font: 600 11px/16px var(--font-ui); letter-spacing: .08em; text-transform: uppercase; color: var(--ink-faint); }
.cap b { color: var(--ink); font-weight: 600; }
.mono { font-family: var(--font-mono); }
.timecode { font: 500 14px/20px var(--font-mono); letter-spacing: .02em; color: var(--playhead); }
.dot { width: 7px; height: 7px; border-radius: 50%; background: var(--ink-faint); display: inline-block; }
.dot.live { background: var(--rec); box-shadow: 0 0 8px var(--rec); animation: blink 1.6s steps(2, start) infinite; }
@keyframes blink { 50% { opacity: .35; } }
button, .btn { font: 500 12px/16px var(--font-ui); color: var(--playhead); background: transparent; border: 1px solid var(--playhead); border-radius: var(--radius-md); padding: 6px 12px; cursor: pointer; }
button:hover, .btn:hover { background: color-mix(in srgb, var(--playhead) 12%, transparent); }
button:focus-visible, input:focus-visible { outline: 2px solid var(--playhead); outline-offset: 2px; }
input { font: 400 12px/16px var(--font-mono); color: var(--ink); background: var(--panel-000); border: 1px solid var(--line); border-radius: var(--radius-sm); padding: 7px 10px; }
input::placeholder { color: var(--ink-faint); }
.footer { height: 28px; display: flex; align-items: center; justify-content: space-between; padding: 0 16px; border-top: 1px solid var(--line); font: 400 12px/16px var(--font-mono); color: var(--ink-faint); }
@media (prefers-reduced-motion: reduce) { .dot.live { animation: none; } }
`;
