// The action dock at the bottom of the popup: the Start button when idle, and
// live progress with Pause/Resume/Stop while a session runs in this tab.

import { $ } from '../components/ui.js';
import { state, subscribe, currentDoc } from '../store.js';
import { formatShortcut } from '../../shared/format.js';

const LIVE = new Set(['arming', 'countdown', 'typing', 'paused']);

const fmtClock = (ms) => {
  const s = Math.max(0, Math.round(ms / 1000));
  return s >= 3600 ? `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m` : `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

export function initDock({ start, control }) {
  const dock = $('#dock');
  const startBtn = $('#startBtn');
  let hintOverride = null;

  startBtn.addEventListener('click', () => start());
  $('#pauseBtn').addEventListener('click', () => control(state.snapshot?.state === 'paused' ? 'resume' : 'pause'));
  $('#stopBtn').addEventListener('click', () => control('stop'));

  browser.commands.getAll().then((cmds) => {
    const c = cmds.find((x) => x.name === 'toggle-typing');
    $('#startKbd').textContent = formatShortcut(c?.shortcut, state.os);
  });

  function render() {
    const snap = state.snapshot;
    const live = snap && LIVE.has(snap.state);
    dock.dataset.mode = live ? 'session' : 'idle';
    dock.dataset.state = snap?.state || 'idle';

    if (live) {
      const pct = Math.floor((snap.progress || 0) * 100);
      $('#sessPct').textContent = snap.state === 'arming' ? '—' : snap.state === 'countdown' ? String(snap.countdown) : String(pct);
      $('#sessPct').nextElementSibling.hidden = snap.state === 'arming' || snap.state === 'countdown';
      $('#sessBar').style.width = `${(snap.progress || 0) * 100}%`;
      const labels = { typing: 'Typing', paused: snap.pauseReason || 'Paused', countdown: 'Starting', arming: 'Waiting for a field' };
      $('#sessState').textContent = labels[snap.state];
      let meta = '';
      if (snap.state === 'typing' && snap.breakLeft > 0) meta = `On a break · ${fmtClock(snap.breakLeft)} left`;
      else if (snap.state === 'typing') meta = `${snap.wpm ? `${snap.wpm} wpm · ` : ''}${snap.eta != null ? `${fmtClock(snap.eta)} left` : ''}`;
      else if (snap.state === 'paused') meta = `${snap.typed.toLocaleString()} / ${snap.total.toLocaleString()} chars`;
      else if (snap.state === 'arming') meta = 'Click into a text field on the page';
      else meta = snap.target ? `into ${snap.target}` : '';
      $('#sessMeta').textContent = meta;
      $('#pauseLabel').textContent = snap.state === 'paused' ? 'Resume' : 'Pause';
      $('#pauseBtn').disabled = snap.state === 'arming' || snap.state === 'countdown';
      $('#stopBtn').lastChild.textContent = snap.state === 'arming' || snap.state === 'countdown' ? 'Cancel' : 'Stop';
      return;
    }

    const doc = currentDoc();
    const hasText = !!doc?.text.trim();
    const blocked = state.restricted;
    startBtn.disabled = !hasText || !!blocked || state.tabId == null;
    const hint = $('#dockHint');
    hint.classList.toggle('error', !!(blocked || hintOverride?.error));
    if (hintOverride) hint.textContent = hintOverride.text;
    else if (blocked) hint.textContent = blocked;
    else if (!hasText) hint.textContent = 'Add the text you want typed to get started.';
    else hint.textContent = 'Click a text field first — or start, then pick one.';
  }

  subscribe((what) => (what === 'session' || what === 'doc' || what === 'library') && render());
  render();

  return {
    render,
    setBusy(busy) {
      startBtn.classList.toggle('busy', busy);
      $('#startLabel').textContent = busy ? 'Starting' : 'Start typing';
      startBtn.disabled = busy || startBtn.disabled;
      if (!busy) render();
    },
    setHint(text, error = false) {
      hintOverride = text ? { text, error } : null;
      render();
    },
  };
}
