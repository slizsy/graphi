// Graphi — background event page (Firefox MV3, non-persistent).
//
// Responsibilities:
//  • inject the typing runtime on demand (activeTab + scripting — no blanket
//    host access) and pick the frame that holds the caret
//  • route popup / keyboard-shortcut commands to the running session
//  • mirror the session on the toolbar badge
//  • remember where a session stopped so it can be resumed later, even after
//    the tab was reloaded or Firefox restarted
//
// The page may be suspended between events, so per-tab bookkeeping lives in
// storage.session rather than in module variables.

import {
  loadSettings, loadLibrary, activeDoc, saveLastSession, loadLastSession, textFingerprint,
  effectiveSettings, addReport,
} from '../shared/storage.js';
import { formatShortcut } from '../shared/format.js';

const CONTENT_FILES = ['content/engine.js', 'content/adapters.js', 'content/hud.js', 'content/content.js'];
const ACTIVE_STATES = new Set(['arming', 'countdown', 'typing', 'paused']);
const PROTECTED_HOSTS = new Set([
  'addons.mozilla.org', 'accounts.firefox.com', 'support.mozilla.org', 'discovery.addons.mozilla.org',
  'addons.cdn.mozilla.net', 'accounts-static.cdn.mozilla.net', 'api.accounts.firefox.com',
  'content.cdn.mozilla.net', 'install.mozilla.org', 'oauth.accounts.firefox.com',
  'profile.accounts.firefox.com', 'sync.services.mozilla.com',
]);

class UserError extends Error {}

// ---- Per-tab bookkeeping ----------------------------------------------------

const tabKey = (tabId) => `tab:${tabId}`;

async function getTabInfo(tabId) {
  const { [tabKey(tabId)]: info } = await browser.storage.session.get(tabKey(tabId));
  return info || null;
}

async function setTabInfo(tabId, info) {
  if (info) await browser.storage.session.set({ [tabKey(tabId)]: info });
  else await browser.storage.session.remove(tabKey(tabId));
}

// ---- Injection ----------------------------------------------------------------

function explainRestricted(url) {
  if (!url) return null;
  let u;
  try { u = new URL(url); } catch { return null; }
  if (['about:', 'moz-extension:', 'chrome:', 'resource:', 'view-source:', 'jar:'].includes(u.protocol)) {
    return "Firefox doesn't let extensions type on its built-in pages. Open a regular website first.";
  }
  if (PROTECTED_HOSTS.has(u.hostname)) {
    return `Firefox protects ${u.hostname}, so extensions can't type there.`;
  }
  if (/\.pdf($|\?)/i.test(u.pathname)) return "Firefox's PDF viewer doesn't accept typing from extensions.";
  return null;
}

async function hasAllSitesAccess() {
  return browser.permissions.contains({ origins: ['<all_urls>'] });
}

async function inject(tabId, allFrames) {
  try {
    await browser.scripting.executeScript({ target: { tabId, allFrames }, files: CONTENT_FILES });
  } catch (err) {
    const tab = await browser.tabs.get(tabId).catch(() => null);
    const restricted = explainRestricted(tab?.url);
    if (restricted) throw new UserError(restricted);
    if (/permission/i.test(String(err?.message))) {
      throw new UserError('Firefox hasn\'t granted access to this tab yet. Click the Graphi toolbar button (or use its shortcut) while on this page.');
    }
    throw new UserError("Graphi can't run on this page.");
  }
}

// Finds the frame where the caret is. Without all-sites access only the top
// frame (and its same-origin children) can be reached.
async function chooseFrame(tabId, settings) {
  const allFrames = await hasAllSitesAccess();
  await inject(tabId, allFrames);
  const results = await browser.scripting.executeScript({
    target: { tabId, allFrames },
    func: (docsMethod) => {
      const A = globalThis.__graphi?.Adapters;
      let editable = false;
      let inFrame = false;
      try {
        editable = !!A?.resolveFocused({ docsMethod });
      } catch {
        editable = true; // focused but unusable — let start() report why
      }
      const active = A?.deepActiveElement();
      if (active?.tagName === 'IFRAME' || active?.tagName === 'FRAME') {
        try { inFrame = !active.contentDocument; } catch { inFrame = true; }
      }
      return { hasFocus: document.hasFocus(), editable, inFrame };
    },
    args: [settings.docsMethod],
  });
  const frames = results.filter((r) => r && r.result).map((r) => ({ frameId: r.frameId ?? 0, ...r.result }));
  const pick = frames.find((f) => f.hasFocus && f.editable) || frames.find((f) => f.editable && f.frameId === 0) ||
    frames.find((f) => f.editable) || frames.find((f) => f.frameId === 0) || { frameId: 0 };
  if (!allFrames && !pick.editable && frames.find((f) => f.frameId === 0)?.inFrame) {
    throw new UserError('That field sits inside an embedded frame (as in Word for the web). Turn on "Embedded editors" in Graphi settings to type there.');
  }
  return pick.frameId;
}

// ---- Session control ---------------------------------------------------------------

async function shortcutLabels() {
  const [commands, platform] = await Promise.all([browser.commands.getAll(), browser.runtime.getPlatformInfo()]);
  const by = Object.fromEntries(commands.map((c) => [c.name, formatShortcut(c.shortcut, platform.os)]));
  return { toggle: by['toggle-typing'] || '', stop: by['stop-typing'] || '', open: by._execute_action || '' };
}

async function startTyping(tabId, { docId, offset = 0 } = {}) {
  const [settings, lib] = await Promise.all([loadSettings(), loadLibrary()]);
  const doc = docId ? lib.docs.find((d) => d.id === docId) : activeDoc(lib);
  if (!doc || !doc.text.trim()) throw new UserError('Add some text in Graphi first — there is nothing to type yet.');

  const current = await getStatus(tabId);
  if (current && ACTIVE_STATES.has(current.state)) throw new UserError('Graphi is already typing in this tab.');

  const frameId = await chooseFrame(tabId, settings);
  // In "finish in" mode the speed is solved for the part still to type, and
  // the content script keeps steering towards the deadline as it goes.
  const remaining = Array.from(doc.text).slice(Math.max(0, offset)).join('');
  const paced = effectiveSettings(remaining, settings);
  const res = await browser.tabs.sendMessage(tabId, {
    type: 'graphi:start',
    text: doc.text,
    offset,
    docId: doc.id,
    title: doc.title,
    settings: paced,
    deadlineMs: settings.paceMode === 'duration' ? settings.targetMinutes * 60000 : 0,
    incognito: !!(await browser.tabs.get(tabId).catch(() => null))?.incognito,
    fingerprint: textFingerprint(doc.text),
    shortcuts: await shortcutLabels(),
  }, { frameId });
  if (!res?.ok) throw new UserError(res?.error || 'Graphi could not start on this page.');
  await setTabInfo(tabId, { frameId, state: res.snapshot.state });
  await updateBadge(tabId, res.snapshot);
  return res.snapshot;
}

async function sendControl(tabId, type) {
  // Only talk to tabs we know host a session: messaging a tab without the
  // runtime makes Firefox log an "uncaught exception" even when handled.
  const info = await getTabInfo(tabId);
  if (!info) return null;
  try {
    return await browser.tabs.sendMessage(tabId, { type }, { frameId: info?.frameId ?? 0 });
  } catch {
    return null; // runtime not injected (or page navigated away)
  }
}

async function getStatus(tabId) {
  const res = await sendControl(tabId, 'graphi:status');
  return res?.snapshot ?? null;
}

async function showNotice(tabId, message) {
  try {
    await inject(tabId, false);
    await browser.tabs.sendMessage(tabId, { type: 'graphi:notice', message }, { frameId: 0 });
  } catch {
    // Can't draw on this page at all: flag it on the toolbar instead.
    await browser.action.setBadgeBackgroundColor({ tabId, color: '#FF5D6C' });
    await browser.action.setBadgeText({ tabId, text: '!' });
    await browser.action.setTitle({ tabId, title: `Graphi — ${message}` });
    setTimeout(() => {
      browser.action.setBadgeText({ tabId, text: '' }).catch(() => {});
      browser.action.setTitle({ tabId, title: 'Graphi' }).catch(() => {});
    }, 5000);
  }
}

// ---- Badge & recovery -------------------------------------------------------------

const lastSaved = new Map();

async function updateBadge(tabId, snap) {
  const map = {
    typing: [`${Math.floor(snap.progress * 100)}%`, '#D6FF3D'],
    paused: ['II', '#FFB547'],
    countdown: [String(snap.countdown || ''), '#8B6CFF'],
    arming: ['…', '#8B6CFF'],
    done: ['✓', '#D6FF3D'],
    error: ['!', '#FF5D6C'],
  };
  const [text, color] = map[snap?.state] || ['', '#D6FF3D'];
  try {
    await browser.action.setBadgeBackgroundColor({ tabId, color });
    await browser.action.setBadgeTextColor?.({ tabId, color: snap?.state === 'error' ? '#FFFFFF' : '#0A0B0D' });
    await browser.action.setBadgeText({ tabId, text });
  } catch { /* tab closed */ }
  if (snap?.state === 'done') {
    setTimeout(() => browser.action.setBadgeText({ tabId, text: '' }).catch(() => {}), 4000);
  }
}

async function recordProgress(tabId, snap, incognito = false) {
  if (!snap?.docId) return;
  const now = Date.now();
  const terminal = !ACTIVE_STATES.has(snap.state);
  if (!terminal && now - (lastSaved.get(tabId) || 0) < 1000) return;
  lastSaved.set(tabId, now);
  if (snap.state === 'arming' || snap.state === 'countdown') return;
  await saveLastSession({
    docId: snap.docId,
    title: snap.title,
    offset: snap.typed,
    total: snap.total,
    fingerprint: snap.fingerprint,
    state: snap.state,
    url: incognito ? '' : snap.url, // private windows leave no address behind
    at: now,
  });
}

async function onSessionUpdate(tabId, snap, incognito = false) {
  const info = await getTabInfo(tabId);
  if (ACTIVE_STATES.has(snap.state)) await setTabInfo(tabId, { frameId: info?.frameId ?? 0, state: snap.state });
  else await setTabInfo(tabId, null);
  await Promise.all([updateBadge(tabId, snap), recordProgress(tabId, snap, incognito)]);
}

// A reload or navigation silently kills the runtime; keep the resume point.
browser.tabs.onUpdated.addListener(async (tabId, change) => {
  if (change.status !== 'loading') return;
  const info = await getTabInfo(tabId);
  if (!info) return;
  await setTabInfo(tabId, null);
  await browser.action.setBadgeText({ tabId, text: '' }).catch(() => {});
  const last = await loadLastSession();
  if (last && ACTIVE_STATES.has(last.state)) await saveLastSession({ ...last, state: 'interrupted', at: Date.now() });
});

browser.tabs.onRemoved.addListener(async (tabId) => {
  const info = await getTabInfo(tabId);
  if (!info) return;
  await setTabInfo(tabId, null);
  const last = await loadLastSession();
  if (last && ACTIVE_STATES.has(last.state)) await saveLastSession({ ...last, state: 'interrupted', at: Date.now() });
});

// After a browser restart no session can still be running.
browser.runtime.onStartup.addListener(async () => {
  const last = await loadLastSession();
  if (last && ACTIVE_STATES.has(last.state)) await saveLastSession({ ...last, state: 'interrupted' });
});

// ---- Session reports --------------------------------------------------------

function openReport(id) {
  const url = browser.runtime.getURL(`report/report.html${id ? `?id=${encodeURIComponent(id)}` : ''}`);
  return browser.tabs.create({ url });
}

async function onReport(report, incognito = false) {
  if (!report || typeof report.keys !== 'string' || !Array.isArray(report.dts)) return;
  try {
    const settings = await loadSettings();
    if (incognito && !settings.privateReports) return;
    await addReport(incognito ? { ...report, host: 'Private window', private: true } : report);
    if (settings.autoReport && report.outcome === 'done') await openReport(report.id);
  } catch (err) {
    console.error('[Graphi] could not save report', err);
  }
}

// ---- Keyboard shortcuts ---------------------------------------------------------------

async function activeTabId() {
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  return tab?.id;
}

browser.commands.onCommand.addListener(async (command) => {
  const tabId = await activeTabId();
  if (tabId == null) return;
  try {
    if (command === 'toggle-typing') {
      const snap = await getStatus(tabId);
      if (snap && ACTIVE_STATES.has(snap.state)) await sendControl(tabId, 'graphi:toggle');
      else await startTyping(tabId);
    } else if (command === 'stop-typing') {
      const res = await sendControl(tabId, 'graphi:stop');
      if (!res?.ok) await showNotice(tabId, 'Nothing is being typed right now.');
    }
  } catch (err) {
    await showNotice(tabId, err instanceof UserError ? err.message : 'Graphi could not start on this page.');
    if (!(err instanceof UserError)) console.error('[Graphi]', err);
  }
});

// ---- Messages from popup and content ----------------------------------------------------

browser.runtime.onMessage.addListener((msg, sender) => {
  if (msg?.type === 'graphi:update' && sender.tab) {
    onSessionUpdate(sender.tab.id, msg.snapshot, sender.tab.incognito);
    return undefined;
  }
  if (msg?.type === 'graphi:report' && sender.tab) {
    onReport(msg.report, sender.tab.incognito);
    return undefined;
  }
  if (msg?.type === 'graphi:openReport' && sender.tab) {
    openReport(msg.id);
    return undefined;
  }
  // Control messages are only accepted from Graphi's own pages.
  if (!String(msg?.type).startsWith('popup:') || !String(sender.url).startsWith(browser.runtime.getURL(''))) {
    return undefined;
  }
  const handle = async () => {
    switch (msg?.type) {
      case 'popup:status': {
        const tab = await browser.tabs.get(msg.tabId).catch(() => null);
        return { snapshot: await getStatus(msg.tabId), restricted: explainRestricted(tab?.url) };
      }
      case 'popup:start':
        return { ok: true, snapshot: await startTyping(msg.tabId, { docId: msg.docId, offset: msg.offset }) };
      case 'popup:control': {
        const res = await sendControl(msg.tabId, `graphi:${msg.action}`);
        return { ok: !!res?.ok, snapshot: res?.snapshot ?? null };
      }
      case 'popup:shortcuts':
        return shortcutLabels();
      case 'popup:openReport':
        await openReport(msg.id);
        return { ok: true };
      default:
        return undefined;
    }
  };
  return handle().catch((err) => ({
    ok: false,
    error: err instanceof UserError ? err.message : 'Something went wrong. Reload the page and try again.',
    detail: String(err?.message || err),
  }));
});
