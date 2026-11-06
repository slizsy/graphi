// Graphi is written against the promise-based `browser.*` API. Firefox has it
// built in; Chrome and other Chromium browsers offer the same promise APIs
// under `chrome.*`, so point one at the other. Works as a module import and
// as a plain content script.
globalThis.browser ??= globalThis.chrome;
