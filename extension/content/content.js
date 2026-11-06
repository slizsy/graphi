/* Graphi — content runtime.
 *
 * Injected on demand (activeTab + scripting). Owns one typing session per
 * frame and reports its state to the background script, which mirrors it on
 * the toolbar badge and relays it to the popup.
 *
 *   idle → arming → countdown → typing ⇄ paused → done | stopped | error
 */
(() => {
  'use strict';
  const NS = (globalThis.__graphi ??= {});
  if (NS.runtimeReady) return;
  NS.runtimeReady = true;

  const { Engine, Adapters, Hud } = NS;
  const { GraphiError } = Adapters;
  const ACTIVE = new Set(['arming', 'countdown', 'typing', 'paused']);
  const MODIFIERS = new Set(['Shift', 'Control', 'Alt', 'Meta', 'CapsLock', 'OS', 'AltGraph', 'Fn']);

  let session = null;
  let hud = null;
  let lastReportId = null;

  const getHud = () => (hud ??= new Hud((act) => handleHudAction(act)));

  // ---- Session ----------------------------------------------------------------

  class Session {
    constructor({ text, offset = 0, docId, title, settings, fingerprint, shortcuts, deadlineMs = 0, incognito = false }) {
      this.incognito = incognito;
      this.deadlineMs = deadlineMs;
      this.reportId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`; // randomUUID is HTTPS-only
      this.text = text;
      this.docId = docId;
      this.title = title;
      this.fingerprint = fingerprint;
      this.settings = settings;
      this.shortcuts = shortcuts || {};
      this.state = 'idle';
      this.adapter = null;
      this.plan = Engine.createPlan(text, { startOffset: offset, getSettings: () => this.settings });
      this.startOffset = this.plan.offset;
      this.done = this.startOffset; // characters actually in the page
      this.dirty = 0; // mistyped keys on the page that are not yet corrected
      this.countdown = 0;
      this.pauseReason = '';
      this.hint = '';
      this.error = '';
      this.startedAt = 0;
      this.activeMs = 0;
      this.activeSince = 0;
      this.keyTimes = [];
      this.resumeWaiter = null;
      this.timer = 0;
      this.wake = null;
      this.lastBroadcast = 0;
      this.autoPausedHidden = false;
      // Keystroke log for the session report: one entry per key that reached
      // the page, plus the pauses between them.
      this.rec = { keys: [], dts: [], typos: [], pauses: [], lastKeyAt: 0, pausedAt: 0, firstAt: 0 };
      this.reported = false;
      // Scheduled breaks: typing time between breaks varies ±20% each time.
      this.breakMs = 0;
      this.breakUntil = 0;
      this.nextBreakAt = this.planNextBreak(0);
    }

    // Typing time so far, excluding scheduled breaks.
    typingMs() {
      return this.elapsedActive() - this.breakMs - (this.breakUntil ? Math.max(0, performance.now() - this.breakStartedAt) : 0);
    }

    // Break interval and length in ms. The _ms keys exist only so tests can
    // run breaks in seconds; the UI never sets them.
    breakEveryMs() { return this.settings._breakEveryMs ?? this.settings.breakEvery * 60000; }
    breakLengthMs() { return this.settings._breakLengthMs ?? this.settings.breakLength * 60000; }

    planNextBreak(fromMs) {
      const every = this.breakEveryMs();
      return every > 0 ? fromMs + every * (0.8 + Math.random() * 0.4) : Infinity;
    }

    // Breaks start between words, never in the middle of one.
    breakDue(lastCh) {
      if (!(this.breakEveryMs() > 0) || !/\s/.test(lastCh || '')) return false;
      if (this.nextBreakAt === Infinity) this.nextBreakAt = this.planNextBreak(this.typingMs());
      return this.typingMs() >= this.nextBreakAt && this.done < this.total;
    }

    async takeBreak() {
      const ms = Math.round(this.breakLengthMs() * (0.8 + Math.random() * 0.4));
      const at = this.rec.keys.length;
      this.breakStartedAt = performance.now();
      this.breakUntil = Date.now() + ms;
      this.publish(true);
      await this.sleep(ms);
      const took = performance.now() - this.breakStartedAt;
      this.breakMs += took;
      this.breakUntil = 0;
      // The break is logged as a pause, not as one very slow key.
      if (this.rec.firstAt) {
        this.rec.pauses.push([at, Math.round(took), 'break']);
        this.rec.lastKeyAt += took;
      }
      this.nextBreakAt = this.planNextBreak(this.typingMs());
      this.publish(true);
    }

    skipBreak() {
      if (this.breakUntil) this.interrupt();
    }

    get total() { return this.plan.total; }
    get typed() { return this.done; }

    snapshot() {
      const progress = this.total ? this.typed / this.total : 1;
      return {
        state: this.state,
        typed: this.typed,
        total: this.total,
        progress,
        wpm: this.liveWpm(),
        eta: this.eta(),
        countdown: this.countdown,
        pauseReason: this.pauseReason,
        hint: this.hint,
        error: this.error,
        target: this.adapter?.label || '',
        docId: this.docId,
        title: this.title,
        fingerprint: this.fingerprint,
        elapsed: this.elapsedActive(),
        breakLeft: this.breakUntil ? Math.max(0, this.breakUntil - Date.now()) : 0,
        shortcuts: this.shortcuts,
        url: location.href,
        hasReport: this.reported,
        paced: !!this.deadlineMs && this.settings.paceMode === 'duration',
      };
    }

    elapsedActive() {
      return this.activeMs + (this.activeSince ? performance.now() - this.activeSince : 0);
    }

    // Rolling words-per-minute over the last ~40 keystrokes.
    liveWpm() {
      const t = this.keyTimes;
      if (t.length < 6) return null;
      const span = t[t.length - 1] - t[0];
      return span > 0 ? Math.round(((t.length - 1) / 5) / (span / 60000)) : null;
    }

    eta() {
      const done = this.typed - this.startOffset;
      const left = this.total - this.typed;
      if (done < 12 || this.state !== 'typing') {
        if (this.state !== 'typing' && this.state !== 'paused') return null;
        return left * (60000 / (this.settings.wpm * 5)) * 1.12;
      }
      return (this.elapsedActive() / done) * left;
    }

    record(step) {
      const r = this.rec;
      const now = performance.now();
      if (!r.firstAt) { r.firstAt = now; r.lastKeyAt = now; r.wallStart = Date.now(); }
      r.dts.push(Math.round(now - r.lastKeyAt));
      r.lastKeyAt = now;
      if (step.kind === 'backspace') r.keys.push('\b');
      else {
        if (!step.commit) r.typos.push(r.keys.length);
        r.keys.push(step.ch);
      }
    }

    recordBreak(step) {
      if (step.reason === 'thinking') this.rec.pauses.push([this.rec.keys.length, step.ms, 'thinking']);
    }

    // "Finish in" mode: every few keys, compare the projected finish with the
    // deadline and nudge the speed so the session lands on time.
    steerPace() {
      if (!this.deadlineMs || this.settings.paceMode !== 'duration') return;
      const done = this.done - this.startOffset;
      const span = this.total - this.startOffset;
      if (done < 20 || done % 15 !== 0 || done >= span) return;
      const elapsed = this.elapsedActive();
      const left = this.deadlineMs - elapsed;
      if (left <= 0) { this.settings = { ...this.settings, wpm: 250 }; return; }
      const projected = (elapsed / done) * (span - done);
      const factor = Math.min(1.12, Math.max(0.88, projected / left));
      const wpm = Math.round(Math.min(250, Math.max(10, this.settings.wpm * factor)));
      if (wpm !== this.settings.wpm) this.settings = { ...this.settings, wpm };
    }

    // Builds the session report once the session ends. Only sent when at
    // least one key reached the page.
    report() {
      if (this.reported || !this.rec.keys.length) return;
      if (this.incognito && !this.settings.privateReports) return;
      this.reported = true;
      lastReportId = this.reportId;
      const r = this.rec;
      let host = '';
      try { host = new URL(location.href).hostname; } catch { /* opaque origin */ }
      browser.runtime.sendMessage({
        type: 'graphi:report',
        report: {
          id: this.reportId,
          docId: this.docId,
          title: this.title,
          host,
          target: this.adapter?.label || '',
          outcome: this.state,
          startedAt: r.wallStart,
          endedAt: Date.now(),
          activeMs: Math.round(this.elapsedActive() - this.breakMs),
          breakMs: Math.round(this.breakMs),
          startOffset: this.startOffset,
          endOffset: this.done,
          total: this.total,
          settings: {
            wpm: this.settings.wpm, variability: this.settings.variability, typoRate: this.settings.typoRate,
            correction: this.settings.correction, thinkingBreaks: this.settings.thinkingBreaks,
            punctuationPauses: this.settings.punctuationPauses, paceMode: this.settings.paceMode,
            breakEvery: this.settings.breakEvery, breakLength: this.settings.breakLength,
            targetMinutes: this.settings.targetMinutes,
          },
          keys: r.keys.join(''),
          dts: r.dts,
          typos: r.typos,
          pauses: r.pauses,
        },
      }).catch(() => {});
    }

    setState(state, extra = {}) {
      if (state === 'paused' && this.state === 'typing') this.rec.pausedAt = performance.now();
      if (state !== 'paused' && this.state === 'paused' && this.rec.pausedAt && this.rec.firstAt) {
        // Hold time is excluded from the key gaps and logged as a pause instead.
        const held = performance.now() - this.rec.pausedAt;
        this.rec.pauses.push([this.rec.keys.length, Math.round(held), this.autoPausedHidden ? 'background' : 'hold']);
        this.rec.lastKeyAt += held;
        this.rec.pausedAt = 0;
      }
      if (this.state === 'typing' && state !== 'typing') {
        this.activeMs += performance.now() - this.activeSince;
        this.activeSince = 0;
      }
      if (state === 'typing' && this.state !== 'typing') this.activeSince = performance.now();
      Object.assign(this, extra);
      this.state = state;
      if (['done', 'stopped', 'error'].includes(state)) this.report();
      this.publish(true);
    }

    publish(force = false) {
      const now = performance.now();
      if (!force && now - this.lastBroadcast < 220) return;
      this.lastBroadcast = now;
      const snap = this.snapshot();
      if (this.settings.showHud) getHud().render(snap);
      else hud?.hide();
      browser.runtime.sendMessage({ type: 'graphi:update', snapshot: snap }).catch(() => {});
    }

    // An interruptible sleep: pause/stop wake it up early.
    sleep(ms) {
      return new Promise((resolve) => {
        this.wake = resolve;
        this.timer = setTimeout(resolve, ms);
      });
    }

    interrupt() {
      clearTimeout(this.timer);
      this.wake?.();
      this.wake = null;
    }

    tryResolveTarget() {
      return Adapters.resolveFocused(this.settings);
    }

    // Wait for the user to click into an editable field.
    waitForTarget() {
      return new Promise((resolve) => {
        // Give up after two minutes without a click; stop() also cancels this wait.
        const deadline = setTimeout(() => this.stop(), 120_000);
        const onFocus = () => {
          setTimeout(() => {
            if (this.state !== 'arming') return finish(null);
            try {
              const adapter = this.tryResolveTarget();
              if (adapter) finish(adapter);
            } catch (err) {
              this.fail(err);
              finish(null);
            }
          }, 0);
        };
        const finish = (adapter) => {
          clearTimeout(deadline);
          document.removeEventListener('focusin', onFocus, true);
          document.removeEventListener('click', onFocus, true);
          this.cancelArming = null;
          resolve(adapter);
        };
        this.cancelArming = () => finish(null);
        document.addEventListener('focusin', onFocus, true);
        document.addEventListener('click', onFocus, true);
      });
    }

    async runCountdown() {
      let n = this.settings.countdown;
      this.skipCountdown = false;
      while (n > 0 && !this.skipCountdown) {
        this.setState('countdown', { countdown: n });
        await this.sleep(1000);
        if (this.state !== 'countdown') return false;
        n -= 1;
      }
      if (!['idle', 'arming', 'countdown'].includes(this.state)) return false;
      this.adapter.restoreCaret();
      this.startedAt = Date.now();
      this.setState('typing');
      return true;
    }

    async run() {
      // Keys are scheduled against an absolute clock so timer latency and the
      // cost of each edit don't accumulate into a slower-than-asked speed.
      let clock = performance.now();
      try {
        while (true) {
          if (this.state === 'paused') {
            await new Promise((r) => (this.resumeWaiter = r));
            clock = performance.now();
          }
          if (this.state !== 'typing') return;
          const step = this.plan.next();
          if (step.kind === 'done') break;
          clock += step.kind === 'pause' ? step.ms : step.delay;
          const now = performance.now();
          if (clock < now - 250) clock = now; // throttled tab: don't burst to catch up
          await this.sleep(Math.max(0, clock - now));
          if (this.state === 'paused') {
            // Re-run the same step after resuming.
            await new Promise((r) => (this.resumeWaiter = r));
            clock = performance.now();
            if (this.state !== 'typing') return;
          }
          if (this.state !== 'typing') return;
          if (step.kind === 'pause') { this.recordBreak(step); continue; }
          if (!this.adapter.alive()) throw new GraphiError('detached', 'The text field is no longer on the page.');
          this.typing = true;
          try {
            if (step.kind === 'backspace') await this.adapter.backspace();
            else if (step.ch === '\n') await this.adapter.newline();
            else await this.adapter.insert(step.ch);
          } finally {
            this.typing = false;
          }
          if (step.commit) this.done = step.offset;
          else if (step.kind === 'type') this.dirty += 1;
          else if (step.kind === 'backspace') this.dirty = Math.max(0, this.dirty - 1);
          this.record(step);
          if (step.commit) this.steerPace();
          this.keyTimes.push(performance.now());
          if (this.keyTimes.length > 40) this.keyTimes.shift();
          this.publish();
          if (step.commit && this.breakDue(step.ch)) {
            await this.takeBreak();
            this.keyTimes.length = 0; // don't average the break into the live speed
            clock = performance.now();
          }
        }
        this.setState('done');
        detachGuards();
        session = null;
      } catch (err) {
        this.fail(err);
      }
    }

    fail(err) {
      console.warn('[Graphi]', err);
      const message = err instanceof GraphiError ? err.message : 'The page stopped accepting text. Click back into the field and resume from the popup.';
      this.interrupt();
      this.setState('error', { error: message });
      detachGuards();
      session = null;
    }

    pause(reason = '', hint = '') {
      if (this.state !== 'typing') return false;
      this.adapter.saveCaret();
      this.interrupt();
      this.setState('paused', { pauseReason: reason, hint });
      return true;
    }

    resume() {
      if (this.state !== 'paused') return false;
      try {
        if (!this.adapter.alive()) throw new GraphiError('detached', 'The text field is no longer on the page.');
        this.adapter.restoreCaret();
      } catch (err) {
        this.fail(err);
        return false;
      }
      this.setState('typing', { pauseReason: '', hint: '' });
      this.autoPausedHidden = false;
      const r = this.resumeWaiter;
      this.resumeWaiter = null;
      r?.();
      return true;
    }

    // If a simulated typo is on screen when the user stops, erase it so the
    // page holds exactly the text typed so far and resume joins up cleanly.
    cleanUpMistake() {
      if (!this.dirty || !this.adapter?.alive()) return;
      try {
        if (this.state === 'paused') this.adapter.restoreCaret();
        for (; this.dirty > 0; this.dirty--) { this.adapter.backspace(); this.record({ kind: 'backspace' }); }
      } catch { /* best effort */ }
    }

    stop() {
      if (!ACTIVE.has(this.state)) return false;
      this.cancelArming?.();
      this.interrupt();
      this.cleanUpMistake();
      this.setState('stopped');
      const r = this.resumeWaiter;
      this.resumeWaiter = null;
      r?.();
      detachGuards();
      session = null;
      return true;
    }
  }

  // ---- Page guards: user takeover, Esc, hidden tab ----------------------------

  function fromHud(e) {
    const path = e.composedPath?.() || [];
    return path.some((n) => hud?.contains(n));
  }

  function onUserKey(e) {
    if (!session || !e.isTrusted || fromHud(e)) return;
    if (e.key === 'Escape' && session.settings.escToStop && ACTIVE.has(session.state)) {
      e.preventDefault();
      e.stopPropagation();
      session.stop();
      return;
    }
    if (session.state === 'typing' && session.settings.pauseOnInteraction && !MODIFIERS.has(e.key)) {
      // A real keystroke from the user: hand control back and swallow it so
      // it doesn't land in the middle of the text.
      e.preventDefault();
      e.stopPropagation();
      session.pause('You pressed a key', resumeHint());
    }
  }

  function onUserPointer(e) {
    if (!session || !e.isTrusted || fromHud(e)) return;
    if (session.state === 'typing' && session.settings.pauseOnInteraction) {
      session.pause('You clicked the page', resumeHint());
    }
  }

  function resumeHint() {
    return session?.adapter?.kind === 'docs'
      ? 'Put the cursor where typing should continue, then resume.'
      : 'Typing continues exactly where it left off.';
  }

  function onVisibility() {
    if (!session || !session.settings.pauseWhenHidden) return;
    if (document.hidden && session.state === 'typing') {
      session.pause('Tab in background');
      session.autoPausedHidden = true;
    } else if (!document.hidden && session.state === 'paused' && session.autoPausedHidden) {
      setTimeout(() => session?.autoPausedHidden && session.resume(), 350);
    }
  }

  const guardedDocs = new Set();
  function attachGuards() {
    const docs = [document];
    // Docs/Slides route keystrokes through a same-origin iframe; watch it too.
    for (const f of document.querySelectorAll('iframe')) {
      try { if (f.contentDocument) docs.push(f.contentDocument); } catch { /* cross-origin */ }
    }
    for (const d of docs) {
      if (guardedDocs.has(d)) continue;
      d.addEventListener('keydown', onUserKey, true);
      d.addEventListener('mousedown', onUserPointer, true);
      d.addEventListener('touchstart', onUserPointer, true);
      guardedDocs.add(d);
    }
    document.addEventListener('visibilitychange', onVisibility);
  }

  function detachGuards() {
    for (const d of guardedDocs) {
      d.removeEventListener('keydown', onUserKey, true);
      d.removeEventListener('mousedown', onUserPointer, true);
      d.removeEventListener('touchstart', onUserPointer, true);
    }
    guardedDocs.clear();
    document.removeEventListener('visibilitychange', onVisibility);
  }

  // ---- Commands -------------------------------------------------------------------

  function handleHudAction(act) {
    if (act === 'dismiss') return hud?.hide();
    if (act === 'report') {
      browser.runtime.sendMessage({ type: 'graphi:openReport', id: lastReportId }).catch(() => {});
      return hud?.hide();
    }
    if (!session) return;
    if (act === 'pause') session.pause('', resumeHint());
    else if (act === 'resume') session.resume();
    else if (act === 'stop') session.stop();
    else if (act === 'skipbreak') session.skipBreak();
    else if (act === 'skip') { session.skipCountdown = true; session.interrupt(); }
  }

  function start(msg) {
    if (session && ACTIVE.has(session.state)) {
      return { ok: false, error: 'Graphi is already typing on this page.', snapshot: session.snapshot() };
    }
    const text = String(msg.text || '');
    if (!text.trim()) return { ok: false, error: 'There is no text to type yet.' };
    session = new Session(msg);
    if (session.typed >= session.total) {
      session = null;
      return { ok: false, error: 'That text has already been fully typed.' };
    }
    attachGuards();
    // Fail fast on obviously unusable targets (disabled field, number input…).
    try {
      session.adapter = session.tryResolveTarget();
    } catch (err) {
      session.adapter = null;
      session = null;
      detachGuards();
      return { ok: false, error: err.message };
    }
    const s = session;
    (async () => {
      try {
        if (!s.adapter) {
          s.setState('arming');
          s.adapter = await s.waitForTarget();
          if (!s.adapter) return;
        }
        if (await s.runCountdown()) await s.run();
      } catch (err) {
        s.fail(err);
      }
    })();
    return { ok: true, snapshot: s.snapshot() };
  }

  // Live-tune the running session when the user changes settings.
  browser.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes.settings || !session) return;
    const next = changes.settings.newValue || {};
    const paced = session.deadlineMs && next.paceMode === 'duration';
    // In "finish in" mode the session steers its own speed; the slider doesn't.
    session.settings = { ...session.settings, ...next, ...(paced ? { wpm: session.settings.wpm } : {}) };
    if (!paced) session.deadlineMs = 0;
    if ('breakEvery' in next) session.nextBreakAt = session.planNextBreak(session.typingMs());
    if (!session.settings.showHud) hud?.hide();
    session.publish(true);
  });

  browser.runtime.onMessage.addListener((msg) => {
    switch (msg?.type) {
      case 'graphi:probe': {
        let editable = false;
        try { editable = !!Adapters.resolveFocused(msg.settings || {}); } catch { editable = true; }
        return Promise.resolve({ hasFocus: document.hasFocus(), editable, busy: !!session && ACTIVE.has(session.state) });
      }
      case 'graphi:start':
        return Promise.resolve(start(msg));
      case 'graphi:status':
        return Promise.resolve({ snapshot: session ? session.snapshot() : null });
      case 'graphi:pause':
        return Promise.resolve({ ok: !!session?.pause('', resumeHint()), snapshot: session?.snapshot() ?? null });
      case 'graphi:resume':
        return Promise.resolve({ ok: !!session?.resume(), snapshot: session?.snapshot() ?? null });
      case 'graphi:toggle': {
        if (!session) return Promise.resolve({ ok: false, snapshot: null });
        if (session.state === 'typing') session.pause('', resumeHint());
        else if (session.state === 'paused') session.resume();
        else if (session.state === 'countdown') { session.skipCountdown = true; session.interrupt(); }
        return Promise.resolve({ ok: true, snapshot: session?.snapshot() ?? null });
      }
      case 'graphi:stop': {
        const snap = session?.snapshot() ?? null;
        const ok = !!session?.stop();
        return Promise.resolve({ ok, snapshot: ok ? { ...snap, state: 'stopped' } : snap });
      }
      case 'graphi:notice':
        getHud().render({ state: 'notice', message: msg.message, progress: 0 });
        return Promise.resolve({ ok: true });
      default:
        return undefined;
    }
  });
})();
