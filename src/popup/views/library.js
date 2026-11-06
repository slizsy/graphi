// Library view: saved texts. Click to make one active, duplicate, or delete
// (with undo).

import { $, h, icon, toast } from '../components/ui.js';
import { state, subscribe, selectDoc, createDoc, removeDoc, restoreDoc } from '../store.js';
import { formatNumber, relativeTime } from '../../shared/format.js';

const ICONS = {
  copy: ['M5.5 5.5h7v7h-7z', 'M3.5 10.5v-7h7'],
  trash: ['M3.5 4.5h9', 'M6.5 4.5V3h3v1.5', 'M5 4.5l.6 8.2a1 1 0 0 0 1 .8h2.8a1 1 0 0 0 1-.8l.6-8.2'],
};

export function initLibrary({ go, focusEditor }) {
  const list = $('#libList');
  const search = $('#libSearch');

  $('#newDoc').addEventListener('click', () => {
    createDoc('Untitled', '');
    go('compose');
    setTimeout(focusEditor, 50);
  });
  search.addEventListener('input', render);

  function preview(text) {
    const t = text.replace(/\s+/g, ' ').trim();
    return t || 'Empty — add some text in Compose.';
  }

  function item(doc, i) {
    const active = doc.id === state.library.activeId;
    const chars = Array.from(doc.text).length;
    const li = h('li', {
      class: `lib-item${active ? ' active' : ''}`, tabindex: '0', role: 'button',
      'aria-label': `Open ${doc.title}`, style: `animation-delay:${Math.min(i, 8) * 28}ms`,
    },
      h('span', { class: 'lib-title' }, doc.title || 'Untitled'),
      h('span', { class: 'lib-actions' },
        h('button', { class: 'icon-btn', title: 'Duplicate', 'aria-label': 'Duplicate', dataset: { act: 'copy' } }, icon(ICONS.copy)),
        h('button', { class: 'icon-btn danger', title: 'Delete', 'aria-label': 'Delete', dataset: { act: 'delete' } }, icon(ICONS.trash))),
      h('p', { class: 'lib-preview' }, preview(doc.text)),
      h('span', { class: 'lib-meta' },
        active ? h('span', { class: 'tag-active' }, '● ACTIVE') : null,
        h('span', {}, `${formatNumber(chars)} chars`),
        h('span', {}, relativeTime(doc.updatedAt))));

    li.addEventListener('click', (e) => {
      const act = e.target.closest('[data-act]')?.dataset.act;
      if (act === 'copy') {
        createDoc(`${doc.title} copy`.slice(0, 120), doc.text);
        toast('Duplicated');
        return;
      }
      if (act === 'delete') {
        li.classList.add('removing');
        setTimeout(() => {
          const removed = removeDoc(doc.id);
          if (removed) toast(`Deleted “${doc.title}”`, { action: { label: 'Undo', run: () => restoreDoc(removed) } });
        }, 180);
        return;
      }
      selectDoc(doc.id);
      go('compose');
    });
    li.addEventListener('keydown', (e) => {
      if (e.target === li && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); li.click(); }
    });
    return li;
  }

  function render() {
    const q = search.value.trim().toLowerCase();
    const docs = [...state.library.docs]
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .filter((d) => !q || d.title.toLowerCase().includes(q) || d.text.toLowerCase().includes(q));
    list.replaceChildren(...docs.map(item));
    const empty = docs.length === 0;
    $('#libEmpty').hidden = !empty;
    $('#libEmptyTitle').textContent = q ? 'No matches' : 'Your library is empty';
    $('#libEmptyCopy').textContent = q ? `Nothing matches “${search.value.trim()}”.` : 'Save texts you type often and switch between them in a click.';
  }

  subscribe((what) => what === 'library' && render());
  render();
  return { render };
}
