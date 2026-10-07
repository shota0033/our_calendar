// 予定・タスクの追加と編集の画面（全画面）
import { CONFIG } from './config.js';
import * as store from './store.js';
import * as D from './dates.js';
import { h, $ } from './dom.js';

// 開いているフォームの情報
let ctx = null; // { mode: 'new' | 'edit', event, readOnly, initialDescription }
// 入力中の値（フォーム要素に入らないもの）
let draft = null; // { kind, persons, startKey, endKey, multi }
let viewMonth = null; // 小さなカレンダーに表示中の月（'YYYY-MM-01'）
let picking = 'start'; // 複数日で次にタップする日付が開始日か終了日か
let hooks = { onSaved() {}, onSaveError() {} };

const els = () => $('#event-form').elements;

export function initForm(callbacks) {
  hooks = callbacks;
  const form = $('#event-form');

  $('#persons').replaceChildren(...store.PERSONS.map((p) => h('button', {
    type: 'button',
    class: 'person-btn',
    'data-person': p,
    'aria-pressed': 'false',
    style: { '--person-color': CONFIG.people[p].color },
    onclick: () => togglePerson(p),
  }, h('span', { class: 'icon' }, CONFIG.people[p].icon), h('span', {}, CONFIG.people[p].label))));

  for (const btn of form.querySelectorAll('[data-kind]')) {
    btn.addEventListener('click', () => { if (!ctx?.readOnly) setKind(btn.dataset.kind); });
  }
  form.elements.multi.addEventListener('change', () => setMulti(form.elements.multi.checked));
  for (const btn of form.querySelectorAll('[data-clear]')) {
    btn.addEventListener('click', () => { form.elements[btn.dataset.clear].value = ''; });
  }
  form.addEventListener('submit', submit);
  $('#delete-btn').addEventListener('click', remove);
  $('#event-dialog').addEventListener('close', () => { ctx = null; draft = null; });
}

export function isOpen() {
  return !!ctx;
}

// ログインし直す前に保存しておく、入力中の内容
export function currentDraft() {
  if (!ctx || ctx.readOnly) return null;
  return { mode: ctx.mode, event: ctx.event, fields: readFields() };
}

/* ---------- 初期値 ---------- */

export function defaultFields(dayKey) {
  const key = dayKey || D.todayKey();
  const person = store.selfPerson() || store.PERSONS[0];
  return {
    kind: 'event',
    title: '',
    persons: [person],
    startKey: key,
    endKey: key,
    multi: false,
    startTime: '',
    endTime: '',
    dueTime: '',
    done: false,
    description: '',
  };
}

// Googleカレンダーのメモは HTML のことがあるので、文字だけにする
function htmlToText(html) {
  if (!/<[a-z][\s\S]*>/i.test(html)) return html;
  const withBreaks = html.replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|li)>/gi, '\n');
  const doc = new DOMParser().parseFromString(withBreaks, 'text/html');
  return (doc.body.textContent || '').replace(/\n{3,}/g, '\n\n').trim();
}

export function fieldsFromEvent(ev) {
  const f = {
    kind: ev.kind,
    title: ev.summary,
    persons: [...ev.persons],
    startKey: ev.startKey,
    endKey: ev.endKey,
    multi: false,
    startTime: '',
    endTime: '',
    dueTime: '',
    done: ev.done,
    description: htmlToText(ev.description),
  };
  if (!ev.allDay) {
    if (ev.timeMode === 'due') f.dueTime = ev.startTime;
    else if (ev.timeMode === 'start') f.startTime = ev.startTime;
    else if (ev.timeMode === 'end') { f.endTime = ev.endTime; f.endKey = D.keyFromMs(ev.endMs); }
    else { f.startTime = ev.startTime; f.endTime = ev.endTime; f.endKey = D.keyFromMs(ev.endMs); }
  }
  if (f.kind === 'task') f.endKey = f.startKey;
  f.multi = f.kind === 'event' && f.endKey !== f.startKey;
  return f;
}

/* ---------- 開く・閉じる ---------- */

export function openForm(mode, event, fields, { offline = false } = {}) {
  const readOnly = offline || (mode === 'edit' && !store.isWritable(event));
  ctx = { mode, event, readOnly, initialDescription: fields.description };
  draft = {
    kind: fields.kind,
    persons: [...fields.persons],
    startKey: fields.startKey,
    endKey: fields.endKey,
    multi: fields.multi,
  };
  picking = 'start';
  viewMonth = D.monthKey(D.parts(fields.startKey).y, D.parts(fields.startKey).m);

  const e = els();
  e.title.value = fields.title;
  e.startTime.value = fields.startTime;
  e.endTime.value = fields.endTime;
  e.dueTime.value = fields.dueTime;
  e.done.checked = fields.done;
  e.description.value = fields.description;
  e.multi.checked = fields.multi;
  for (const el of e) if (el.name) el.disabled = readOnly;
  for (const btn of document.querySelectorAll('#event-form .clear')) btn.hidden = readOnly;

  $('#save-btn').hidden = readOnly;
  $('#delete-btn').hidden = mode !== 'edit' || readOnly;
  $('#event-form').classList.toggle('readonly', readOnly);
  $('#done-wrap').hidden = mode !== 'edit';

  const notes = [];
  if (readOnly && !offline) notes.push('このカレンダーは閲覧のみです。');
  if (offline) notes.push('オフラインのため編集できません。');
  if (mode === 'edit' && event.recurring && !readOnly) notes.push('繰り返し予定です。変更・削除はこの回だけに適用されます。');
  $('#event-note').textContent = notes.join('\n');
  $('#event-note').hidden = !notes.length;
  showError('');
  setBusy(false);

  setKind(draft.kind);
  renderPersons();
  renderDates();

  const dialog = $('#event-dialog');
  if (!dialog.open) dialog.showModal();
  dialog.scrollTop = 0;
  if (mode === 'new') e.title.focus();
}

export function closeForm() {
  ctx = null;
  draft = null;
  if ($('#event-dialog').open) $('#event-dialog').close();
}

/* ---------- 種類・人・日付 ---------- */

function setKind(kind) {
  draft.kind = kind;
  const isTask = kind === 'task';
  for (const btn of document.querySelectorAll('#event-form [data-kind]')) {
    btn.setAttribute('aria-selected', String(btn.dataset.kind === kind));
  }
  $('#event-times').hidden = isTask;
  $('#task-times').hidden = !isTask;
  $('#multi-wrap').hidden = isTask;
  if (isTask && draft.multi) {
    draft.multi = false;
    draft.endKey = draft.startKey;
    els().multi.checked = false;
  }
  const what = isTask ? 'タスク' : '予定';
  let title = `${what}を追加`;
  if (ctx.readOnly) title = what;
  else if (ctx.mode === 'edit') title = `${what}を編集`;
  $('#event-dialog-title').textContent = title;
  renderDates();
}

function togglePerson(p) {
  if (ctx.readOnly) return;
  draft.persons = draft.persons.includes(p)
    ? draft.persons.filter((x) => x !== p)
    : store.PERSONS.filter((x) => x === p || draft.persons.includes(x));
  showError('');
  renderPersons();
}

function renderPersons() {
  for (const btn of document.querySelectorAll('#persons .person-btn')) {
    btn.setAttribute('aria-pressed', String(draft.persons.includes(btn.dataset.person)));
    btn.disabled = ctx.readOnly;
  }
}

function setMulti(on) {
  draft.multi = on;
  if (on) {
    draft.endKey = null;
    picking = 'end';
  } else {
    draft.endKey = draft.startKey;
    picking = 'start';
  }
  renderDates();
}

function pickDate(key) {
  if (ctx.readOnly) return;
  if (!draft.multi) {
    draft.startKey = key;
    draft.endKey = key;
  } else if (picking === 'start' || key < draft.startKey) {
    draft.startKey = key;
    draft.endKey = null;
    picking = 'end';
  } else {
    draft.endKey = key;
    picking = 'start';
  }
  showError('');
  renderDates();
}

function moveMiniMonth(delta) {
  const { y, m } = D.parts(viewMonth);
  viewMonth = D.monthKey(y, m + delta);
  renderDates();
}

function renderDates() {
  if (!draft) return;
  const { startKey, endKey, multi, kind } = draft;
  let label;
  if (kind === 'task') label = `期限：${D.formatDayLabel(startKey)}`;
  else if (!multi) label = D.formatDayLabel(startKey);
  else label = `${D.formatDayLabel(startKey)} 〜 ${endKey ? D.formatDayLabel(endKey) : '終了日をタップ'}`;
  $('#date-label').textContent = label;

  const { y, m } = D.parts(viewMonth);
  const first = viewMonth;
  const gridStart = D.addDays(first, -D.weekday(first));
  const today = D.todayKey();
  const monthPrefix = first.slice(0, 7);
  const rangeEnd = endKey || startKey;

  const cells = [];
  for (let i = 0; i < 42; i++) {
    const key = D.addDays(gridStart, i);
    const cls = ['mc-day'];
    if (!key.startsWith(monthPrefix)) cls.push('other');
    if (key === today) cls.push('today');
    if (i % 7 === 0) cls.push('sun');
    if (i % 7 === 6) cls.push('sat');
    if (key === startKey) cls.push('sel', 'start');
    if (multi && endKey && key === endKey) cls.push('sel', 'end');
    if (multi && endKey && key > startKey && key < rangeEnd) cls.push('in-range');
    if (multi && endKey && endKey !== startKey && (key === startKey || key === endKey)) cls.push('edge');
    cells.push(h('button', {
      type: 'button',
      class: cls.join(' '),
      disabled: ctx.readOnly,
      onclick: () => pickDate(key),
    }, h('span', {}, D.parts(key).d)));
  }

  $('#mini-cal').replaceChildren(
    h('div', { class: 'mc-head' },
      h('button', { type: 'button', class: 'icon-btn', 'aria-label': '前の月', onclick: () => moveMiniMonth(-1) }, '‹'),
      h('span', { class: 'mc-title' }, `${y}年${m}月`),
      h('button', { type: 'button', class: 'icon-btn', 'aria-label': '次の月', onclick: () => moveMiniMonth(1) }, '›')),
    h('div', { class: 'mc-grid' },
      D.WEEKDAYS.map((w, i) => h('span', { class: `mc-wd ${i === 0 ? 'sun' : ''} ${i === 6 ? 'sat' : ''}` }, w)),
      cells));
}

/* ---------- 保存・削除 ---------- */

function readFields() {
  const e = els();
  return {
    kind: draft.kind,
    title: e.title.value.trim(),
    persons: [...draft.persons],
    startKey: draft.startKey,
    endKey: draft.multi ? draft.endKey : draft.startKey,
    multi: draft.multi,
    startTime: e.startTime.value,
    endTime: e.endTime.value,
    dueTime: e.dueTime.value,
    done: e.done.checked,
    description: e.description.value,
  };
}

function validate(f) {
  if (!f.title) return 'タイトルを入力してください。';
  if (!f.persons.length) return `${store.PERSONS.map((p) => CONFIG.people[p].icon).join('か')}を選んでください。`;
  if (f.kind === 'event') {
    if (f.multi && !f.endKey) return '終了日をカレンダーでタップしてください。';
    if (f.startTime && f.endTime && (!f.multi || f.endKey === f.startKey) && f.endTime <= f.startTime) {
      return '終了の時刻は開始より後にしてください。';
    }
  }
  return '';
}

async function submit(e) {
  e.preventDefault();
  if (!ctx || ctx.readOnly) return;
  const f = readFields();
  if (f.multi && f.endKey === f.startKey) f.multi = false;
  const message = validate(f);
  if (message) { showError(message); return; }

  setBusy(true);
  try {
    await store.saveEvent(f, ctx.mode === 'edit' ? ctx.event : null, {
      descriptionChanged: ctx.mode === 'new' || f.description !== ctx.initialDescription,
    });
    closeForm();
    hooks.onSaved();
  } catch (err) {
    setBusy(false);
    hooks.onSaveError(err);
  }
}

async function remove() {
  const ev = ctx?.event;
  if (!ev) return;
  const extra = ev.recurring ? '\n（繰り返し予定のこの回だけを削除します）' : '';
  if (!confirm(`「${ev.title}」を削除しますか？${extra}`)) return;
  setBusy(true);
  try {
    await store.deleteEvent(ev);
    closeForm();
    hooks.onSaved();
  } catch (err) {
    setBusy(false);
    hooks.onSaveError(err);
  }
}

export function showError(message) {
  $('#event-error').textContent = message;
  $('#event-error').hidden = !message;
  if (message) $('#event-error').scrollIntoView({ block: 'nearest' });
}

function setBusy(on) {
  $('#save-btn').disabled = on;
  $('#delete-btn').disabled = on;
}
