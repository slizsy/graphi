// Tune view: speed, human feel, mistakes and start delay. Every control
// writes straight to settings; a running session picks changes up live.

import { $, $$, bindSegmented, setSegmented, paintSlider, animateNumber } from '../components/ui.js';
import { state, subscribe, setSettings, currentDoc } from '../store.js';
import { LIMITS, wpmForDuration } from '../../shared/storage.js';

export function initTune() {
  const wpm = $('#wpm');
  const variability = $('#variability');
  const typoRate = $('#typoRate');

  wpm.addEventListener('input', () => setSettings({ wpm: Number(wpm.value) }));
  variability.addEventListener('input', () => setSettings({ variability: Number(variability.value) }));
  typoRate.addEventListener('input', () => setSettings({ typoRate: Number(typoRate.value) }));

  for (const b of $$('.step-btn[data-step]')) {
    b.addEventListener('click', () => {
      // Snap to the next multiple of 5 in the chosen direction.
      const w = state.settings.wpm;
      const next = Number(b.dataset.step) > 0 ? (Math.floor(w / 5) + 1) * 5 : (Math.ceil(w / 5) - 1) * 5;
      setSettings({ wpm: Math.min(LIMITS.wpm[1], Math.max(LIMITS.wpm[0], next)) });
    });
  }

  // "Finish in" target: steppers move by a sensible amount for the scale.
  const clampMins = (m) => Math.min(LIMITS.targetMinutes[1], Math.max(LIMITS.targetMinutes[0], m));
  for (const b of $$('.step-btn[data-mins]')) {
    b.addEventListener('click', () => {
      const m = state.settings.targetMinutes;
      const up = Number(b.dataset.mins) > 0;
      const step = (up ? m >= 60 : m > 60) ? 15 : (up ? m >= 20 : m > 20) ? 5 : 1;
      setSettings({ targetMinutes: clampMins(m + (up ? step : -step)) });
    });
  }
  $('#minChips').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-m]');
    if (b) setSettings({ targetMinutes: Number(b.dataset.m) });
  });

  function renderPace() {
    const s = state.settings;
    $('#paceCard').dataset.mode = s.paceMode;
    const mins = s.targetMinutes;
    animateNumber($('#minsValue'), mins);
    for (const b of $$('#minChips button')) b.setAttribute('aria-pressed', String(Number(b.dataset.m) === mins));
    const note = $('#paceNote');
    const text = currentDoc()?.text || '';
    note.classList.remove('warn');
    if (!text.trim()) { note.textContent = 'Add text in Compose to see the speed needed.'; return; }
    const { wpm, reachable } = wpmForDuration(text, s, mins * 60000);
    note.replaceChildren();
    if (!reachable && wpm === LIMITS.wpm[1]) {
      note.classList.add('warn');
      note.textContent = 'Too long for that time — it will run at the 250 wpm limit.';
    } else if (!reachable) {
      note.classList.add('warn');
      note.textContent = 'Short text — even 10 wpm finishes early.';
    } else {
      const b = document.createElement('b');
      b.textContent = `${wpm} wpm`;
      note.append('≈ ', b, ' average · speed adapts to land on time');
    }
  }

  for (const id of ['speedDrift', 'punctuationPauses']) {
    $(`#${id}`).addEventListener('change', (e) => setSettings({ [id]: e.target.checked }));
  }

  for (const seg of $$('#view-tune .segmented')) {
    bindSegmented(seg, (value) => setSettings({ [seg.dataset.setting]: value }));
  }

  function render() {
    const s = state.settings;
    if (document.activeElement !== wpm) wpm.value = s.wpm;
    variability.value = s.variability;
    typoRate.value = s.typoRate;
    [wpm, variability, typoRate].forEach(paintSlider);
    animateNumber($('#wpmValue'), s.wpm);
    $('#msPerKey').textContent = `${Math.round(60000 / (s.wpm * 5))} ms / key`;
    $('#variabilityValue').textContent = `${s.variability}%`;
    $('#typoRateValue').textContent = s.typoRate ? `${s.typoRate}%` : 'Off';
    $('#speedDrift').checked = s.speedDrift;
    $('#punctuationPauses').checked = s.punctuationPauses;
    for (const seg of $$('#view-tune .segmented')) setSegmented(seg, s[seg.dataset.setting]);
    $('#correctionField .segmented').classList.toggle('disabled', !s.typoRate);
    $('#breakLengthField .segmented').classList.toggle('disabled', !s.breakEvery);
  }

  subscribe((what) => {
    if (what === 'settings') { render(); renderPace(); }
    if ((what === 'doc' || what === 'library') && document.getElementById('app').dataset.view === 'tune') renderPace();
    if (what === 'view:tune') renderPace();
  });
  renderPace();
  render();
}
