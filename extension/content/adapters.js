/* Graphi — editor adapters.
 *
 * Each adapter knows how to put one keystroke into one kind of editor and
 * exposes the same small surface:
 *
 *   insert(ch)   type a printable character
 *   newline()    press Enter
 *   backspace()  delete one character before the caret
 *   alive()      is the target still in the page?
 *   saveCaret() / restoreCaret()   park and restore the caret around pauses
 *   focus()      give the target focus again
 *
 * Wherever possible we use document.execCommand('insertText'): the browser
 * then performs a real edit and fires *trusted* beforeinput/input events, so
 * React/Vue/Angular forms, rich-text frameworks and the native undo stack all
 * behave exactly as if the user had typed.
 */
(() => {
  'use strict';
  const NS = (globalThis.__graphi ??= {});
  if (NS.Adapters) return;

  class GraphiError extends Error {
    constructor(code, message) {
      super(message);
      this.code = code;
    }
  }

  const TEXT_INPUT_TYPES = new Set(['text', 'search', 'url', 'email', 'tel', 'password', '']);

  // ---- Key metadata -------------------------------------------------------

  const SHIFTED = {
    '~': ['Backquote', 192], '!': ['Digit1', 49], '@': ['Digit2', 50], '#': ['Digit3', 51],
    '$': ['Digit4', 52], '%': ['Digit5', 53], '^': ['Digit6', 54], '&': ['Digit7', 55],
    '*': ['Digit8', 56], '(': ['Digit9', 57], ')': ['Digit0', 48], '_': ['Minus', 173],
    '+': ['Equal', 61], '{': ['BracketLeft', 219], '}': ['BracketRight', 221], '|': ['Backslash', 220],
    ':': ['Semicolon', 59], '"': ['Quote', 222], '<': ['Comma', 188], '>': ['Period', 190], '?': ['Slash', 191],
  };
  const PLAIN = {
    '`': ['Backquote', 192], '-': ['Minus', 173], '=': ['Equal', 61], '[': ['BracketLeft', 219],
    ']': ['BracketRight', 221], '\\': ['Backslash', 220], ';': ['Semicolon', 59], "'": ['Quote', 222],
    ',': ['Comma', 188], '.': ['Period', 190], '/': ['Slash', 191], ' ': ['Space', 32],
  };
  const NAMED = { Enter: ['Enter', 13], Backspace: ['Backspace', 8], Tab: ['Tab', 9] };

  function keyInfo(key) {
    if (NAMED[key]) return { key, code: NAMED[key][0], keyCode: NAMED[key][1], shift: false };
    if (/^[a-z]$/.test(key)) return { key, code: `Key${key.toUpperCase()}`, keyCode: key.toUpperCase().charCodeAt(0), shift: false };
    if (/^[A-Z]$/.test(key)) return { key, code: `Key${key}`, keyCode: key.charCodeAt(0), shift: true };
    if (/^[0-9]$/.test(key)) return { key, code: `Digit${key}`, keyCode: key.charCodeAt(0), shift: false };
    if (SHIFTED[key]) return { key, code: SHIFTED[key][0], keyCode: SHIFTED[key][1], shift: true };
    if (PLAIN[key]) return { key, code: PLAIN[key][0], keyCode: PLAIN[key][1], shift: false };
    return { key, code: '', keyCode: 0, shift: false };
  }

  // Synthesises a key event in the target's own realm (matters for iframes).
  function keyEvent(target, type, key, extra = {}) {
    const win = target.ownerDocument?.defaultView ?? window;
    const info = keyInfo(key);
    const charCode = type === 'keypress' ? (extra.charCode ?? (key.length === 1 ? key.codePointAt(0) : 0)) : 0;
    const init = {
      key: info.key,
      code: info.code,
      keyCode: type === 'keypress' ? charCode || info.keyCode : info.keyCode,
      charCode,
      which: type === 'keypress' ? charCode || info.keyCode : info.keyCode,
      shiftKey: info.shift,
      bubbles: true,
      cancelable: true,
      composed: true,
      view: win,
    };
    const Ctor = win.KeyboardEvent || KeyboardEvent;
    // Returns true if the page cancelled (i.e. handled) the event.
    return !target.dispatchEvent(new Ctor(type, init));
  }

  // One key press with browser semantics: keydown, then keypress for keys
  // that produce input, then the default action — unless the page cancelled
  // the key (editors such as Draft.js, Quill and Monaco handle Enter on
  // keydown and cancel it), and finally keyup.
  function press(target, key, action, handledByPage = () => false) {
    let cancelled = keyEvent(target, 'keydown', key);
    if (!cancelled && (key.length === 1 || key === 'Enter')) {
      cancelled = keyEvent(target, 'keypress', key, key === 'Enter' ? { charCode: 13 } : {});
    }
    if (!cancelled && !handledByPage()) action();
    keyEvent(target, 'keyup', key);
  }

  // ---- Element helpers ------------------------------------------------------

  // Follows focus through shadow roots and same-origin frames to the element
  // that actually holds the caret.
  function deepActiveElement(doc = document) {
    let el = doc.activeElement;
    for (let guard = 0; el && guard < 16; guard++) {
      if (el.shadowRoot?.activeElement) {
        el = el.shadowRoot.activeElement;
      } else if (el.tagName === 'IFRAME' || el.tagName === 'FRAME') {
        let inner = null;
        try { inner = el.contentDocument; } catch { /* cross-origin */ }
        if (!inner) break;
        const next = inner.activeElement;
        if (!next || (next === inner.body && !next.isContentEditable && inner.designMode !== 'on')) break;
        el = next;
      } else {
        break;
      }
    }
    return el;
  }

  function isTextField(el) {
    if (!el) return false;
    if (el.tagName === 'TEXTAREA') return true;
    return el.tagName === 'INPUT' && TEXT_INPUT_TYPES.has((el.getAttribute('type') || '').toLowerCase());
  }

  function isRichEditable(el) {
    return !!el && (el.isContentEditable || el.ownerDocument?.designMode === 'on');
  }

  function describe(el) {
    if (!el) return 'field';
    if (el.tagName === 'TEXTAREA') return 'text area';
    if (el.tagName === 'INPUT') return `${el.type || 'text'} field`;
    return 'rich-text editor';
  }

  function assertWritable(el) {
    if (el.disabled) throw new GraphiError('readonly', 'That field is disabled.');
    if (el.readOnly) throw new GraphiError('readonly', 'That field is read-only.');
  }

  // ---- input / textarea -------------------------------------------------------

  class FieldAdapter {
    constructor(el) {
      this.el = el;
      this.doc = el.ownerDocument;
      this.kind = 'field';
      this.label = describe(el);
      this.multiline = el.tagName === 'TEXTAREA';
      this.saved = null;
      assertWritable(el);
    }

    alive() { return this.el.isConnected; }

    focus() {
      if (this.doc.activeElement !== this.el) this.el.focus({ preventScroll: true });
    }

    saveCaret() {
      try { this.saved = [this.el.selectionStart, this.el.selectionEnd]; } catch { this.saved = null; }
    }

    restoreCaret() {
      this.focus();
      if (!this.saved) return;
      try { this.el.setSelectionRange(this.saved[0], this.saved[1]); } catch { /* email/number fields */ }
    }

    _write(text, inputType) {
      assertWritable(this.el);
      this.focus();
      const before = this.el.value;
      const max = this.el.maxLength;
      if (inputType === 'insertText' && max >= 0 && before.length >= max && this._collapsed()) {
        throw new GraphiError('maxlength', `The field's ${max}-character limit was reached.`);
      }
      let done = false;
      try {
        done = this.doc.execCommand(inputType === 'deleteContentBackward' ? 'delete' : 'insertText', false, text);
      } catch { done = false; }
      if (!done || this.el.value === before) this._fallback(text, inputType);
      if (this.el.value === before) {
        if (inputType === 'deleteContentBackward') return; // nothing left to delete
        if (max >= 0 && before.length >= max) {
          throw new GraphiError('maxlength', `The field's ${max}-character limit was reached.`);
        }
        throw new GraphiError('rejected', 'The page refused the typed text.');
      }
    }

    _collapsed() {
      try { return this.el.selectionStart === this.el.selectionEnd; } catch { return true; }
    }

    // Direct value manipulation through the native setter, so framework value
    // trackers (React's in particular) still notice the change.
    _fallback(text, inputType) {
      const el = this.el;
      const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
      let start = el.value.length;
      let end = start;
      try {
        if (el.selectionStart != null) { start = el.selectionStart; end = el.selectionEnd; }
      } catch { /* selection unsupported on this input type */ }
      let value = el.value;
      let caret;
      if (inputType === 'deleteContentBackward') {
        if (start === end) {
          if (start === 0) return;
          const cut = Array.from(value.slice(0, start)).slice(-1)[0].length; // whole code point
          value = value.slice(0, start - cut) + value.slice(end);
          caret = start - cut;
        } else {
          value = value.slice(0, start) + value.slice(end);
          caret = start;
        }
      } else {
        value = value.slice(0, start) + text + value.slice(end);
        caret = start + text.length;
      }
      setter.call(el, value);
      try { el.setSelectionRange(caret, caret); } catch { /* ignore */ }
      const win = this.doc.defaultView;
      el.dispatchEvent(new win.InputEvent('input', { bubbles: true, inputType, data: inputType === 'insertText' ? text : null }));
    }

    // Some input masks write the character themselves during keydown without
    // cancelling it; the browser would then insert it a second time, so we
    // treat "the value already changed" like a handled key.
    _key(key, action) {
      const before = this.el.value;
      press(this.el, key, action, () => this.el.value !== before);
    }

    insert(ch) {
      this._key(ch.length === 1 ? ch : 'Unidentified', () => this._write(ch, 'insertText'));
    }

    newline() {
      // Single-line fields can't hold a line break; a space keeps words apart
      // instead of pressing Enter (which would submit the form).
      if (!this.multiline) return this._key(' ', () => this._write(' ', 'insertText'));
      this._key('Enter', () => this._write('\n', 'insertText'));
    }

    backspace() {
      this._key('Backspace', () => this._write('', 'deleteContentBackward'));
    }
  }

  // ---- contenteditable ------------------------------------------------------

  class RichAdapter {
    constructor(el) {
      this.doc = el.ownerDocument;
      // Use the outermost editing host: that's where editors listen.
      let host = el;
      while (host.parentElement?.isContentEditable) host = host.parentElement;
      this.el = host;
      this.kind = 'rich';
      this.label = describe(host);
      this.saved = null;
      this._remember();
    }

    alive() { return this.el.isConnected && isRichEditable(this.el); }

    _selection() { return this.doc.defaultView.getSelection(); }

    _remember() {
      const sel = this._selection();
      if (sel?.rangeCount && this.el.contains(sel.anchorNode)) this.saved = sel.getRangeAt(0).cloneRange();
    }

    focus() {
      const sel = this._selection();
      const inside = sel?.rangeCount && this.el.contains(sel.anchorNode);
      if (!this.el.contains(this.doc.activeElement) || !inside) {
        this.el.focus({ preventScroll: true });
        if (!inside) this.restoreCaret(false);
      }
    }

    saveCaret() { this._remember(); }

    restoreCaret(withFocus = true) {
      if (withFocus) this.el.focus({ preventScroll: true });
      const r = this.saved;
      if (!r || !this.el.contains(r.startContainer)) return;
      const sel = this._selection();
      sel.removeAllRanges();
      sel.addRange(r);
    }

    // Runs an editing command. Returns true if the edit happened *or* the page
    // was given the chance to handle it (textInput/beforeinput fired): editors
    // like Slate and Lexical cancel those events and apply the edit to their
    // own model, which makes execCommand report false — falling back then
    // would insert everything twice.
    _exec(command, value = null) {
      if (!this.alive()) throw new GraphiError('detached', 'The editor is no longer on the page.');
      this.focus();
      const win = this.doc.defaultView;
      let seen = false;
      const spy = () => { seen = true; };
      win.addEventListener('beforeinput', spy, true);
      win.addEventListener('textInput', spy, true);
      let ok = false;
      try { ok = this.doc.execCommand(command, false, value); } catch { ok = false; }
      win.removeEventListener('beforeinput', spy, true);
      win.removeEventListener('textInput', spy, true);
      this._remember();
      return ok || seen;
    }

    insert(ch) {
      press(this.el, ch.length === 1 ? ch : 'Unidentified', () => {
        if (!this._exec('insertText', ch)) this._manualInsert(ch);
      });
    }

    // Last resort when execCommand is unavailable: edit the DOM ourselves.
    _manualInsert(text) {
      const sel = this._selection();
      if (!sel?.rangeCount) throw new GraphiError('nocaret', 'Click where the text should go, then resume.');
      const range = sel.getRangeAt(0);
      range.deleteContents();
      const node = this.doc.createTextNode(text);
      range.insertNode(node);
      range.setStartAfter(node);
      range.collapse(true);
      sel.removeAllRanges();
      sel.addRange(range);
      this.el.dispatchEvent(new this.doc.defaultView.InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
      this._remember();
    }

    newline() {
      press(this.el, 'Enter', () => {
        if (!this._exec('insertParagraph') && !this._exec('insertLineBreak')) this._manualInsert('\n');
      });
    }

    backspace() {
      press(this.el, 'Backspace', () => this._exec('delete'));
    }
  }

  // ---- Google Docs / Slides --------------------------------------------------
  //
  // Docs paints the document on a <canvas>. Keystrokes reach it through a
  // hidden contenteditable inside `iframe.docs-texteventtarget-iframe`, and
  // Docs reacts to the events raised there. Which events it consumes has
  // changed over the years, so in "auto" mode we calibrate on the first
  // character: try one strategy at a time and watch whether Docs' own caret
  // moves. Strategies are ordered so a later one never double-types.

  const DOCS_STRATEGIES = ['keypress', 'textinput', 'execcommand'];

  class GoogleDocsAdapter {
    constructor(method = 'auto') {
      this.kind = 'docs';
      this.label = location.pathname.startsWith('/presentation/') ? 'Google Slides' : 'Google Docs';
      this.method = method === 'auto' ? null : method;
      if (!this._ctx()) {
        throw new GraphiError('docs', `Couldn't find the ${this.label} editor. Wait for it to finish loading, then try again.`);
      }
    }

    static detect() {
      return location.hostname === 'docs.google.com' &&
        /^\/(document|presentation)\//.test(location.pathname) &&
        !!document.querySelector('iframe.docs-texteventtarget-iframe');
    }

    _ctx() {
      const iframe = document.querySelector('iframe.docs-texteventtarget-iframe');
      let doc = null;
      try { doc = iframe?.contentDocument; } catch { /* ignore */ }
      if (!doc) return null;
      const target = doc.querySelector('[contenteditable="true"]') || doc.body;
      return target ? { iframe, doc, win: iframe.contentWindow, target } : null;
    }

    alive() { return !!this._ctx(); }
    saveCaret() {}
    restoreCaret() { this.focus(); }

    focus() {
      const ctx = this._ctx();
      if (!ctx) return;
      if (ctx.doc.activeElement !== ctx.target) {
        try { ctx.target.focus({ preventScroll: true }); } catch { /* ignore */ }
      }
    }

    _caretRect() {
      const c = document.querySelector('.kix-cursor-caret') || document.querySelector('.kix-cursor');
      if (!c) return null;
      const r = c.getBoundingClientRect();
      return r.width || r.height ? `${Math.round(r.left)},${Math.round(r.top)}` : null;
    }

    _send(strategy, ch) {
      const ctx = this._ctx();
      if (!ctx) throw new GraphiError('docs', `${this.label} is no longer ready for input.`);
      const { doc, win, target } = ctx;
      if (strategy === 'execcommand') {
        this.focus();
        keyEvent(target, 'keydown', ch);
        doc.execCommand('insertText', false, ch);
        keyEvent(target, 'keyup', ch);
        return;
      }
      keyEvent(target, 'keydown', ch);
      keyEvent(target, 'keypress', ch);
      if (strategy === 'textinput') {
        const ev = doc.createEvent('TextEvent');
        ev.initTextEvent('textInput', true, true, win, ch);
        target.dispatchEvent(ev);
      }
      keyEvent(target, 'keyup', ch);
    }

    async _calibrate(ch) {
      const before = this._caretRect();
      if (!before) {
        // No visible caret to observe (e.g. Slides, or a hidden cursor):
        // use the sequence known to work with current Docs builds.
        this.method = 'textinput';
        this._send(this.method, ch);
        return;
      }
      for (const strategy of DOCS_STRATEGIES) {
        this._send(strategy, ch);
        for (let t = 0; t < 8; t++) {
          await new Promise((r) => setTimeout(r, 40));
          const now = this._caretRect();
          if (now && now !== before) {
            this.method = strategy;
            return;
          }
        }
      }
      throw new GraphiError('docs', `${this.label} didn't accept the keystrokes. Click inside the document so the cursor blinks, then try again.`);
    }

    async insert(ch) {
      if (!this.method) return this._calibrate(ch);
      this._send(this.method, ch);
    }

    _named(key) {
      const ctx = this._ctx();
      if (!ctx) throw new GraphiError('docs', `${this.label} is no longer ready for input.`);
      keyEvent(ctx.target, 'keydown', key);
      if (key === 'Enter' && this.method === 'keypress') keyEvent(ctx.target, 'keypress', key, { charCode: 13 });
      keyEvent(ctx.target, 'keyup', key);
    }

    newline() { this._named('Enter'); }
    backspace() { this._named('Backspace'); }
  }

  // ---- Resolution -------------------------------------------------------------

  function adapterFor(el, settings = {}) {
    if (GoogleDocsAdapter.detect()) return new GoogleDocsAdapter(settings.docsMethod);
    if (!el) return null;
    if (isTextField(el)) return new FieldAdapter(el);
    if (el.tagName === 'INPUT') {
      throw new GraphiError('unsupported', `Graphi can't type into a ${el.type} field. Pick a text field instead.`);
    }
    if (isRichEditable(el)) return new RichAdapter(el);
    return null;
  }

  // The adapter for wherever the caret is right now, or null if nothing
  // editable has focus.
  function resolveFocused(settings) {
    if (GoogleDocsAdapter.detect()) return new GoogleDocsAdapter(settings.docsMethod);
    return adapterFor(deepActiveElement(), settings);
  }

  function isEditableTarget(el) {
    return isTextField(el) || isRichEditable(el);
  }

  NS.Adapters = { resolveFocused, adapterFor, deepActiveElement, isEditableTarget, GraphiError, GoogleDocsAdapter, keyInfo };
})();
