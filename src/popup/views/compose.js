// Compose view: the text being typed, its title, speed presets and the
// "resume where you left off" banner.

import { $, h, toast } from '../components/ui.js';
import { state, subscribe, currentDoc, ensureDoc, updateDoc, setSettings, dismissLastSession } from '../store.js';
import { SPEED_PRESETS, countWords, estimateDurationMs, formatDuration, textFingerprint } from '../../shared/storage.js';
import { formatNumber, relativeTime } from '../../shared/format.js';

export function initCompose({ go, start }) {
  const editor = $('#editor');
  const card = $('#editorCard');
  const title = $('#docTitle');
  const presets = $('#presets');

  $('#pasteKey').textContent = state.os === 'mac' ? '⌘ V' : 'Ctrl V';

  // Presets with a tiny bar graph that reads as "faster" at a glance.
  for (const [i, p] of SPEED_PRESETS.entries()) {
    presets.append(h('button', { class: 'preset', role: 'radio', 'aria-checked': 'false', dataset: { wpm: p.wpm }, title: `${p.wpm} words per minute` },
      h('span', { class: 'preset-name' }, p.label),
      h('span', { class: 'preset-wpm' }, `${p.wpm} wpm`),
      h('span', { class: 'preset-bars', 'aria-hidden': 'true' },
        [0, 1, 2, 3].map((b) => h('i', { style: `height:${3 + b * 2.3}px;opacity:${b <= i ? 1 : 0.28}` })))));
  }
  presets.addEventListener('click', (e) => {
    const btn = e.target.closest('.preset');
    if (btn) setSettings({ wpm: Number(btn.dataset.wpm), paceMode: 'wpm' });
  });

  editor.addEventListener('input', () => {
    const doc = ensureDoc();
    updateDoc(doc.id, { text: editor.value });
  });
  title.addEventListener('input', () => {
    const doc = ensureDoc();
    updateDoc(doc.id, { title: title.value.trim() || 'Untitled' });
  });
  title.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); editor.focus(); }
  });

  // Ctrl/Cmd+Enter from the editor starts typing straight away.
  editor.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); start(); }
  });

  $('#docSwitch').addEventListener('click', () => go('library'));
  for (const b of document.querySelectorAll('[data-goto]')) b.addEventListener('click', () => go(b.dataset.goto));

  $('#clearText').addEventListener('click', () => {
    const doc = currentDoc();
    if (!doc || !doc.text) return;
    const previous = doc.text;
    editor.value = '';
    updateDoc(doc.id, { text: '' });
    renderText();
    editor.focus();
    toast('Text cleared', {
      action: { label: 'Undo', run: () => { updateDoc(doc.id, { text: previous }); editor.value = previous; renderText(); } },
    });
  });

  $('#resumeBtn').addEventListener('click', () => {
    const s = state.lastSession;
    if (s) start({ docId: s.docId, offset: s.offset });
  });
  $('#resumeDismiss').addEventListener('click', () => dismissLastSession());

  function renderDoc() {
    const doc = currentDoc();
    if (document.activeElement !== editor) editor.value = doc?.text ?? '';
    if (document.activeElement !== title) title.value = doc?.title === 'Untitled' && !doc?.text ? '' : doc?.title ?? '';
    const n = state.library.docs.length;
    $('#docCount').textContent = `${n} ${n === 1 ? 'text' : 'texts'}`;
    renderText();
  }

  function renderText() {
    const text = editor.value;
    const chars = Array.from(text).length;
    card.classList.toggle('has-text', chars > 0);
    $('#counts').textContent = `${formatNumber(chars)} chars · ${formatNumber(countWords(text))} words`;
    const est = $('#estimate');
    est.replaceChildren();
    if (chars && state.settings.paceMode === 'duration') est.append('finish in ', h('b', {}, formatDuration(state.settings.targetMinutes * 60000)));
    else if (chars) est.append('≈ ', h('b', {}, formatDuration(estimateDurationMs(text, state.settings))));
    $('#clearText').disabled = !chars;
  }

  function renderPresets() {
    let matched = false;
    for (const b of presets.children) {
      const on = Number(b.dataset.wpm) === state.settings.wpm;
      matched ||= on;
      b.setAttribute('aria-checked', String(on));
    }
    presets.dataset.custom = String(!matched);
    presets.dataset.paced = String(state.settings.paceMode === 'duration');
  }

  function renderResume() {
    const s = state.lastSession;
    const doc = s && state.library.docs.find((d) => d.id === s.docId);
    const live = state.snapshot && ['arming', 'countdown', 'typing', 'paused'].includes(state.snapshot.state);
    const show = !!doc && !live && ['stopped', 'interrupted', 'error'].includes(s.state) &&
      s.offset > 0 && s.offset < s.total && textFingerprint(doc.text) === s.fingerprint;
    $('#resumeBanner').hidden = !show;
    if (!show) return;
    const pct = Math.floor((s.offset / s.total) * 100);
    $('#resumeTitle').textContent = `Left off at ${pct}%`;
    $('#resumeSub').textContent = `${s.state === 'interrupted' ? 'Interrupted' : 'Stopped'} ${relativeTime(s.at)} · ${doc.title}`;
    $('#resumeRing').style.strokeDashoffset = String(94.25 * (1 - s.offset / s.total));
  }

  subscribe((what) => {
    if (what === 'library') renderDoc();
    if (what === 'doc') { const n = state.library.docs.length; $('#docCount').textContent = `${n} ${n === 1 ? 'text' : 'texts'}`; }
    if (what === 'settings') { renderPresets(); renderText(); }
    if (what === 'session' || what === 'library') renderResume();
  });

  renderDoc();
  renderPresets();
  renderResume();
  return { focusEditor: () => editor.focus({ preventScroll: true }) };
}
