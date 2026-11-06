// Popup state: a thin, observable layer over storage plus the live session
// snapshot for the current tab. Writes are debounced but always flushed
// before anything that depends on them (starting a session, closing).

import {
  loadSettings, saveSettings, loadLibrary, saveLibrary, loadLastSession, clearLastSession,
  newDoc, activeDoc, sanitizeSettings,
} from '../shared/storage.js';

const listeners = new Set();
let saveTimer = 0;
let pendingLibrary = false;
let pendingSettings = null;

export const state = {
  settings: null,
  library: null,
  lastSession: null,
  tabId: null,
  snapshot: null,
  restricted: null,
  os: 'win',
  embedded: false,
};

export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function emit(what) {
  for (const fn of listeners) fn(what);
}

export async function init() {
  const [settings, library, lastSession, platform, embedded] = await Promise.all([
    loadSettings(), loadLibrary(), loadLastSession(), browser.runtime.getPlatformInfo(),
    browser.permissions.contains({ origins: ['<all_urls>'] }),
  ]);
  Object.assign(state, { settings, library, lastSession, os: platform.os, embedded });
}

function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flush, 280);
}

export async function flush() {
  clearTimeout(saveTimer);
  const jobs = [];
  if (pendingLibrary) {
    pendingLibrary = false;
    jobs.push(saveLibrary(state.library));
  }
  if (pendingSettings) {
    const patch = pendingSettings;
    pendingSettings = null;
    jobs.push(saveSettings(patch));
  }
  await Promise.all(jobs);
}

// ---- Settings ---------------------------------------------------------------

export function setSettings(patch, { immediate = false } = {}) {
  state.settings = sanitizeSettings({ ...state.settings, ...patch });
  pendingSettings = { ...(pendingSettings || {}), ...patch };
  emit('settings');
  if (immediate) return flush();
  scheduleSave();
}

export function replaceSettings(settings) {
  state.settings = settings;
  emit('settings');
}

// ---- Library -----------------------------------------------------------------

export const currentDoc = () => activeDoc(state.library);

export function ensureDoc() {
  let doc = currentDoc();
  if (!doc) {
    doc = newDoc('Untitled', '');
    state.library.docs.unshift(doc);
    state.library.activeId = doc.id;
    pendingLibrary = true;
    emit('library');
  }
  return doc;
}

export function updateDoc(id, patch) {
  const doc = state.library.docs.find((d) => d.id === id);
  if (!doc) return;
  Object.assign(doc, patch, { updatedAt: Date.now() });
  pendingLibrary = true;
  emit('doc');
  scheduleSave();
}

export function selectDoc(id) {
  state.library.activeId = id;
  pendingLibrary = true;
  emit('library');
  scheduleSave();
}

export function createDoc(title = 'Untitled', text = '') {
  const doc = newDoc(title, text);
  state.library.docs.unshift(doc);
  state.library.activeId = doc.id;
  pendingLibrary = true;
  emit('library');
  scheduleSave();
  return doc;
}

export function removeDoc(id) {
  const docs = state.library.docs;
  const index = docs.findIndex((d) => d.id === id);
  if (index < 0) return null;
  const [doc] = docs.splice(index, 1);
  const wasActive = state.library.activeId === id;
  if (wasActive) state.library.activeId = docs[0]?.id ?? null;
  pendingLibrary = true;
  emit('library');
  scheduleSave();
  return { doc, index, wasActive };
}

export function restoreDoc({ doc, index, wasActive }) {
  state.library.docs.splice(Math.min(index, state.library.docs.length), 0, doc);
  if (wasActive) state.library.activeId = doc.id;
  pendingLibrary = true;
  emit('library');
  scheduleSave();
}

// ---- Session -----------------------------------------------------------------

export function setSnapshot(snapshot) {
  state.snapshot = snapshot;
  emit('session');
}

export async function dismissLastSession() {
  state.lastSession = null;
  await clearLastSession();
  emit('session');
}

export async function refreshLastSession() {
  state.lastSession = await loadLastSession();
  emit('session');
}
