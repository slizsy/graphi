// Settings view: shortcuts (with an in-place recorder backed by
// commands.update), behaviour toggles, compatibility and reset.

import { $, $$, h, toast, bindSegmented, setSegmented } from '../components/ui.js';
import { state, subscribe, setSettings, replaceSettings } from '../store.js';
import { resetSettings } from '../../shared/storage.js';
import { shortcutParts } from '../../shared/format.js';

const COMMAND_LABELS = {
  'toggle-typing': 'Start · pause · resume',
  'stop-typing': 'Stop typing',
  _execute_action: 'Open Graphi',
};
const ORDER = ['toggle-typing', 'stop-typing', '_execute_action'];

const KEY_NAMES = {
  Comma: 'Comma', Period: 'Period', Space: 'Space', Home: 'Home', End: 'End', PageUp: 'PageUp',
  PageDown: 'PageDown', Insert: 'Insert', Delete: 'Delete', ArrowUp: 'Up', ArrowDown: 'Down',
  ArrowLeft: 'Left', ArrowRight: 'Right',
};

// Translates a keydown into Firefox's shortcut syntax, or null if invalid.
function comboFromEvent(e, os) {
  let key = null;
  if (/^Key[A-Z]$/.test(e.code)) key = e.code.slice(3);
  else if (/^Digit[0-9]$/.test(e.code)) key = e.code.slice(5);
  else if (/^F([1-9]|1[0-2])$/.test(e.code)) key = e.code;
  else if (KEY_NAMES[e.code]) key = KEY_NAMES[e.code];
  if (!key) return null;
  const mods = [];
  if (e.altKey) mods.push('Alt');
  if (os === 'mac') {
    if (e.metaKey) mods.push('Command');
    if (e.ctrlKey) mods.push('MacCtrl');
  } else if (e.ctrlKey) mods.push('Ctrl');
  if (e.shiftKey) mods.push('Shift');
  const primary = mods.filter((m) => m !== 'Shift');
  if (/^F\d+$/.test(key) && mods.length === 0) return key;
  if (primary.length < 1 || primary.length > 2 || mods.length > 3) return null;
  return [...mods, key].join('+');
}

export function initSettings() {
  const box = $('#shortcuts');
  let recording = null;

  async function renderShortcuts() {
    const commands = await browser.commands.getAll();
    const byName = Object.fromEntries(commands.map((c) => [c.name, c]));
    box.replaceChildren(...ORDER.filter((n) => byName[n]).map((name) => {
      const parts = shortcutParts(byName[name].shortcut, state.os);
      const btn = h('button', { class: 'keys', title: 'Click to change', dataset: { command: name } },
        parts.length ? parts.map((p) => h('kbd', {}, p)) : h('span', { class: 'unset' }, 'Not set'));
      return h('div', { class: 'shortcut-row' }, h('span', {}, COMMAND_LABELS[name] || name), btn);
    }));
    box.dataset.ready = 'true';
  }

  function stopRecording() {
    if (!recording) return;
    recording.classList.remove('recording');
    recording = null;
    document.removeEventListener('keydown', onRecordKey, true);
    $('#shortcutNote').textContent = 'Click a shortcut to record a new one. Use at least one of Alt or Ctrl.';
    renderShortcuts();
  }

  async function onRecordKey(e) {
    if (!recording) return;
    e.preventDefault();
    e.stopPropagation();
    if (['Shift', 'Control', 'Alt', 'Meta'].includes(e.key)) return;
    const name = recording.dataset.command;
    if (e.key === 'Escape') return stopRecording();
    if (e.key === 'Backspace' && !e.altKey && !e.ctrlKey && !e.metaKey) {
      await browser.commands.reset(name);
      toast('Shortcut reset to default');
      return stopRecording();
    }
    const combo = comboFromEvent(e, state.os);
    if (!combo) {
      $('#shortcutNote').textContent = 'That combination isn’t allowed. Try Alt or Ctrl with a letter or number.';
      return;
    }
    try {
      await browser.commands.update({ name, shortcut: combo });
      toast(`Shortcut set to ${shortcutParts(combo, state.os).join(state.os === 'mac' ? '' : '+')}`);
    } catch (err) {
      toast('Firefox rejected that shortcut — it may already be taken.', { tone: 'error' });
    }
    stopRecording();
  }

  box.addEventListener('click', (e) => {
    const btn = e.target.closest('.keys');
    if (!btn) return;
    if (recording === btn) return stopRecording();
    stopRecording();
    recording = btn;
    btn.classList.add('recording');
    btn.replaceChildren(h('span', { class: 'rec' }, 'PRESS KEYS'));
    $('#shortcutNote').textContent = 'Press the new combination. Esc cancels, Backspace restores the default.';
    document.addEventListener('keydown', onRecordKey, true);
  });

  for (const id of ['pauseOnInteraction', 'escToStop', 'pauseWhenHidden', 'showHud', 'autoReport', 'privateReports']) {
    $(`#${id}`).addEventListener('change', (e) => setSettings({ [id]: e.target.checked }));
  }
  for (const seg of $$('#view-settings .segmented')) {
    bindSegmented(seg, (value) => setSettings({ [seg.dataset.setting]: value }));
  }

  // Optional all-sites access, only needed for editors inside cross-origin
  // frames. permissions.request must run synchronously in the gesture.
  $('#allFrames').addEventListener('change', (e) => {
    const origins = ['<all_urls>'];
    const op = e.target.checked ? browser.permissions.request({ origins }) : browser.permissions.remove({ origins });
    op.then((ok) => {
      state.embedded = e.target.checked ? ok : !ok;
      e.target.checked = state.embedded;
      if (ok) toast(state.embedded ? 'Embedded editors enabled' : 'All-sites access removed');
    }).catch(() => { e.target.checked = state.embedded; });
  });
  browser.permissions.onAdded?.addListener(syncPermission);
  browser.permissions.onRemoved?.addListener(syncPermission);
  async function syncPermission() {
    state.embedded = await browser.permissions.contains({ origins: ['<all_urls>'] });
    $('#allFrames').checked = state.embedded;
  }

  $('#resetSettings').addEventListener('click', async () => {
    const previous = { ...state.settings };
    replaceSettings(await resetSettings());
    toast('Settings restored to defaults', {
      action: { label: 'Undo', run: () => setSettings(previous, { immediate: true }) },
    });
  });

  // Private windows need the user's own "Run in Private Windows" permission.
  async function renderPrivate() {
    const allowed = await browser.extension.isAllowedIncognitoAccess();
    $('#privateCard').dataset.allowed = String(allowed);
    const st = $('#privateState');
    st.textContent = allowed ? 'Allowed' : 'Not allowed';
    st.className = `pill-state mono ${allowed ? 'on' : 'off'}`;
    $('#privateReports').disabled = !allowed;
  }
  $('#addonsKey').textContent = state.os === 'mac' ? '⌘ ⇧ A' : 'Ctrl ⇧ A';
  $('#copyAddons').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText('about:addons');
      toast('Copied — paste it into the address bar');
    } catch {
      toast('Type about:addons into the address bar');
    }
  });
  renderPrivate();

  $('#version').textContent = `v${browser.runtime.getManifest().version}`;

  function render() {
    const s = state.settings;
    for (const id of ['pauseOnInteraction', 'escToStop', 'pauseWhenHidden', 'showHud', 'autoReport', 'privateReports']) $(`#${id}`).checked = s[id];
    for (const seg of $$('#view-settings .segmented')) setSegmented(seg, s[seg.dataset.setting]);
    $('#allFrames').checked = state.embedded;
  }

  subscribe((what) => what === 'settings' && render());
  render();
  renderShortcuts();
  return { renderShortcuts, stopRecording };
}
