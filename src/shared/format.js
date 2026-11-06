// Display helpers shared by the popup and the background script.

const MAC_SYMBOLS = { Alt: '⌥', Shift: '⇧', Ctrl: '⌃', Command: '⌘', MacCtrl: '⌃' };

// "Alt+Shift+P" → "⌥⇧P" on macOS, "Alt+Shift+P" elsewhere.
export function formatShortcut(shortcut, os) {
  if (!shortcut) return '';
  if (os !== 'mac') return shortcut.replace('MacCtrl', 'Ctrl');
  return shortcut.split('+').map((p) => MAC_SYMBOLS[p] ?? p).join('');
}

export function shortcutParts(shortcut, os) {
  if (!shortcut) return [];
  return shortcut.split('+').map((p) => (os === 'mac' ? MAC_SYMBOLS[p] ?? p : p.replace('MacCtrl', 'Ctrl')));
}

export function formatNumber(n) {
  return Number(n || 0).toLocaleString();
}

export function relativeTime(ts) {
  const diff = Date.now() - ts;
  const m = Math.round(diff / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  if (d < 7) return `${d}d ago`;
  return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}
