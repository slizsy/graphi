// Persistent state shared by the popup and the background script.
// Everything lives in storage.local, so it survives browser restarts and
// extension reloads. The content script receives what it needs by message and
// listens to storage.onChanged for live tuning.

export const KEYS = Object.freeze({
  settings: 'settings',
  library: 'library',
  lastSession: 'lastSession',
  reports: 'reports',
  stats: 'stats',
});

export const DEFAULT_SETTINGS = Object.freeze({
  wpm: 75,                    // average words per minute (5 chars / word)
  variability: 35,            // keystroke timing jitter, 0–100
  speedDrift: true,           // tempo wanders slowly, like a real typist
  typoRate: 2,                // % of letters mistyped (then corrected)
  correction: 'natural',      // 'instant' | 'natural' (notices a few keys later)
  punctuationPauses: true,    // breathe after commas, sentences, paragraphs
  thinkingBreaks: 'occasional', // 'off' | 'occasional' | 'frequent'
  countdown: 3,               // seconds before typing starts
  pauseOnInteraction: true,   // pause when the user clicks or types in the page
  pauseWhenHidden: true,      // pause while the tab is in the background
  escToStop: true,            // Esc in the page stops the session
  showHud: true,              // floating on-page control panel
  docsMethod: 'auto',         // Google Docs input strategy
  breakEvery: 0,              // minutes of typing between scheduled breaks (0 = off)
  breakLength: 2,             // minutes per scheduled break
  paceMode: 'wpm',            // 'wpm': fixed speed · 'duration': finish in targetMinutes
  targetMinutes: 10,          // used when paceMode is 'duration'
  autoReport: false,          // open the session report when typing finishes
  privateReports: false,      // keep reports of sessions typed in private windows
});

export const LIMITS = Object.freeze({
  wpm: [10, 250],
  variability: [0, 100],
  typoRate: [0, 8],
  targetMinutes: [1, 600],
  maxTextLength: 200_000,
});

export const SPEED_PRESETS = Object.freeze([
  { id: 'calm', label: 'Calm', wpm: 45 },
  { id: 'natural', label: 'Natural', wpm: 75 },
  { id: 'brisk', label: 'Brisk', wpm: 110 },
  { id: 'blitz', label: 'Blitz', wpm: 160 },
]);

const WELCOME_TEXT =
  'Graphi types this text for you, one keystroke at a time.\n\n' +
  'Click into any text field, Google Doc or slide, then press Start — or use Alt+Shift+P without opening this popup. ' +
  'Pause, resume or stop at any moment from the floating panel on the page.';

const clamp = (v, [lo, hi]) => Math.min(hi, Math.max(lo, v));

export function sanitizeSettings(raw) {
  const s = { ...DEFAULT_SETTINGS, ...(raw && typeof raw === 'object' ? raw : {}) };
  s.wpm = Math.round(clamp(Number(s.wpm) || DEFAULT_SETTINGS.wpm, LIMITS.wpm));
  s.variability = Math.round(clamp(Number(s.variability) || 0, LIMITS.variability));
  s.typoRate = clamp(Number(s.typoRate) || 0, LIMITS.typoRate);
  if (!['instant', 'natural'].includes(s.correction)) s.correction = DEFAULT_SETTINGS.correction;
  if (!['off', 'occasional', 'frequent'].includes(s.thinkingBreaks)) s.thinkingBreaks = DEFAULT_SETTINGS.thinkingBreaks;
  if (![0, 3, 5, 10].includes(Number(s.countdown))) s.countdown = DEFAULT_SETTINGS.countdown;
  s.countdown = Number(s.countdown);
  if (!['auto', 'textinput', 'keypress', 'execcommand'].includes(s.docsMethod)) s.docsMethod = 'auto';
  if (!['wpm', 'duration'].includes(s.paceMode)) s.paceMode = 'wpm';
  s.breakEvery = [0, 10, 15, 20, 30, 45, 60].includes(Number(s.breakEvery)) ? Number(s.breakEvery) : 0;
  s.breakLength = [1, 2, 5, 10].includes(Number(s.breakLength)) ? Number(s.breakLength) : DEFAULT_SETTINGS.breakLength;
  s.targetMinutes = Math.round(clamp(Number(s.targetMinutes) || DEFAULT_SETTINGS.targetMinutes, LIMITS.targetMinutes));
  for (const k of ['speedDrift', 'punctuationPauses', 'pauseOnInteraction', 'pauseWhenHidden', 'escToStop', 'showHud', 'autoReport', 'privateReports']) {
    s[k] = Boolean(s[k]);
  }
  return s;
}

export async function loadSettings() {
  const { [KEYS.settings]: raw } = await browser.storage.local.get(KEYS.settings);
  return sanitizeSettings(raw);
}

export async function saveSettings(patch) {
  const next = sanitizeSettings({ ...(await loadSettings()), ...patch });
  await browser.storage.local.set({ [KEYS.settings]: next });
  return next;
}

export async function resetSettings() {
  await browser.storage.local.set({ [KEYS.settings]: { ...DEFAULT_SETTINGS } });
  return { ...DEFAULT_SETTINGS };
}

// ---- Library -------------------------------------------------------------

export function newDoc(title = 'Untitled', text = '') {
  const now = Date.now();
  return { id: crypto.randomUUID(), title, text, createdAt: now, updatedAt: now };
}

function sanitizeLibrary(raw) {
  const docs = Array.isArray(raw?.docs)
    ? raw.docs.filter((d) => d && typeof d.id === 'string').map((d) => ({
        id: d.id,
        title: String(d.title ?? 'Untitled').slice(0, 120),
        text: String(d.text ?? '').slice(0, LIMITS.maxTextLength),
        createdAt: Number(d.createdAt) || Date.now(),
        updatedAt: Number(d.updatedAt) || Date.now(),
      }))
    : [];
  let activeId = typeof raw?.activeId === 'string' ? raw.activeId : null;
  if (!docs.some((d) => d.id === activeId)) activeId = docs[0]?.id ?? null;
  return { docs, activeId };
}

export async function loadLibrary() {
  const { [KEYS.library]: raw } = await browser.storage.local.get(KEYS.library);
  let lib = sanitizeLibrary(raw);
  if (!raw) {
    // First run: seed a short guide so the popup is never a blank slate.
    const doc = newDoc('Welcome to Graphi', WELCOME_TEXT);
    lib = { docs: [doc], activeId: doc.id };
    await saveLibrary(lib);
  }
  return lib;
}

export async function saveLibrary(lib) {
  const clean = sanitizeLibrary(lib);
  await browser.storage.local.set({ [KEYS.library]: clean });
  return clean;
}

export function activeDoc(lib) {
  return lib.docs.find((d) => d.id === lib.activeId) ?? null;
}

// ---- Session recovery ----------------------------------------------------

export async function loadLastSession() {
  const { [KEYS.lastSession]: s } = await browser.storage.local.get(KEYS.lastSession);
  return s && typeof s === 'object' ? s : null;
}

export async function saveLastSession(s) {
  await browser.storage.local.set({ [KEYS.lastSession]: s });
}

export async function clearLastSession() {
  await browser.storage.local.remove(KEYS.lastSession);
}

// Cheap, stable fingerprint so we only offer "resume" when the text the
// session was typing has not been edited since.
export function textFingerprint(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return `${text.length}:${(h >>> 0).toString(36)}`;
}

// ---- Estimates -------------------------------------------------------------

export function countWords(text) {
  const m = text.trim().match(/\S+/g);
  return m ? m.length : 0;
}

// Rough duration for the whole text at the given settings, including the
// average cost of pauses and typo corrections, so the estimate is honest.
export function estimateDurationMs(text, settings) {
  const chars = Array.from(text).length;
  if (!chars) return 0;
  const perChar = 60000 / (settings.wpm * 5);
  let ms = chars * perChar;
  if (settings.punctuationPauses) {
    const sentences = (text.match(/[.!?](\s|$)/g) || []).length;
    const commas = (text.match(/[,;:]/g) || []).length;
    const paragraphs = (text.match(/\n/g) || []).length;
    const tempo = Math.sqrt(75 / settings.wpm);
    ms += sentences * 600 * tempo + commas * perChar * 2.2 + paragraphs * 900 * tempo;
  }
  const letters = (text.match(/\p{L}/gu) || []).length;
  ms += letters * (settings.typoRate / 100) * (perChar * 4 + 450);
  const breaks = { off: 0, occasional: 0.02, frequent: 0.06 }[settings.thinkingBreaks] ?? 0;
  ms += countWords(text) * breaks * 2600;
  if (settings.breakEvery > 0) ms += Math.floor(ms / (settings.breakEvery * 60000)) * settings.breakLength * 60000;
  return ms;
}

export function formatDuration(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
}

// "Finish in N minutes": the speed that makes the estimate land on target,
// found by bisection because pauses and typos don't scale linearly with WPM.
// Returns { wpm, reachable } — reachable is false when even the speed limits
// can't hit the target (the text is too long or too short for it).
export function wpmForDuration(text, settings, targetMs) {
  const [lo0, hi0] = LIMITS.wpm;
  const est = (wpm) => estimateDurationMs(text, { ...settings, wpm });
  if (!text.trim()) return { wpm: settings.wpm, reachable: true };
  if (est(hi0) > targetMs) return { wpm: hi0, reachable: false };
  if (est(lo0) < targetMs) return { wpm: lo0, reachable: false };
  let lo = lo0;
  let hi = hi0;
  for (let i = 0; i < 24; i++) {
    const mid = (lo + hi) / 2;
    if (est(mid) > targetMs) lo = mid; else hi = mid;
  }
  return { wpm: Math.round((lo + hi) / 2), reachable: true };
}

// Settings with the pace mode resolved to a concrete speed.
export function effectiveSettings(text, settings) {
  if (settings.paceMode !== 'duration') return settings;
  return { ...settings, wpm: wpmForDuration(text, settings, settings.targetMinutes * 60000).wpm };
}

// ---- Session reports -----------------------------------------------------

export const MAX_REPORTS = 30;

export async function loadReports() {
  const { [KEYS.reports]: list } = await browser.storage.local.get(KEYS.reports);
  return Array.isArray(list) ? list : [];
}

export async function saveReports(list) {
  await browser.storage.local.set({ [KEYS.reports]: list.slice(0, MAX_REPORTS) });
}

export async function loadStats() {
  const { [KEYS.stats]: s } = await browser.storage.local.get(KEYS.stats);
  return { sessions: 0, chars: 0, keys: 0, activeMs: 0, corrections: 0, since: Date.now(), ...(s || {}) };
}

// Adds a finished session's report and folds it into the lifetime totals.
export async function addReport(report) {
  const [list, stats] = await Promise.all([loadReports(), loadStats()]);
  const entry = { id: crypto.randomUUID(), ...report };
  const backspaces = (report.keys.match(/\x08/g) || []).length;
  await Promise.all([
    saveReports([entry, ...list]),
    browser.storage.local.set({
      [KEYS.stats]: {
        ...stats,
        sessions: stats.sessions + 1,
        chars: stats.chars + Math.max(0, report.endOffset - report.startOffset),
        keys: stats.keys + report.keys.length,
        activeMs: stats.activeMs + report.activeMs,
        corrections: stats.corrections + backspaces,
      },
    }),
  ]);
  return entry;
}
