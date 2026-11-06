// Graphi popup entry point: wires the store, views and live session updates.

import '../shared/browser-shim.js';
import { $, $$, toast } from './components/ui.js';
import { state, init, flush, setSnapshot, refreshLastSession, emit, subscribe } from './store.js';
import { initCompose } from './views/compose.js';
import { initTune } from './views/tune.js';
import { initLibrary } from './views/library.js';
import { initSettings } from './views/settings.js';
import { initDock } from './views/dock.js';

const VIEWS = ['compose', 'tune', 'library', 'settings'];
const LIVE = new Set(['arming', 'countdown', 'typing', 'paused']);
// Opened as a regular tab (e.g. from tests) the popup can be
// pointed at another tab with ?tab=<id>, and must not close itself.
const params = new URLSearchParams(location.search);
const inTab = params.has('tab');

let dock;
let settingsView;
let libraryView;

function go(view) {
  if (!VIEWS.includes(view)) return;
  const app = $('#app');
  if (app.dataset.view === view) return;
  app.dataset.view = view;
  for (const tab of $$('.tab')) tab.setAttribute('aria-selected', String(tab.dataset.view === view));
  $('.tabs-indicator').style.setProperty('--i', VIEWS.indexOf(view));
  for (const v of $$('.view')) {
    const on = v.dataset.view === view;
    v.hidden = !on;
    if (on) {
      v.classList.remove('entering');
      void v.offsetWidth; // restart the entrance animation
      v.classList.add('entering');
      v.scrollTop = 0;
    }
  }
  if (view !== 'settings') settingsView?.stopRecording();
  if (view === 'library') libraryView?.render();
  emit(`view:${view}`);
  try { sessionStorage.setItem('graphi:view', view); } catch { /* ignore */ }
}

async function resolveTab() {
  if (inTab) return Number(params.get('tab'));
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  return tab?.id ?? null;
}

async function refreshStatus() {
  if (state.tabId == null) return;
  const res = await browser.runtime.sendMessage({ type: 'popup:status', tabId: state.tabId }).catch(() => null);
  state.restricted = res?.restricted ?? null;
  setSnapshot(res?.snapshot ?? null);
}

async function start({ docId, offset } = {}) {
  if (state.tabId == null) return;
  dock.setHint(null);
  dock.setBusy(true);
  await flush(); // the background reads the text from storage
  const res = await browser.runtime.sendMessage({ type: 'popup:start', tabId: state.tabId, docId, offset })
    .catch((err) => ({ ok: false, error: String(err?.message || err) }));
  dock.setBusy(false);
  if (!res?.ok) {
    dock.setHint(res?.error || 'Graphi could not start on this page.', true);
    toast(res?.error || 'Graphi could not start on this page.', { tone: 'error', duration: 4500 });
    return;
  }
  setSnapshot(res.snapshot);
  // Hand focus back to the page so typing (or the field click) can begin.
  if (!inTab) setTimeout(() => window.close(), 160);
}

async function control(action) {
  const res = await browser.runtime.sendMessage({ type: 'popup:control', tabId: state.tabId, action }).catch(() => null);
  if (res?.snapshot) setSnapshot(res.snapshot);
  else await refreshStatus();
  if (action === 'stop') {
    await refreshLastSession();
    toast('Stopped — you can resume from where it left off');
  }
  if (action === 'resume' && !inTab) setTimeout(() => window.close(), 120);
}

function openReports() {
  browser.runtime.sendMessage({ type: 'popup:openReport' }).catch(() => {});
  if (!inTab) setTimeout(() => window.close(), 80);
}

async function main() {
  await init();
  state.tabId = await resolveTab();

  const compose = initCompose({ go, start });
  initTune();
  libraryView = initLibrary({ go, focusEditor: compose.focusEditor });
  settingsView = initSettings();
  dock = initDock({ start, control });

  for (const tab of $$('.tab')) tab.addEventListener('click', () => go(tab.dataset.view));
  $('#openReports').addEventListener('click', openReports);
  // Arrow keys move between tabs, as in a native tab strip.
  $('.tabs').addEventListener('keydown', (e) => {
    if (!['ArrowLeft', 'ArrowRight'].includes(e.key)) return;
    const i = VIEWS.indexOf($('#app').dataset.view);
    const next = VIEWS[(i + (e.key === 'ArrowRight' ? 1 : VIEWS.length - 1)) % VIEWS.length];
    go(next);
    $(`.tab[data-view="${next}"]`).focus();
  });

  // Live updates from the session running in this tab.
  browser.runtime.onMessage.addListener((msg, sender) => {
    if (msg?.type !== 'graphi:update' || sender.tab?.id !== state.tabId) return;
    const prev = state.snapshot?.state;
    setSnapshot(LIVE.has(msg.snapshot.state) ? msg.snapshot : null);
    if (prev && LIVE.has(prev) && !LIVE.has(msg.snapshot.state)) {
      refreshLastSession();
      if (msg.snapshot.state === 'done') {
        toast('Finished typing', msg.snapshot.hasReport ? { action: { label: 'Report', run: () => openReports() } } : {});
      }
      if (msg.snapshot.state === 'error') toast(msg.snapshot.error, { tone: 'error', duration: 5000 });
    }
  });

  // Settings can also change from another window; keep in sync.
  browser.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.lastSession) refreshLastSession();
  });

  subscribe((what) => {
    if (what !== 'session') return;
    const st = $('#status');
    const snap = state.snapshot;
    const s = snap && LIVE.has(snap.state) ? snap.state : state.restricted ? 'blocked' : 'idle';
    st.dataset.state = s;
    const label = { typing: `Typing ${Math.floor(snap?.progress * 100 || 0)}%`, paused: 'Paused', countdown: 'Starting', arming: 'Waiting', blocked: 'Unavailable', idle: 'Ready' }[s];
    st.querySelector('.status-label').textContent = label;
  });

  let initial = 'compose';
  try { initial = sessionStorage.getItem('graphi:view') || 'compose'; } catch { /* ignore */ }
  $('#app').dataset.view = '';
  go(initial);
  emit('session');
  await refreshStatus();

  // Persist any pending edit the moment the popup goes away.
  window.addEventListener('pagehide', () => { flush(); });
  document.addEventListener('visibilitychange', () => document.hidden && flush());
  document.documentElement.dataset.ready = 'true';
}

main().catch((err) => {
  console.error('[Graphi] popup failed to start', err);
  toast('Graphi failed to load its data. Try reopening the popup.', { tone: 'error', duration: 8000 });
});
