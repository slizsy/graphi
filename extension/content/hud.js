/* Graphi — on-page HUD.
 *
 * A small floating control panel rendered in a closed shadow root so page
 * styles can't leak in and ours can't leak out. It never takes focus away
 * from the field being typed into: pointerdown is cancelled on the panel, so
 * clicking Pause or Stop leaves the page's caret exactly where it was.
 */
(() => {
  'use strict';
  const NS = (globalThis.__graphi ??= {});
  if (NS.Hud) return;

  const CSS = `
  :host { all: initial; }
  * { box-sizing: border-box; }
  .wrap {
    position: fixed; right: 20px; bottom: 20px; z-index: 2147483647;
    font: 500 13px/1.4 "Graphi Geist", ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
    color: #F2F3F5; -webkit-font-smoothing: antialiased;
    transition: opacity .28s ease, transform .38s cubic-bezier(.2,.8,.2,1);
  }
  .wrap.hidden { opacity: 0; transform: translateY(14px) scale(.97); pointer-events: none; }
  .panel {
    position: relative; width: 304px; padding: 14px 14px 12px;
    background:
      radial-gradient(120% 90% at 100% 0%, rgba(214,255,61,.10), transparent 55%),
      radial-gradient(90% 80% at 0% 100%, rgba(139,108,255,.10), transparent 60%),
      #0B0C10;
    border: 1px solid rgba(255,255,255,.09); border-radius: 18px;
    box-shadow: 0 24px 60px -12px rgba(0,0,0,.65), 0 0 0 1px rgba(0,0,0,.5), inset 0 1px 0 rgba(255,255,255,.06);
    overflow: hidden;
  }
  .panel::before { /* HUD corner ticks */
    content: ""; position: absolute; inset: 7px; pointer-events: none; border-radius: 12px;
    background:
      linear-gradient(#D6FF3D,#D6FF3D) left top / 8px 1px no-repeat,
      linear-gradient(#D6FF3D,#D6FF3D) left top / 1px 8px no-repeat,
      linear-gradient(#D6FF3D,#D6FF3D) right bottom / 8px 1px no-repeat,
      linear-gradient(#D6FF3D,#D6FF3D) right bottom / 1px 8px no-repeat;
    opacity: .55;
  }
  .head { display: flex; align-items: center; gap: 8px; cursor: grab; user-select: none; }
  .head:active { cursor: grabbing; }
  .mark { width: 22px; height: 22px; flex: none; }
  .brand { font: 600 11px/1 "Graphi Mono", ui-monospace, SFMono-Regular, Menlo, monospace; letter-spacing: .16em; color: #A3A6B0; }
  .chip {
    margin-left: auto; display: inline-flex; align-items: center; gap: 6px; height: 22px; padding: 0 9px;
    border-radius: 999px; background: rgba(255,255,255,.05); border: 1px solid rgba(255,255,255,.07);
    font: 600 10px/1 "Graphi Mono", ui-monospace, Menlo, monospace; letter-spacing: .12em; text-transform: uppercase;
  }
  .dot { width: 6px; height: 6px; border-radius: 50%; background: var(--tone, #6B6E79); box-shadow: 0 0 10px var(--tone, transparent); }
  .typing .dot { animation: pulse 1.4s ease-in-out infinite; }
  @keyframes pulse { 50% { opacity: .35; } }
  .icon-btn {
    width: 24px; height: 24px; display: grid; place-items: center; border-radius: 8px; border: 0; padding: 0;
    background: transparent; color: #6B6E79; cursor: pointer; transition: background .15s, color .15s;
  }
  .icon-btn:hover { background: rgba(255,255,255,.07); color: #F2F3F5; }
  .body { margin-top: 12px; }
  .msg { color: #C9CBD2; font-size: 13px; line-height: 1.45; }
  .msg b { color: #F2F3F5; font-weight: 600; }
  .stats { display: flex; align-items: baseline; gap: 10px; }
  .pct { font: 600 26px/1 "Graphi Geist", ui-sans-serif, system-ui, sans-serif; letter-spacing: -.02em; font-variant-numeric: tabular-nums; }
  .pct small { font-size: 13px; color: #6B6E79; margin-left: 1px; }
  .meta { margin-left: auto; font: 500 11px/1 "Graphi Mono", ui-monospace, Menlo, monospace; color: #8A8D98; font-variant-numeric: tabular-nums; text-align: right; }
  .bar { position: relative; height: 4px; margin-top: 10px; border-radius: 99px; background: rgba(255,255,255,.07); overflow: hidden; }
  .fill {
    position: absolute; inset: 0 auto 0 0; width: 0; border-radius: inherit;
    background: linear-gradient(90deg, #8FE02B, #D6FF3D);
    box-shadow: 0 0 14px rgba(214,255,61,.55);
    transition: width .25s linear;
  }
  .paused .fill { background: linear-gradient(90deg, #E39A2B, #FFC861); box-shadow: 0 0 14px rgba(255,181,71,.45); }
  .count {
    font: 600 44px/1 "Graphi Geist", ui-sans-serif, system-ui, sans-serif; letter-spacing: -.03em;
    color: #D6FF3D; text-shadow: 0 0 24px rgba(214,255,61,.45); font-variant-numeric: tabular-nums;
    animation: tick .9s cubic-bezier(.2,.8,.2,1);
  }
  @keyframes tick { from { transform: scale(1.25); opacity: .2; } }
  .row { display: flex; gap: 8px; margin-top: 12px; }
  button.act {
    flex: 1; height: 34px; border-radius: 10px; border: 1px solid rgba(255,255,255,.09);
    background: rgba(255,255,255,.05); color: #F2F3F5; cursor: pointer;
    font: 600 12.5px/1 "Graphi Geist", ui-sans-serif, system-ui, sans-serif;
    display: inline-flex; align-items: center; justify-content: center; gap: 7px;
    transition: background .15s, border-color .15s, transform .1s, box-shadow .2s;
  }
  button.act:hover { background: rgba(255,255,255,.09); border-color: rgba(255,255,255,.14); }
  button.act:active { transform: scale(.97); }
  button.act.primary {
    color: #0A0B0D; border-color: transparent;
    background: linear-gradient(180deg, #E2FF6A, #C4F53A);
    box-shadow: 0 6px 18px -6px rgba(214,255,61,.6), inset 0 1px 0 rgba(255,255,255,.5);
  }
  button.act.primary:hover { box-shadow: 0 8px 24px -6px rgba(214,255,61,.8), inset 0 1px 0 rgba(255,255,255,.5); background: linear-gradient(180deg, #E8FF80, #CCF94A); }
  button.act.danger:hover { background: rgba(255,93,108,.12); border-color: rgba(255,93,108,.35); color: #FF8C97; }
  .kbd { font: 600 10px/1 "Graphi Mono", ui-monospace, Menlo, monospace; opacity: .55; }
  .mini {
    display: none; align-items: center; gap: 8px; height: 38px; padding: 0 14px 0 10px; border-radius: 999px;
    background: #0B0C10; border: 1px solid rgba(255,255,255,.1); cursor: pointer;
    box-shadow: 0 14px 40px -10px rgba(0,0,0,.6); font: 600 12px/1 "Graphi Mono", ui-monospace, Menlo, monospace;
    color: #F2F3F5; font-variant-numeric: tabular-nums;
  }
  .min .panel { display: none; }
  .min .mini { display: inline-flex; }
  .ring { width: 20px; height: 20px; transform: rotate(-90deg); }
  .ok { color: #D6FF3D; }
  .err { color: #FF8C97; }
  @media (prefers-reduced-motion: reduce) { * { animation: none !important; transition: none !important; } }
  `;

  const MARK = `<svg class="mark" viewBox="0 0 32 32" aria-hidden="true"><defs><linearGradient id="cv" x1="0" y1="1" x2="1" y2="0"><stop offset="0" stop-color="#9BEA2E"/><stop offset="1" stop-color="#E4FF5C"/></linearGradient></defs><rect x="1" y="1" width="30" height="30" rx="8" fill="#14161C" stroke="rgba(255,255,255,.12)"/><g fill="url(#cv)"><rect x="6" y="13.5" width="3" height="5" rx="1.5" opacity=".55"/><rect x="10.5" y="11" width="3" height="10" rx="1.5" opacity=".8"/><rect x="19.5" y="7.5" width="3" height="17" rx="1.5"/><rect x="16.5" y="6.5" width="9" height="3" rx="1.5"/><rect x="16.5" y="22.5" width="9" height="3" rx="1.5"/></g></svg>`;
  const ICON = {
    pause: '<svg width="12" height="12" viewBox="0 0 12 12"><rect x="2" y="1.5" width="3" height="9" rx="1" fill="currentColor"/><rect x="7" y="1.5" width="3" height="9" rx="1" fill="currentColor"/></svg>',
    play: '<svg width="12" height="12" viewBox="0 0 12 12"><path d="M3 1.8v8.4a.8.8 0 0 0 1.2.7l6.6-4.2a.8.8 0 0 0 0-1.4L4.2 1.1A.8.8 0 0 0 3 1.8z" fill="currentColor"/></svg>',
    stop: '<svg width="11" height="11" viewBox="0 0 12 12"><rect x="1.5" y="1.5" width="9" height="9" rx="2" fill="currentColor"/></svg>',
    min: '<svg width="12" height="12" viewBox="0 0 12 12"><path d="M2.5 6h7" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>',
    chart: '<svg width="12" height="12" viewBox="0 0 12 12"><path d="M1.5 10.5h9M3 8.5V6M6 8.5V2.5M9 8.5V4.5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>',
    close: '<svg width="12" height="12" viewBox="0 0 12 12"><path d="M3 3l6 6M9 3l-6 6" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>',
  };
  const TONES = { typing: '#D6FF3D', paused: '#FFB547', countdown: '#8B6CFF', arming: '#8B6CFF', done: '#D6FF3D', error: '#FF5D6C', stopped: '#6B6E79' };
  const LABELS = { typing: 'Typing', paused: 'Paused', countdown: 'Ready', arming: 'Waiting', done: 'Done', error: 'Error', stopped: 'Stopped' };

  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
  const fmtTime = (ms) => {
    const s = Math.max(0, Math.round(ms / 1000));
    return s >= 3600 ? `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m` : `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  };

  let fontsLoaded = false;
  async function loadFonts() {
    if (fontsLoaded) return;
    fontsLoaded = true;
    try {
      const faces = [
        ['Graphi Geist', 'assets/fonts/Geist-Variable.woff2'],
        ['Graphi Mono', 'assets/fonts/GeistMono-Variable.woff2'],
      ];
      for (const [family, path] of faces) {
        const buf = await (await fetch(browser.runtime.getURL(path))).arrayBuffer();
        const face = new FontFace(family, buf, { weight: '100 900' });
        await face.load();
        document.fonts.add(face);
      }
    } catch {
      /* system fonts are a fine fallback */
    }
  }

  class Hud {
    constructor(onAction) {
      this.onAction = onAction;
      this.host = null;
      this.minimized = false;
      this.hideTimer = 0;
      this.last = null;
    }

    _mount() {
      if (this.host?.isConnected) return;
      loadFonts();
      this.host = document.createElement('graphi-hud');
      const root = this.host.attachShadow({ mode: 'closed' });
      root.innerHTML = `<style>${CSS}</style>
        <div class="wrap hidden" part="wrap">
          <div class="panel" role="status" aria-live="polite">
            <div class="head">${MARK}<span class="brand">GRAPHI</span>
              <span class="chip"><span class="dot"></span><span class="state"></span></span>
              <button class="icon-btn" data-act="minimize" title="Minimise">${ICON.min}</button>
            </div>
            <div class="body"></div>
          </div>
          <button class="mini" data-act="expand" title="Show Graphi">
            <svg class="ring" viewBox="0 0 20 20"><circle cx="10" cy="10" r="8" fill="none" stroke="rgba(255,255,255,.1)" stroke-width="2.5"/><circle class="ring-fill" cx="10" cy="10" r="8" fill="none" stroke="#D6FF3D" stroke-width="2.5" stroke-linecap="round" stroke-dasharray="50.27" stroke-dashoffset="50.27"/></svg>
            <span class="mini-label"></span>
          </button>
        </div>`;
      this.root = root;
      this.wrap = root.querySelector('.wrap');
      this.body = root.querySelector('.body');

      // Keep focus (and the caret) in the page while using the panel.
      root.addEventListener('pointerdown', (e) => {
        if (!e.target.closest?.('.head')) e.preventDefault();
      });
      root.addEventListener('mousedown', (e) => e.preventDefault());
      root.addEventListener('click', (e) => {
        const btn = e.target.closest?.('[data-act]');
        if (!btn) return;
        const act = btn.dataset.act;
        if (act === 'minimize') return this.setMinimized(true);
        if (act === 'expand') return this.setMinimized(false);
        this.onAction(act);
      });
      this._enableDrag(root.querySelector('.head'));
      (document.body || document.documentElement).appendChild(this.host);
      requestAnimationFrame(() => requestAnimationFrame(() => this.wrap.classList.remove('hidden')));
    }

    _enableDrag(handle) {
      let start = null;
      handle.addEventListener('pointerdown', (e) => {
        if (e.target.closest('button')) return;
        e.preventDefault();
        const r = this.wrap.getBoundingClientRect();
        start = { x: e.clientX, y: e.clientY, right: innerWidth - r.right, bottom: innerHeight - r.bottom };
        handle.setPointerCapture(e.pointerId);
      });
      handle.addEventListener('pointermove', (e) => {
        if (!start) return;
        const right = Math.min(innerWidth - 80, Math.max(4, start.right - (e.clientX - start.x)));
        const bottom = Math.min(innerHeight - 40, Math.max(4, start.bottom - (e.clientY - start.y)));
        this.wrap.style.right = `${right}px`;
        this.wrap.style.bottom = `${bottom}px`;
      });
      const end = () => { start = null; };
      handle.addEventListener('pointerup', end);
      handle.addEventListener('pointercancel', end);
    }

    contains(node) {
      return !!this.host && !!node && (node === this.host || (typeof node.nodeType === 'number' && this.host.contains(node)));
    }

    setMinimized(v) {
      this.minimized = v;
      this.wrap?.classList.toggle('min', v);
    }

    render(snap) {
      clearTimeout(this.hideTimer);
      this._mount();
      this.last = snap;
      const { state } = snap;
      this.wrap.classList.toggle('typing', state === 'typing');
      this.wrap.classList.toggle('paused', state === 'paused');
      this.wrap.style.setProperty('--tone', TONES[state] || '#6B6E79');
      this.root.querySelector('.state').textContent = LABELS[state] || state;

      const pct = Math.floor((snap.progress || 0) * 100);
      const ringOffset = 50.27 * (1 - (snap.progress || 0));
      this.root.querySelector('.ring-fill').setAttribute('stroke-dashoffset', String(ringOffset));
      this.root.querySelector('.ring-fill').setAttribute('stroke', TONES[state] || '#D6FF3D');
      this.root.querySelector('.mini-label').textContent =
        state === 'typing' || state === 'paused' ? `${pct}%` : LABELS[state] || '';

      const target = snap.target ? esc(snap.target) : 'the page';
      const shortcut = snap.shortcuts?.toggle ? `<span class="kbd">${esc(snap.shortcuts.toggle)}</span>` : '';
      let html = '';
      switch (state) {
        case 'arming':
          html = `<div class="msg"><b>Click into the field</b> you want Graphi to type in. It starts as soon as a text field has focus.</div>
            <div class="row"><button class="act" data-act="stop">Cancel</button></div>`;
          break;
        case 'countdown':
          html = `<div class="stats"><div class="count">${snap.countdown}</div>
              <div class="msg" style="margin-left:12px">Typing into <b>${target}</b><br><span style="color:#8A8D98">Esc cancels</span></div></div>
            <div class="row"><button class="act" data-act="stop">Cancel</button><button class="act primary" data-act="skip">${ICON.play}Start now</button></div>`;
          break;
        case 'typing':
          if (snap.breakLeft > 0) {
            html = `<div class="stats"><div class="pct">${pct}<small>%</small></div><div class="meta">On a break<br><span style="opacity:.7">${fmtTime(snap.breakLeft)} left</span></div></div>
              <div class="bar"><div class="fill" style="width:${(snap.progress || 0) * 100}%"></div></div>
              <div class="row"><button class="act primary" data-act="skipbreak">${ICON.play}End break</button><button class="act danger" data-act="stop">${ICON.stop}Stop</button></div>`;
            this._breakTick(snap);
            break;
          }
        // falls through
        case 'paused': {
          const meta = state === 'paused'
            ? (snap.pauseReason ? esc(snap.pauseReason) : 'On hold')
            : `${snap.wpm ? `${snap.wpm} wpm · ` : ''}${snap.eta != null ? `${fmtTime(snap.eta)} left` : ''}`;
          html = `<div class="stats"><div class="pct">${pct}<small>%</small></div><div class="meta">${meta}<br><span style="opacity:.7">${snap.typed.toLocaleString()} / ${snap.total.toLocaleString()}</span></div></div>
            <div class="bar"><div class="fill" style="width:${(snap.progress || 0) * 100}%"></div></div>
            ${state === 'paused' && snap.hint ? `<div class="msg" style="margin-top:10px;font-size:12px;color:#A3A6B0">${esc(snap.hint)}</div>` : ''}
            <div class="row">
              ${state === 'typing'
                ? `<button class="act" data-act="pause">${ICON.pause}Pause ${shortcut}</button>`
                : `<button class="act primary" data-act="resume">${ICON.play}Resume ${shortcut}</button>`}
              <button class="act danger" data-act="stop">${ICON.stop}Stop</button>
            </div>`;
          break;
        }
        case 'done':
          html = `<div class="msg"><b class="ok">Finished.</b> Typed ${snap.total.toLocaleString()} characters in ${fmtTime(snap.elapsed || 0)}.</div>${reportRow(snap)}`;
          this._autoHide(snap.hasReport ? 9000 : 4200);
          break;
        case 'stopped':
          html = `<div class="msg">Stopped at <b>${pct}%</b>. Resume from this point any time from the Graphi popup.</div>${reportRow(snap)}`;
          this._autoHide(snap.hasReport ? 8000 : 3600);
          break;
        case 'error':
          html = `<div class="msg"><b class="err">Couldn't keep typing.</b> ${esc(snap.error || 'Something went wrong.')}</div>
            <div class="row"><button class="act" data-act="dismiss">Dismiss</button></div>`;
          break;
        case 'notice':
          html = `<div class="msg">${esc(snap.message)}</div>`;
          this._autoHide(3800);
          break;
        default:
          html = '';
      }
      if (this.body.innerHTML !== html) {
        // Patch only what changed to keep the progress bar transition smooth.
        const fill = this.body.querySelector('.fill');
        if (fill && (state === 'typing' || state === 'paused') && this.body.dataset.state === state && this.body.dataset.shape === shapeKey(snap)) {
          fill.style.width = `${(snap.progress || 0) * 100}%`;
          this.body.querySelector('.pct').innerHTML = `${pct}<small>%</small>`;
          const metaEl = this.body.querySelector('.meta');
          const tmp = document.createElement('div');
          tmp.innerHTML = html;
          metaEl.innerHTML = tmp.querySelector('.meta').innerHTML;
        } else {
          this.body.innerHTML = html;
        }
        this.body.dataset.state = state;
        this.body.dataset.shape = shapeKey(snap);
      }
      if (state === 'error' || state === 'arming' || state === 'countdown') this.setMinimized(false);
    }

    // Count the break down every second without waiting for the runtime.
    _breakTick(snap) {
      clearTimeout(this.breakTimer);
      const end = Date.now() + snap.breakLeft;
      this.breakTimer = setTimeout(() => {
        if (this.last === snap) this.render({ ...snap, breakLeft: Math.max(0, end - Date.now()) });
      }, 1000);
    }

    _autoHide(ms) {
      clearTimeout(this.hideTimer);
      this.hideTimer = setTimeout(() => this.hide(), ms);
    }

    hide() {
      clearTimeout(this.hideTimer);
      if (!this.host) return;
      this.wrap.classList.add('hidden');
      const host = this.host;
      this.host = null;
      setTimeout(() => host.remove(), 400);
    }
  }

  function reportRow(snap) {
    if (!snap.hasReport) return '';
    return `<div class="row"><button class="act" data-act="dismiss">Close</button><button class="act primary" data-act="report">${ICON.chart}View report</button></div>`;
  }

  function shapeKey(snap) {
    return `${snap.state}|${snap.breakLeft > 0 ? 'break' : ''}|${snap.hint || ''}|${snap.shortcuts?.toggle || ''}`;
  }

  NS.Hud = Hud;
})();
