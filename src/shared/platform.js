// Small differences between Firefox and Chromium browsers, in one place.
import './browser-shim.js';

export const IS_FIREFOX = browser.runtime.getURL('').startsWith('moz-extension:');
export const BROWSER = IS_FIREFOX ? 'Firefox' : 'Your browser';

// Chrome only lets users change extension shortcuts on its own page.
export const CAN_EDIT_SHORTCUTS = typeof browser.commands?.update === 'function';
export const SHORTCUTS_PAGE = IS_FIREFOX ? 'about:addons' : 'chrome://extensions/shortcuts';
export const EXTENSIONS_PAGE = IS_FIREFOX ? 'about:addons' : `chrome://extensions/?id=${browser.runtime.id}`;

// Chrome's onMessage can't take a returned promise, so answer through
// sendResponse instead. `handler` returns a value, a promise, or undefined
// for "not mine".
export function onMessage(handler) {
  browser.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    const result = handler(msg, sender);
    if (result === undefined) return false;
    Promise.resolve(result).then(sendResponse, (err) => sendResponse({ ok: false, error: String(err?.message || err) }));
    return true;
  });
}
