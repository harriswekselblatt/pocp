#!/usr/bin/env node
// Turn the demo's asciicast into an animated SVG that loops (SMIL; GitHub plays it in a README):
//   node examples/demo/demo.mjs --cast /tmp/demo.cast
//   node examples/demo/render-svg.mjs /tmp/demo.cast docs/demo.svg
// Lines appear when the demo printed them; typed commands are revealed as they were typed.
import fs from 'node:fs';

const [castFile, outFile] = process.argv.slice(2);
if (!castFile || !outFile) {
  console.error('usage: render-svg.mjs <demo.cast> <out.svg>');
  process.exit(2);
}
const [, ...rows] = fs.readFileSync(castFile, 'utf8').trim().split('\n');
const events = rows.map((r) => JSON.parse(r));

// Rebuild the screen as lines, each with the time its first and last characters appeared.
const lines = [];
let cur = null;
for (const [t, , raw] of events) {
  const text = raw.replace(/\x1b\[[0-9;]*m/g, '').replace(/\r/g, '');
  for (const part of text.split(/(\n)/)) {
    if (part === '\n') { cur = null; continue; }
    if (!part) continue;
    for (const piece of part.split('\n')) {
      if (!cur) { cur = { text: '', start: t, end: t }; lines.push(cur); }
      cur.text += piece;
      cur.end = t;
    }
  }
}

const HOLD = 5; // seconds the finished screen stays before the loop restarts
const total = Math.max(...lines.map((l) => l.end)) + HOLD;
const FONT = 14, LH = 21, CW = 8.43, PADX = 20, TOP = 52;
const cols = Math.max(...lines.map((l) => l.text.length));
const W = Math.ceil(PADX * 2 + cols * CW), H = TOP + lines.length * LH + 18;
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const kt = (t) => Math.min(1, Math.max(0, t / total)).toFixed(4);

function color(text) {
  if (text.startsWith('# ')) return '#8b949e';
  if (/^(✗|NOT verified|\s+BAD|\s+behavior changed)/.test(text)) return '#ff7b72';
  if (/^(✓|\s+rerun passed)/.test(text)) return '#7ee787';
  if (/^\s+next:/.test(text)) return '#e3b341';
  if (/^[-]\s/.test(text)) return '#ffa198';
  if (/^[+]\s/.test(text)) return '#aff5b4';
  return '#e6edf3';
}

const body = lines.map((l, i) => {
  const y = TOP + i * LH;
  const show = `<animate attributeName="opacity" values="0;0;1;1" keyTimes="0;${kt(l.start)};${kt(l.start)};1" dur="${total}s" repeatCount="indefinite" calcMode="discrete"/>`;
  if (l.text.startsWith('$ ')) {
    // A typed command: reveal it left to right over the time it took to type.
    const full = (l.text.length * CW + 4).toFixed(1);
    const id = `c${i}`;
    return [
      `<clipPath id="${id}"><rect x="${PADX}" y="${y - LH + 5}" height="${LH}" width="0">`,
      `<animate attributeName="width" values="0;0;${full};${full}" keyTimes="0;${kt(l.start)};${kt(l.end)};1" dur="${total}s" repeatCount="indefinite"/></rect></clipPath>`,
      `<text x="${PADX}" y="${y}" clip-path="url(#${id})"><tspan fill="#7ee787" font-weight="bold">$</tspan><tspan fill="#e6edf3">${esc(l.text.slice(1))}</tspan></text>`,
    ].join('');
  }
  const italic = l.text.startsWith('# ') ? ' font-style="italic"' : '';
  return `<text x="${PADX}" y="${y}" fill="${color(l.text)}"${italic} opacity="0" xml:space="preserve">${show}${esc(l.text)}</text>`;
}).join('\n');

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="Demo: an agent breaks add(), edits the test until it passes, plain tests go green, and pocp verify reports that the old test fails on the new code">
<title>POCP demo: an edited test passes, the old test fails on the new code</title>
<rect width="${W}" height="${H}" rx="10" fill="#0d1117"/>
<circle cx="22" cy="20" r="6" fill="#ff5f57"/><circle cx="42" cy="20" r="6" fill="#febc2e"/><circle cx="62" cy="20" r="6" fill="#28c840"/>
<g font-family="ui-monospace, SFMono-Regular, Menlo, Consolas, 'Liberation Mono', monospace" font-size="${FONT}" xml:space="preserve">
${body}
</g>
</svg>
`;
fs.writeFileSync(outFile, svg);
console.log(`${outFile}: ${lines.length} lines, ${total.toFixed(1)}s loop, ${W}x${H}, ${svg.length} bytes`);
