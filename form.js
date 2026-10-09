// 予定・タスクの追加と編集の画面（全画面）
import { CONFIG } from './config.js?v=21';
import * as store from './store.js?v=21';
import * as D from './dates.js?v=21';
import { h, $ } from './dom.js?v=21';

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
  for (const pick of form.querySelectorAll('.time-pick')) initTimePick(pick);
  initTimeDialog();
  for (const btn of form.querySelectorAll('[data-clear]')) {
    btn.addEventListener('click', () => setTime(btn.dataset.clear, ''));
  }
  form.addEventListener('submit', submit);
  $('#delete-btn').addEventListener('click', remove);
  $('#event-dialog').addEventListener('close', () => { ctx = null; draft = null; });
}

/* ---------- 時刻の入力（時と分を回して選ぶ。分は5分刻み） ---------- */
// iPhoneの標準の時刻入力は5分刻みにできないため、同じような画面をアプリで作っている

const pad2 = (n) => String(n).padStart(2, '0');
const WHEEL_ITEM_H = 36; // styles.css の .wheel-item の高さ
let timeTarget = null; // 選んでいる欄（'startTime' など）

function initTimePick(pick) {
  const name = pick.dataset.time;
  els()[`${name}_btn`].addEventListener('click', () => openTimeDialog(name, pick.dataset.label));
}

function initTimeDialog() {
  $('#time-ok-btn').addEventListener('click', () => {
    const hh = wheelValue($('#wheel-h'));
    const mm = wheelValue($('#wheel-m'));
    setTime(timeTarget, `${hh}:${mm}`);
    $('#time-dialog').close();
  });
  $('#time-none-btn').addEventListener('click', () => {
    setTime(timeTarget, '');
    $('#time-dialog').close();
  });
  // 外側をタップしたら、変えずに閉じる
  $('#time-dialog').addEventListener('click', (e) => {
    const r = $('#time-dialog').getBoundingClientRect();
    const inside = e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
    if (!inside) $('#time-dialog').close();
  });
}

// 最初に表示する時刻：入っていればその時刻、終了は開始の1時間後、それ以外は12:00
function initialTime(name) {
  const e = els();
  if (e[name].value) return e[name].value;
  if (name === 'endTime' && e.startTime.value) {
    const [hh, mm] = e.startTime.value.split(':').map(Number);
    return `${pad2(Math.min(hh + 1, 23))}:${pad2(mm)}`;
  }
  return '12:00';
}

function openTimeDialog(name, label) {
  if (ctx?.readOnly) return;
  timeTarget = name;
  const [hh, mm] = initialTime(name).split(':');
  const minutes = Array.from({ length: 12 }, (_, i) => pad2(i * 5));
  // 5分刻みでない時刻（Googleで入れた 23:59 など）は、その分も選べるようにする
  if (!minutes.includes(mm)) {
    minutes.push(mm);
    minutes.sort();
  }
  $('#time-title').textContent = label;
  fillWheel($('#wheel-h'), Array.from({ length: 24 }, (_, i) => pad2(i)), (v) => `${Number(v)}時`);
  fillWheel($('#wheel-m'), minutes, (v) => `${v}分`);
  $('#time-dialog').showModal();
  scrollWheel($('#wheel-h'), hh, false);
  scrollWheel($('#wheel-m'), mm, false);
}

function fillWheel(wheel, values, text) {
  wheel.replaceChildren(...values.map((v) => h('div', {
    class: 'wheel-item',
    'data-value': v,
    onclick: () => scrollWheel(wheel, v, true),
  }, text(v))));
}

function scrollWheel(wheel, value, smooth) {
  const i = [...wheel.children].findIndex((el) => el.dataset.value === value);
  wheel.scrollTo({ top: Math.max(0, i) * WHEEL_ITEM_H, behavior: smooth ? 'smooth' : 'instant' });
}

// 真ん中の帯に入っている値
function wheelValue(wheel) {
  const i = Math.round(wheel.scrollTop / WHEEL_ITEM_H);
  const items = wheel.children;
  return items[Math.min(Math.max(i, 0), items.length - 1)].dataset.value;
}

function setTime(name, value) {
  const e = els();
  e[name].value = value || '';
  const btn = e[`${name}_btn`];
  btn.textContent = value ? `${Number(value.slice(0, 2))}:${value.slice(3)}` : '--:--';
  btn.classList.toggle('empty', !value);
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
  const readOnly = offline || (mode === 'edit' && !store.canEdit(event));
  ctx = { mode, event, readOnly, initialDescription: fields.description };
  draft = {
    kind: fields.kind,
    persons: [...fields.persons],
    startKey: fields.startKey,
    endKey: fields.endKey,
    multi: fields.multi,
  };
  picking = 'start';
  // 最初の日付（新規は今日か選んだ日、編集は元の日付）の月を表示する
  viewMonth = D.monthKey(D.parts(fields.startKey).y, D.parts(fields.startKey).m);

  const e = els();
  e.title.value = fields.title;
  setTime('startTime', fields.startTime);
  setTime('endTime', fields.endTime);
  setTime('dueTime', fields.dueTime);
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
  if (readOnly && !offline) notes.push('この予定は編集できません。');
  if (offline) notes.push('オフラインのため編集できません。');
  if (mode === 'edit' && !readOnly && !store.editsInPlace(event)) {
    notes.push('Googleの予定です。変更・削除しても元の予定は残ります。');
    if (event.recurring) notes.push('繰り返し予定です。変更・削除はこの回だけに適用されます。');
  }
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
  // その月の日が入っている週だけ表示する（4〜6週）
  let weeks = 6;
  while (weeks > 4 && !D.addDays(gridStart, (weeks - 1) * 7).startsWith(monthPrefix)) weeks--;

  const cells = [];
  for (let i = 0; i < weeks * 7; i++) {
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
    hooks.onSaved(f.startKey);
  } catch (err) {
    setBusy(false);
    hooks.onSaveError(err);
  }
}

async function remove() {
  const ev = ctx?.event;
  if (!ev) return;
  let extra = '';
  if (!store.editsInPlace(ev)) {
    extra = '\n（アプリに表示しなくなります。Googleカレンダーの元の予定は残ります）';
    if (ev.recurring) extra += '\n（繰り返し予定のこの回だけです）';
  }
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
