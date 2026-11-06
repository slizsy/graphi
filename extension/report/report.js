// Graphi session report: summary, speed and rhythm charts, pauses and a
// keystroke-accurate replay of one typing session.

import { loadReports, saveReports, loadStats, KEYS } from '../shared/storage.js';
import { formatNumber } from '../shared/format.js';

const $ = (s) => document.querySelector(s);
const SVG = 'http://www.w3.org/2000/svg';
const BS = '\b';
const OUTCOME = {
  done: ['Completed', '#D6FF3D'],
  stopped: ['Stopped', '#FFB547'],
  error: ['Interrupted', '#FF5D6C'],
};
const PAUSE_KIND = {
  thinking: ['Thinking break', '#8B6CFF'],
  break: ['Scheduled break', '#5AC8FA'],
  hold: ['Paused by you', '#FFB547'],
  background: ['Tab in background', '#6D707B'],
  rhythm: ['Long gap', '#A7AAB4'],
};

let reports = [];
let current = null;
let model = null;
const wanted = new URLSearchParams(location.search).get('id');
let seenWanted = false;

// ---- Formatting ------------------------------------------------------------------

const clock = (ms) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s >= 3600) return `${Math.floor(s / 3600)}:${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};
const human = (ms) => {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
};
const secs = (ms) => (ms >= 10000 ? `${Math.round(ms / 1000)}s` : `${(ms / 1000).toFixed(1)}s`);
const dateFmt = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });
const shortDate = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

function el(tag, attrs = {}, ...kids) {
  const node = tag.startsWith('svg:') ? document.createElementNS(SVG, tag.slice(4)) : document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') node.setAttribute('class', v);
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v);
  }
  for (const c of kids.flat()) if (c != null && c !== false) node.append(c instanceof Node ? c : String(c));
  return node;
}

function toast(msg, action) {
  const t = $('#toast');
  t.replaceChildren(msg);
  if (action) {
    t.append(' ', el('button', { class: 'btn', style: 'height:26px;margin-left:10px', onclick: () => { t.hidden = true; action.run(); } }, action.label));
  }
  t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { t.hidden = true; }, action ? 6000 : 2600);
}

// ---- Analysis ----------------------------------------------------------------------

export function analyze(rep) {
  const keys = Array.from(rep.keys);
  const n = keys.length;
  const typos = new Set(rep.typos || []);
  const t = new Array(n);
  let acc = 0;
  for (let i = 0; i < n; i++) { acc += rep.dts[i] || 0; t[i] = acc; }
  const span = Math.max(1, t[n - 1] || 0);
  const isCommit = (i) => keys[i] !== BS && !typos.has(i);
  let commits = 0;
  let backspaces = 0;
  for (let i = 0; i < n; i++) {
    if (keys[i] === BS) backspaces += 1;
    else if (!typos.has(i)) commits += 1;
  }
  const activeMs = Math.max(rep.activeMs || 0, span);
  const avgWpm = commits ? Math.round((commits / 5) / (activeMs / 60000)) : 0;

  // Rolling 10 s speed, sampled at ~160 points.
  const WINDOW = 10000;
  const step = Math.max(500, span / 160);
  const series = [];
  let lo = 0;
  let hi = 0;
  let inWin = 0;
  for (let T = 0; T <= span + 1; T += step) {
    while (hi < n && t[hi] <= T) { if (isCommit(hi)) inWin += 1; hi += 1; }
    while (lo < hi && t[lo] < T - WINDOW) { if (isCommit(lo)) inWin -= 1; lo += 1; }
    const win = Math.min(WINDOW, Math.max(T, 1));
    series.push({ t: T, wpm: T < 2000 ? null : Math.round((inWin / 5) / (win / 60000)) });
  }
  const full = series.filter((p) => p.wpm != null && p.t >= Math.min(WINDOW, span * 0.5));
  const peakWpm = full.length ? Math.max(...full.map((p) => p.wpm)) : avgWpm;

  // Key-to-key gaps.
  const EDGES = [0, 50, 100, 150, 200, 300, 500, 1000, 2000, Infinity];
  const LABELS = ['<50', '50–100', '100–150', '150–200', '200–300', '300–500', '0.5–1s', '1–2s', '>2s'];
  const hist = LABELS.map((label, i) => ({ label, lo: EDGES[i], hi: EDGES[i + 1], count: 0 }));
  const gaps = [];
  for (let i = 1; i < n; i++) {
    const g = rep.dts[i] || 0;
    gaps.push(g);
    hist[EDGES.findIndex((e, j) => g >= e && g < EDGES[j + 1])].count += 1;
  }
  gaps.sort((a, b) => a - b);
  const median = gaps.length ? gaps[Math.floor(gaps.length / 2)] : 0;

  // Pauses: long gaps in the key stream plus holds (which sit outside it).
  const thinkingAt = new Set((rep.pauses || []).filter((p) => p[2] === 'thinking').map((p) => p[0]));
  const pauses = [];
  for (let i = 1; i < n; i++) {
    if (rep.dts[i] >= 2000) pauses.push({ index: i, ms: rep.dts[i], kind: thinkingAt.has(i) ? 'thinking' : 'rhythm', at: t[i - 1] });
  }
  for (const [index, ms, kind] of rep.pauses || []) {
    if (kind === 'hold' || kind === 'background' || kind === 'break') pauses.push({ index, ms, kind, at: index > 0 ? t[Math.min(index, n) - 1] : 0 });
  }
  pauses.sort((a, b) => a.index - b.index || a.at - b.at);

  // Per paragraph: commits split on newlines; corrections are the backspaces
  // made while that paragraph was being typed.
  const paragraphs = [];
  let para = null;
  for (let i = 0; i < n; i++) {
    const k = keys[i];
    if (k === BS) { if (para) para.corrections += 1; continue; }
    if (typos.has(i)) continue;
    if (k === '\n') { if (para) { paragraphs.push(para); para = null; } continue; }
    if (!para) para = { start: i > 0 ? t[i - 1] : 0, end: t[i], chars: 0, corrections: 0, preview: '' };
    para.chars += 1;
    para.end = t[i];
    if (para.preview.length < 70) para.preview += k;
  }
  if (para) paragraphs.push(para);
  for (const p of paragraphs) {
    p.ms = Math.max(1, p.end - p.start);
    p.wpm = Math.round((p.chars / 5) / (p.ms / 60000));
  }

  // Minute by minute, on the typing clock.
  const minutes = [];
  for (let i = 0; i < n; i++) {
    const mi = Math.floor(t[i] / 60000);
    while (minutes.length <= mi) minutes.push({ chars: 0, corrections: 0, pauses: 0, typos: 0 });
    const b = minutes[mi];
    if (keys[i] === BS) b.corrections += 1;
    else if (typos.has(i)) b.typos += 1;
    else b.chars += 1;
    if (i > 0 && rep.dts[i] >= 2000) b.pauses += 1;
  }
  minutes.forEach((b, i) => {
    const len = i === minutes.length - 1 ? Math.max(1000, span - i * 60000) : 60000;
    b.wpm = Math.round((b.chars / 5) / (len / 60000));
    b.partial = len < 60000;
  });

  const typed = keys.length - backspaces;
  return {
    keys, t, n, span, typos, commits, backspaces, activeMs, avgWpm, peakWpm, series, hist, median, pauses, paragraphs, minutes,
    breakMs: rep.breakMs || 0,
    mistakes: typos.size,
    accuracy: typed ? commits / typed : 1,
    chars: Math.max(0, rep.endOffset - rep.startOffset),
  };
}

// ---- Sidebar ------------------------------------------------------------------------

async function renderLifetime() {
  const s = await loadStats();
  $('#lifeSessions').textContent = formatNumber(s.sessions);
  $('#lifeChars').textContent = formatNumber(s.chars);
  $('#lifeTime').textContent = human(s.activeMs);
  $('#lifeWpm').textContent = s.activeMs > 5000 ? String(Math.round((s.chars / 5) / (s.activeMs / 60000))) : '—';
}

function renderList() {
  const list = $('#list');
  list.replaceChildren(...reports.map((r) => {
    const [label, tone] = OUTCOME[r.outcome] || OUTCOME.stopped;
    const chars = Math.max(0, r.endOffset - r.startOffset);
    const wpm = r.activeMs ? Math.round((chars / 5) / (r.activeMs / 60000)) : 0;
    return el('li', {}, el('button', {
      class: 'item', 'aria-current': String(r.id === current?.id), style: `--tone:${tone}`,
      onclick: () => select(r.id, true),
    },
    el('span', { class: 'item-title' }, r.title || 'Untitled'),
    el('span', { class: 'item-wpm' }, `${wpm} wpm`),
    el('span', { class: 'item-sub' }, el('i', { title: label }), `${shortDate.format(r.startedAt || r.endedAt)} · ${r.host || 'page'}`)));
  }));
  $('#listCount').textContent = reports.length ? String(reports.length) : '';
}

// ---- Report ---------------------------------------------------------------------------

function select(id, push = false) {
  const rep = reports.find((r) => r.id === id) || reports[0];
  $('#empty').hidden = !!rep;
  $('#report').hidden = !rep;
  replay.stop();
  if (!rep) { current = null; renderList(); return; }
  current = rep;
  if (rep.id === wanted) seenWanted = true;
  model = analyze(rep);
  if (push) history.replaceState(null, '', `?id=${encodeURIComponent(rep.id)}`);
  renderList();
  renderHead(rep, model);
  renderTiles(rep, model);
  replay.load(rep, model);
  drawCharts();
  renderPauses(model);
  renderTables(rep, model);
  document.title = `${rep.title || 'Untitled'} — Graphi report`;
}

function renderHead(rep, m) {
  $('#rTitle').textContent = rep.title || 'Untitled';
  $('#rDate').textContent = dateFmt.format(rep.startedAt || rep.endedAt);
  $('#rHost').textContent = rep.host || 'page';
  const [label, tone] = OUTCOME[rep.outcome] || OUTCOME.stopped;
  const chip = $('#rOutcome');
  chip.style.setProperty('--tone', tone);
  chip.querySelector('span').textContent = rep.outcome === 'done' ? label : `${label} at ${Math.floor((rep.endOffset / rep.total) * 100)}%`;
  $('#rTarget').textContent = rep.target ? `into ${rep.target}` : '';
  const s = rep.settings || {};
  $('#rPace').textContent = s.paceMode === 'duration' ? `Finish in ${s.targetMinutes} min` : s.wpm ? `Set to ${s.wpm} wpm` : '';
  void m;
}

function tile(label, value, unit, sub, hero = false) {
  return el('div', { class: `tile${hero ? ' hero' : ''}` },
    el('div', { class: 'tile-label' }, label),
    el('div', { class: 'tile-value' }, value, unit ? el('small', {}, unit) : null),
    sub ? el('div', { class: 'tile-sub' }, sub) : null);
}

function renderTiles(rep, m) {
  const s = rep.settings || {};
  let timeSub = `${human(rep.endedAt - rep.startedAt)} wall-clock`;
  if (s.paceMode === 'duration' && rep.outcome === 'done') {
    const diff = m.activeMs - s.targetMinutes * 60000;
    timeSub = `Target ${s.targetMinutes} min · ${diff >= 0 ? '+' : '−'}${human(Math.abs(diff))}`;
  }
  const resumed = rep.startOffset > 0 ? ` · resumed at ${Math.floor((rep.startOffset / rep.total) * 100)}%` : '';
  $('#tiles').replaceChildren(
    tile('Average speed', String(m.avgWpm), 'wpm', `Peak ${m.peakWpm} wpm`, true),
    tile('Typing time', human(m.activeMs), '', timeSub),
    tile('Characters', formatNumber(m.chars), '', `of ${formatNumber(rep.total)}${resumed}`),
    tile('Keystrokes', formatNumber(m.n), '', `median gap ${m.median} ms`),
    tile('Corrections', formatNumber(m.backspaces), '', `${m.mistakes} slip${m.mistakes === 1 ? '' : 's'} · ${(m.accuracy * 100).toFixed(1)}% accurate`),
    tile('Long pauses', String(m.pauses.length), '', m.pauses.length ? `longest ${secs(Math.max(...m.pauses.map((p) => p.ms)))}` : 'none over 2s'),
  );
}

function renderPauses(m) {
  const box = $('#pauses');
  if (!m.pauses.length) {
    box.replaceChildren(el('span', { class: 'dim', style: 'font-size:13px' }, 'No pauses longer than two seconds.'));
    return;
  }
  box.replaceChildren(...m.pauses.slice(0, 80).map((p) => {
    const [label, tone] = PAUSE_KIND[p.kind] || PAUSE_KIND.rhythm;
    return el('button', { class: 'pause', style: `--tone:${tone}`, title: `Jump the replay to ${clock(p.at)}`, onclick: () => { replay.seek(p.at); document.querySelector('.replay-card').scrollIntoView({ behavior: 'smooth', block: 'center' }); } },
      el('i'), el('b', {}, secs(p.ms)), label, el('span', { class: 'dim mono' }, `@ ${clock(p.at)}`));
  }));
}

function table(head, rows) {
  const thead = el('thead', {}, el('tr', {}, head.map(([label, cls]) => el('th', { class: cls || null }, label))));
  const tbody = el('tbody', {}, rows.map((cells) => el('tr', {}, cells.map(([v, cls]) => el('td', { class: cls || null }, v)))));
  return [thead, tbody];
}

function meter(v, max) {
  return el('span', { class: 'meter' }, el('i', { style: `width:${max ? Math.round((v / max) * 100) : 0}%` }));
}

function renderTables(rep, m) {
  const maxP = Math.max(...m.paragraphs.map((p) => p.wpm), 1);
  $('#paraTable').replaceChildren(...table(
    [['#'], ['Starts with', 'l'], ['Chars'], ['Time'], ['Speed'], ['Fixes']],
    m.paragraphs.map((p, i) => [
      [String(i + 1), 'num'],
      [`${p.preview.trim()}${p.chars > p.preview.length ? '…' : ''}`, 'l'],
      [formatNumber(p.chars), 'num'],
      [human(p.ms), 'num'],
      [[`${p.wpm} wpm`, meter(p.wpm, maxP)], 'num'],
      [String(p.corrections), 'num'],
    ]),
  ));
  const maxM = Math.max(...m.minutes.map((b) => b.wpm), 1);
  $('#minuteTable').replaceChildren(...table(
    [['Minute'], ['Chars'], ['Speed'], ['Fixes'], ['Pauses']],
    m.minutes.map((b, i) => [
      [`${i + 1}${b.partial ? '*' : ''}`, 'num'],
      [formatNumber(b.chars), 'num'],
      [[`${b.wpm} wpm`, meter(b.wpm, maxM)], 'num'],
      [String(b.corrections), 'num'],
      [String(b.pauses), 'num'],
    ]),
  ));
  const s = rep.settings || {};
  const rows = [
    ['Pace', s.paceMode === 'duration' ? `Finish in ${s.targetMinutes} min` : `${s.wpm} wpm`],
    ['Rhythm variation', s.variability != null ? `${s.variability}%` : '—'],
    ['Typo rate', s.typoRate ? `${s.typoRate}% · ${s.correction === 'instant' ? 'fixed instantly' : 'noticed later'}` : 'Off'],
    ['Thinking breaks', s.thinkingBreaks ? s.thinkingBreaks[0].toUpperCase() + s.thinkingBreaks.slice(1) : '—'],
    ['Punctuation pauses', s.punctuationPauses ? 'On' : 'Off'],
    ['Scheduled breaks', s.breakEvery ? `${s.breakLength} min every ${s.breakEvery} min` : 'Off'],
    ['Time on breaks', m.breakMs ? human(m.breakMs) : '—'],
    ['Typed into', rep.target || '—'],
  ];
  $('#settingsList').replaceChildren(...rows.flatMap(([k, v]) => [el('dt', {}, k), el('dd', {}, v)]));
  $('#printFoot').textContent = `Typed automatically with the Graphi auto typer. Report generated ${dateFmt.format(Date.now())}.`;
}

// ---- Tooltip -------------------------------------------------------------------------------

const tip = {
  show(x, y, ...lines) {
    const t = $('#tip');
    t.replaceChildren(...lines.map((l, i) => (i ? el('div', {}, ...[].concat(l)) : el('div', { class: 'k' }, l))));
    t.hidden = false;
    const w = t.offsetWidth;
    t.style.left = `${Math.min(innerWidth - w - 8, x + 14)}px`;
    t.style.top = `${y - t.offsetHeight - 12}px`;
  },
  hide() { $('#tip').hidden = true; },
};

// ---- Charts -------------------------------------------------------------------------------

function niceMax(v) {
  if (v <= 0) return 10;
  const p = 10 ** Math.floor(Math.log10(v));
  return [1, 2, 2.5, 5, 10].map((k) => k * p).find((x) => x >= v);
}

function speedChart(box, m) {
  const W = box.clientWidth;
  const H = box.clientHeight;
  const pad = { l: 34, r: 12, t: 10, b: 24 };
  const pts = m.series.filter((p) => p.wpm != null);
  const ymax = niceMax(Math.max(m.peakWpm, m.avgWpm, 10) * 1.1);
  const x = (tt) => pad.l + (tt / m.span) * (W - pad.l - pad.r);
  const y = (v) => H - pad.b - (v / ymax) * (H - pad.t - pad.b);
  const svg = el('svg:svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': `Speed over time, average ${m.avgWpm} words per minute` });
  const defs = el('svg:defs', {}, el('svg:linearGradient', { id: 'sg', x1: 0, y1: 0, x2: 0, y2: 1 },
    el('svg:stop', { offset: 0, 'stop-color': '#D6FF3D', 'stop-opacity': 0.22 }),
    el('svg:stop', { offset: 1, 'stop-color': '#D6FF3D', 'stop-opacity': 0 })));
  svg.append(defs);
  const grid = el('svg:g', { class: 'grid' });
  const axis = el('svg:g', { class: 'axis' });
  for (let i = 0; i <= 4; i++) {
    const v = (ymax / 4) * i;
    grid.append(el('svg:line', { x1: pad.l, x2: W - pad.r, y1: y(v), y2: y(v) }));
    axis.append(el('svg:text', { x: pad.l - 8, y: y(v) + 3.5, 'text-anchor': 'end' }, String(Math.round(v))));
  }
  for (let i = 0; i <= 4; i++) {
    const tt = (m.span / 4) * i;
    axis.append(el('svg:text', { x: x(tt), y: H - 6, 'text-anchor': i === 0 ? 'start' : i === 4 ? 'end' : 'middle' }, clock(tt)));
  }
  svg.append(grid, axis);
  if (pts.length > 1) {
    const line = pts.map((p, i) => `${i ? 'L' : 'M'}${x(p.t).toFixed(1)},${y(p.wpm).toFixed(1)}`).join('');
    svg.append(el('svg:path', { d: `${line}L${x(pts.at(-1).t).toFixed(1)},${y(0)}L${x(pts[0].t).toFixed(1)},${y(0)}Z`, fill: 'url(#sg)' }));
    svg.append(el('svg:line', { x1: pad.l, x2: W - pad.r, y1: y(m.avgWpm), y2: y(m.avgWpm), stroke: 'rgba(255,255,255,.35)', 'stroke-dasharray': '4 4' }));
    svg.append(el('svg:text', { x: W - pad.r, y: y(m.avgWpm) - 6, 'text-anchor': 'end', fill: '#A7AAB4', style: 'font:500 10.5px var(--mono)' }, `avg ${m.avgWpm}`));
    svg.append(el('svg:path', { d: line, fill: 'none', stroke: '#D6FF3D', 'stroke-width': 2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }));
  }
  const cross = el('svg:line', { class: 'cross', y1: pad.t, y2: H - pad.b, visibility: 'hidden' });
  const dot = el('svg:circle', { r: 4.5, fill: '#D6FF3D', stroke: '#0f1015', 'stroke-width': 2, visibility: 'hidden' });
  const hit = el('svg:rect', { class: 'hit', x: pad.l, y: 0, width: Math.max(0, W - pad.l - pad.r), height: H });
  svg.append(cross, dot, hit);
  hit.addEventListener('pointermove', (e) => {
    const r = svg.getBoundingClientRect();
    const tt = ((e.clientX - r.left - pad.l) / (W - pad.l - pad.r)) * m.span;
    let best = pts[0];
    for (const p of pts) if (Math.abs(p.t - tt) < Math.abs(best.t - tt)) best = p;
    if (!best) return;
    for (const a of [cross]) { a.setAttribute('x1', x(best.t)); a.setAttribute('x2', x(best.t)); a.setAttribute('visibility', 'visible'); }
    dot.setAttribute('cx', x(best.t)); dot.setAttribute('cy', y(best.wpm)); dot.setAttribute('visibility', 'visible');
    tip.show(e.clientX, r.top + y(best.wpm), clock(best.t), [el('b', {}, String(best.wpm)), ' wpm']);
  });
  hit.addEventListener('pointerleave', () => { cross.setAttribute('visibility', 'hidden'); dot.setAttribute('visibility', 'hidden'); tip.hide(); });
  hit.addEventListener('click', (e) => {
    const r = svg.getBoundingClientRect();
    replay.seek(((e.clientX - r.left - pad.l) / (W - pad.l - pad.r)) * m.span);
  });
  box.replaceChildren(svg);
}

function rhythmChart(box, m) {
  const W = box.clientWidth;
  const H = box.clientHeight;
  const pad = { l: 34, r: 6, t: 10, b: 24 };
  const total = m.hist.reduce((a, b) => a + b.count, 0) || 1;
  const ymax = niceMax(Math.max(...m.hist.map((b) => b.count), 1));
  const bw = (W - pad.l - pad.r) / m.hist.length;
  const y = (v) => H - pad.b - (v / ymax) * (H - pad.t - pad.b);
  const svg = el('svg:svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': `Keystroke gaps, median ${m.median} milliseconds` });
  const grid = el('svg:g', { class: 'grid' });
  const axis = el('svg:g', { class: 'axis' });
  for (let i = 0; i <= 4; i++) {
    const v = (ymax / 4) * i;
    grid.append(el('svg:line', { x1: pad.l, x2: W - pad.r, y1: y(v), y2: y(v) }));
    axis.append(el('svg:text', { x: pad.l - 8, y: y(v) + 3.5, 'text-anchor': 'end' }, formatNumber(Math.round(v))));
  }
  svg.append(grid, axis);
  m.hist.forEach((b, i) => {
    const x0 = pad.l + i * bw + 1;
    const w = Math.max(1, bw - 2); // 2px gap between bars
    const top = y(b.count);
    const h = Math.max(0, y(0) - top);
    // Rounded top, square baseline.
    const rr = Math.min(4, w / 2, h);
    const d = h > 0
      ? `M${x0},${y(0)}V${top + rr}Q${x0},${top} ${x0 + rr},${top}H${x0 + w - rr}Q${x0 + w},${top} ${x0 + w},${top + rr}V${y(0)}Z`
      : '';
    const bar = el('svg:path', { class: 'bar', d });
    const hit = el('svg:rect', { class: 'hit', x: pad.l + i * bw, y: pad.t, width: bw, height: H - pad.t - pad.b });
    axis.append(el('svg:text', { x: pad.l + i * bw + bw / 2, y: H - 6, 'text-anchor': 'middle' }, b.label));
    hit.addEventListener('pointerenter', () => { bar.classList.add('on'); box.classList.add('has-hover'); });
    hit.addEventListener('pointermove', (e) => tip.show(e.clientX, e.clientY, `${b.label}${/s$/.test(b.label) ? '' : ' ms'}`,
      [el('b', {}, formatNumber(b.count)), ` keys · ${Math.round((b.count / total) * 100)}%`]));
    hit.addEventListener('pointerleave', () => { bar.classList.remove('on'); box.classList.remove('has-hover'); tip.hide(); });
    svg.append(bar, hit);
  });
  box.replaceChildren(svg);
}

function drawCharts() {
  if (!model) return;
  speedChart($('#speedChart'), model);
  rhythmChart($('#rhythmChart'), model);
  replay.drawDensity();
}

// ---- Replay ---------------------------------------------------------------------------------

const replay = {
  idx: 0, vt: 0, speed: 4, raf: 0, last: 0,
  ink: null, typo: null,

  load(rep, m) {
    this.m = m;
    this.ink = document.createTextNode('');
    this.typo = document.createTextNode('');
    $('#ink').replaceChildren(this.ink);
    $('#typo').replaceChildren(this.typo);
    $('#prefix').textContent = rep.startOffset > 0 ? `[… ${formatNumber(rep.startOffset)} characters typed in an earlier session]\n` : '';
    $('#tEnd').textContent = clock(m.span);
    this.reset();
    this.seek(m.span); // open on the finished text
  },

  reset() {
    this.idx = 0;
    this.vt = 0;
    this.ink.data = '';
    this.typo.data = '';
  },

  apply(i) {
    const k = this.m.keys[i];
    if (k === BS) {
      if (this.typo.length) this.typo.deleteData(this.typo.length - 1, 1);
      else if (this.ink.length) {
        const s = this.ink.data;
        const cut = /[\uDC00-\uDFFF]/.test(s.at(-1)) ? 2 : 1;
        this.ink.deleteData(s.length - cut, cut);
      }
    } else if (this.m.typos.has(i)) this.typo.appendData(k);
    else this.ink.appendData(k);
  },

  advanceTo(vt) {
    const { t, n } = this.m;
    if (vt < this.vt) this.reset();
    if (this.idx === 0 && vt > this.vt && n > 0 && this.ink.length === 0 && this.typo.length === 0) {
      // Fast path when seeking far forward from the start: build in bulk.
      let ink = '';
      let typo = '';
      let i = 0;
      for (; i < n && t[i] <= vt; i++) {
        const k = this.m.keys[i];
        if (k === BS) { if (typo) typo = typo.slice(0, -1); else ink = Array.from(ink).slice(0, -1).join(''); }
        else if (this.m.typos.has(i)) typo += k;
        else ink += k;
      }
      this.ink.data = ink;
      this.typo.data = typo;
      this.idx = i;
    } else {
      while (this.idx < n && t[this.idx] <= vt) this.apply(this.idx++);
    }
    this.vt = vt;
    this.paint();
  },

  paint() {
    $('#tNow').textContent = clock(this.vt);
    $('#scrubber').value = String(Math.round((this.vt / this.m.span) * 1000));
    const paper = $('#paper');
    if (this.playing) paper.scrollTop = paper.scrollHeight;
  },

  seek(vt) {
    this.advanceTo(Math.max(0, Math.min(this.m.span, vt)));
    const paper = $('#paper');
    paper.scrollTop = paper.scrollHeight;
  },

  play() {
    if (this.vt >= this.m.span) this.seek(0);
    this.playing = true;
    document.body.classList.add('playing');
    $('#play').setAttribute('aria-label', 'Pause');
    this.last = performance.now();
    const tick = (now) => {
      if (!this.playing) return;
      this.advanceTo(Math.min(this.m.span, this.vt + (now - this.last) * this.speed));
      this.last = now;
      if (this.vt >= this.m.span) return this.stop();
      this.raf = requestAnimationFrame(tick);
    };
    this.raf = requestAnimationFrame(tick);
  },

  stop() {
    this.playing = false;
    cancelAnimationFrame(this.raf);
    document.body.classList.remove('playing');
    $('#play').setAttribute('aria-label', 'Play');
  },

  // Keystroke density across the session, drawn under the scrubber.
  drawDensity() {
    const c = $('#density');
    const m = this.m;
    if (!m) return;
    const dpr = devicePixelRatio || 1;
    const W = c.clientWidth;
    const H = c.clientHeight;
    c.width = W * dpr;
    c.height = H * dpr;
    const g = c.getContext('2d');
    g.scale(dpr, dpr);
    g.fillStyle = 'rgba(255,255,255,0.035)';
    g.fillRect(0, 0, W, H);
    const cols = Math.max(1, Math.floor(W / 3));
    const counts = new Array(cols).fill(0);
    for (let i = 0; i < m.n; i++) counts[Math.min(cols - 1, Math.floor((m.t[i] / m.span) * cols))] += 1;
    const max = Math.max(...counts, 1);
    counts.forEach((v, i) => {
      if (!v) return;
      const h = Math.max(2, (v / max) * (H - 8));
      g.fillStyle = `rgba(214,255,61,${0.25 + 0.5 * (v / max)})`;
      g.fillRect(i * 3, H - 4 - h, 2, h);
    });
    for (const p of m.pauses) {
      if (p.kind === 'hold' || p.kind === 'background' || p.kind === 'break') continue;
      g.fillStyle = 'rgba(139,108,255,0.55)';
      const x0 = ((p.at) / m.span) * W;
      const x1 = ((p.at + p.ms) / m.span) * W;
      g.fillRect(x0, H - 3, Math.max(2, x1 - x0), 2);
    }
  },
};

$('#play').addEventListener('click', () => (replay.playing ? replay.stop() : replay.play()));
$('#scrubber').addEventListener('input', (e) => {
  replay.stop();
  replay.seek((Number(e.target.value) / 1000) * replay.m.span);
});
$('#speedSeg').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-x]');
  if (!b) return;
  replay.speed = Number(b.dataset.x);
  for (const x of $('#speedSeg').children) x.setAttribute('aria-pressed', String(x === b));
});
document.addEventListener('keydown', (e) => {
  if (e.key === ' ' && !e.target.closest('button, input') && current) { e.preventDefault(); $('#play').click(); }
});

// ---- Actions -------------------------------------------------------------------------------

function summaryText(rep, m) {
  return [
    `Graphi automated typing session — ${rep.title || 'Untitled'}`,
    `${dateFmt.format(rep.startedAt)} · ${rep.host || 'page'}`,
    `Typed by Graphi (auto typer): ${formatNumber(m.chars)} characters in ${human(m.activeMs)} at ${m.avgWpm} wpm (peak ${m.peakWpm}).`,
    `${formatNumber(m.n)} keystrokes · ${m.backspaces} corrections · ${m.pauses.length} pauses over 2s.`,
  ].join('\n');
}

// Print / Save as PDF shows the finished text and every table.
addEventListener('beforeprint', () => {
  if (!replay.m) return;
  replay.stop();
  replay.seek(replay.m.span);
});
$('#printReport').addEventListener('click', () => window.print());

$('#copySummary').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(summaryText(current, model));
    toast('Summary copied');
  } catch {
    toast("Couldn't reach the clipboard");
  }
});

$('#exportJson').addEventListener('click', () => {
  const blob = new Blob([JSON.stringify({ generator: 'Graphi auto typer', automated: true, ...current }, null, 2)], { type: 'application/json' });
  const a = el('a', { href: URL.createObjectURL(blob), download: `graphi-session-${new Date(current.startedAt).toISOString().slice(0, 16).replace(/[:T]/g, '-')}.json` });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
});

$('#deleteReport').addEventListener('click', async () => {
  const gone = current;
  const pos = reports.findIndex((r) => r.id === gone.id);
  reports = reports.filter((r) => r.id !== gone.id);
  await saveReports(reports);
  select(reports[Math.min(pos, reports.length - 1)]?.id, true);
  toast('Report deleted', {
    label: 'Undo',
    run: async () => {
      reports.splice(pos, 0, gone);
      await saveReports(reports);
      select(gone.id, true);
    },
  });
});

let resizeRaf = 0;
addEventListener('resize', () => { cancelAnimationFrame(resizeRaf); resizeRaf = requestAnimationFrame(drawCharts); });

// ---- Boot ---------------------------------------------------------------------------------------

async function refresh(selectId) {
  reports = await loadReports();
  await renderLifetime();
  select(selectId ?? current?.id ?? wanted);
}

browser.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !(changes[KEYS.reports] || changes[KEYS.stats])) return;
  // A just-finished session may land after this page opened for it.
  const fresh = wanted && !seenWanted && (changes[KEYS.reports]?.newValue || []).some((r) => r.id === wanted);
  if (changes[KEYS.reports] && !replay.playing) refresh(fresh ? wanted : undefined);
  else renderLifetime();
});

refresh().then(() => { document.documentElement.dataset.ready = 'true'; });
