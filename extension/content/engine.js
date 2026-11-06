/* Graphi — typing engine.
 *
 * Pure logic, no DOM. Turns a text plus the user's settings into a stream of
 * steps: type a character, press backspace, or pause. Timing is computed
 * lazily, step by step, from a live settings getter so speed changes made
 * while a session runs take effect immediately.
 *
 * Offsets are measured in Unicode code points so emoji and other astral
 * characters are never split in half.
 */
(() => {
  'use strict';
  const NS = (globalThis.__graphi ??= {});
  if (NS.Engine) return;

  // QWERTY neighbours for believable slips.
  const NEIGHBOURS = {
    q: 'wa', w: 'qeas', e: 'wrds', r: 'etdf', t: 'ryfg', y: 'tugh', u: 'yihj',
    i: 'uojk', o: 'ipkl', p: 'ol', a: 'qwsz', s: 'awedxz', d: 'serfcx',
    f: 'drtgvc', g: 'ftyhbv', h: 'gyujnb', j: 'huikmn', k: 'jiolm', l: 'kop',
    z: 'asx', x: 'zsdc', c: 'xdfv', v: 'cfgb', b: 'vghn', n: 'bhjm', m: 'njk',
  };

  const BREAK_PROBABILITY = {
    off: { word: 0, sentence: 0 },
    occasional: { word: 0.012, sentence: 0.07 },
    frequent: { word: 0.035, sentence: 0.18 },
  };

  const isLetter = (ch) => /^\p{L}$/u.test(ch);
  const isAsciiLetter = (ch) => /^[a-z]$/i.test(ch);
  const isUpper = (ch) => ch !== ch.toLowerCase() && ch === ch.toUpperCase();
  const isSpace = (ch) => ch === ' ' || ch === '\t' || ch === '\n';

  function gaussian(rng) {
    let u = 0;
    while (u === 0) u = rng();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rng());
  }

  const between = (rng, lo, hi) => lo + (hi - lo) * rng();

  function createPlan(text, { startOffset = 0, getSettings, rng = Math.random } = {}) {
    const chars = Array.from(String(text).replace(/\r\n?/g, '\n'));
    const total = chars.length;
    let index = Math.min(Math.max(0, startOffset | 0), total); // next source char to commit
    const queue = [];
    let drift = 1;
    let prevTyped = index > 0 ? chars[index - 1] : '';

    // Base delay before typing `ch`, given the previous character typed.
    function keyDelay(ch, prev, s) {
      const base = 60000 / (s.wpm * 5);
      let mult = 1;
      if (isUpper(ch)) mult *= 1.25;
      else if (/\d/.test(ch)) mult *= 1.3;
      else if (!isLetter(ch) && !isSpace(ch)) mult *= 1.4;
      else if (ch === ' ') mult *= 0.9;
      if (ch === prev && isLetter(ch)) mult *= 0.8;
      if (s.speedDrift) mult *= drift;
      const sigma = (s.variability / 100) * 0.55;
      const jitter = sigma > 0 ? Math.exp(gaussian(rng) * sigma) : 1;
      return clampDelay(base * mult * Math.min(3, Math.max(0.35, jitter)));
    }

    // Extra breath after punctuation and line breaks.
    function rhythmPause(prev, ch, s) {
      if (!s.punctuationPauses || !prev) return 0;
      const tempo = Math.sqrt(75 / s.wpm);
      if (prev === '\n') return (ch === '\n' ? 0 : between(rng, 450, 1300)) * tempo;
      if (/[.!?…]/.test(prev) && isSpace(ch)) return between(rng, 280, 850) * tempo;
      if (/[,;:]/.test(prev) && isSpace(ch)) return (60000 / (s.wpm * 5)) * between(rng, 1.4, 3);
      return 0;
    }

    function clampDelay(ms) {
      return Math.max(8, Math.round(ms));
    }

    function maybeThinkingBreak(i, s) {
      const p = BREAK_PROBABILITY[s.thinkingBreaks] ?? BREAK_PROBABILITY.off;
      if (!p.word) return 0;
      const ch = chars[i];
      const prev = chars[i - 1];
      if (i === 0 || isSpace(ch) || !isSpace(prev)) return 0; // only at word starts
      const sentenceStart = /[.!?…]\s*$/.test(chars.slice(Math.max(0, i - 3), i).join(''));
      const chance = sentenceStart ? p.sentence : p.word;
      if (rng() >= chance) return 0;
      // Log-uniform between ~1.1s and ~4.5s: mostly short, sometimes long.
      return Math.round(Math.exp(between(rng, Math.log(1100), Math.log(4500))));
    }

    function wrongKeyFor(ch) {
      const lower = ch.toLowerCase();
      const pool = NEIGHBOURS[lower];
      if (!pool) return null;
      const pick = pool[Math.floor(rng() * pool.length)];
      return isUpper(ch) ? pick.toUpperCase() : pick;
    }

    // Builds the keystrokes for a mistake at `i`, followed by its correction.
    function planMistake(i, s) {
      const ch = chars[i];
      const roll = rng();
      let wrong = null;
      if (roll < 0.62) {
        const w = wrongKeyFor(ch);
        if (w) wrong = [w];
      } else if (roll < 0.8) {
        wrong = [ch, ch]; // double tap
      } else if (i + 1 < total && isLetter(chars[i + 1]) && chars[i + 1] !== ch) {
        wrong = [chars[i + 1], ch]; // transposition
      }
      if (!wrong) return false;

      // How many more correct keys slip out before the mistake is noticed.
      let late = 0;
      if (s.correction === 'natural') {
        const r = rng();
        late = r < 0.45 ? 0 : r < 0.75 ? 1 : r < 0.92 ? 2 : 3;
      }
      const start = i + (wrong.length === 2 && wrong[0] !== ch ? 2 : 1);
      const extra = [];
      for (let j = start; j < total && extra.length < late; j++) {
        if (chars[j] === '\n') break;
        extra.push(chars[j]);
      }

      let prev = prevTyped;
      for (const k of [...wrong, ...extra]) {
        queue.push({ kind: 'type', ch: k, delay: keyDelay(k, prev, s), commit: false });
        prev = k;
      }
      const tempo = Math.sqrt(75 / s.wpm);
      queue.push({ kind: 'pause', ms: Math.round(between(rng, 220, 650) * tempo), reason: 'notice' });
      const erase = wrong.length + extra.length;
      const bsBase = Math.max(35, (60000 / (s.wpm * 5)) * 0.55);
      for (let n = 0; n < erase; n++) {
        queue.push({ kind: 'backspace', delay: clampDelay(bsBase * between(rng, 0.75, 1.35)) });
      }
      queue.push({ kind: 'pause', ms: Math.round(between(rng, 120, 320) * tempo), reason: 'recover' });
      return true;
    }

    function refill() {
      const s = getSettings();
      const ch = chars[index];
      if (s.speedDrift && (index === 0 || isSpace(chars[index - 1]))) {
        // Slow random walk around 1.0, re-centred so it never runs away.
        drift = Math.min(1.22, Math.max(0.82, drift + gaussian(rng) * 0.045 + (1 - drift) * 0.15));
      }
      const think = maybeThinkingBreak(index, s);
      if (think) queue.push({ kind: 'pause', ms: think, reason: 'thinking' });

      if (s.typoRate > 0 && isAsciiLetter(ch) && rng() < s.typoRate / 100 && planMistake(index, s)) {
        // Mistake keystrokes are queued; the correct key follows below.
      }
      const pause = rhythmPause(prevTyped, ch, s);
      const delay = keyDelay(ch, prevTyped, s) + Math.round(pause);
      queue.push({ kind: 'type', ch, delay, commit: true });
    }

    return {
      total,
      get offset() { return index; },
      next() {
        if (!queue.length) {
          if (index >= total) return { kind: 'done' };
          refill();
        }
        const step = queue.shift();
        if (step.kind === 'type') {
          if (step.commit) {
            index += 1;
            step.offset = index; // source position once this key has landed
          }
          prevTyped = step.ch;
        }
        return step;
      },
      // Fraction of the work done, for progress and ETA.
      progress() { return total ? index / total : 1; },
    };
  }

  NS.Engine = { createPlan };
})();
