// Small, dependency-free UI building blocks used across the popup views.

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

// Inline SVG icon from a path list (stroke icons, 16px grid).
export function icon(paths, { fill = false } = {}) {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('aria-hidden', 'true');
  for (const d of [].concat(paths)) {
    const p = document.createElementNS(ns, 'path');
    p.setAttribute('d', d);
    if (fill) p.setAttribute('fill', 'currentColor');
    svg.append(p);
  }
  return svg;
}

// ---- Toasts --------------------------------------------------------------------

export function toast(message, { tone = 'info', action = null, duration = 3200 } = {}) {
  const host = $('#toasts');
  const el = h('div', { class: `toast ${tone === 'error' ? 'error' : ''}`, role: tone === 'error' ? 'alert' : 'status' },
    h('span', { class: 't-dot' }),
    h('span', { class: 'toast-msg' }, message));
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    el.classList.add('out');
    setTimeout(() => el.remove(), 230);
  };
  if (action) {
    el.append(h('button', { class: 'toast-act', onclick: () => { close(); action.run(); } }, action.label));
  }
  // Keep at most two toasts on screen.
  while (host.children.length >= 2) host.firstElementChild.remove();
  host.append(el);
  setTimeout(close, action ? Math.max(duration, 5000) : duration);
  return close;
}

// ---- Segmented control -------------------------------------------------------------

export function bindSegmented(root, onChange) {
  const isNumber = root.dataset.type === 'number';
  root.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-value]');
    if (!btn) return;
    const value = isNumber ? Number(btn.dataset.value) : btn.dataset.value;
    setSegmented(root, value);
    onChange(value);
  });
  root.setAttribute('role', 'group');
}

export function setSegmented(root, value) {
  for (const b of root.querySelectorAll('button[data-value]')) {
    b.setAttribute('aria-pressed', String(b.dataset.value === String(value)));
  }
}

// ---- Range slider ------------------------------------------------------------------

export function paintSlider(input) {
  const min = Number(input.min) || 0;
  const max = Number(input.max) || 100;
  input.style.setProperty('--pct', `${((Number(input.value) - min) / (max - min)) * 100}%`);
}

// Smoothly counts a number up/down for a tactile readout.
export function animateNumber(el, to, { duration = 260, format = (v) => String(Math.round(v)) } = {}) {
  const from = Number(el.dataset.value ?? to);
  el.dataset.value = String(to);
  if (from === to || matchMedia('(prefers-reduced-motion: reduce)').matches) {
    el.textContent = format(to);
    return;
  }
  const start = performance.now();
  cancelAnimationFrame(Number(el.dataset.raf));
  const tick = (now) => {
    const t = Math.min(1, (now - start) / duration);
    const eased = 1 - (1 - t) ** 3;
    el.textContent = format(from + (to - from) * eased);
    if (t < 1) el.dataset.raf = String(requestAnimationFrame(tick));
  };
  el.dataset.raf = String(requestAnimationFrame(tick));
}
