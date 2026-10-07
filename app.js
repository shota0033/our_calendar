// 画面の表示と操作
import { CONFIG } from './config.js';
import * as auth from './auth.js';
import * as api from './api.js';
import * as store from './store.js';
import * as D from './dates.js';

const $ = (sel) => document.querySelector(sel);

const KEY_VIEW = 'oc.view';
const KEY_RESUME = 'oc.resume';
const KEY_LAST_CALENDAR = 'oc.lastCalendar';

// トークンの残りがこれより短ければ、先に取り直す
const REFRESH_BEFORE_EDIT_MS = 10 * 60 * 1000;
const REFRESH_ON_RETURN_MS = 10 * 60 * 1000;
const REFRESH_WHILE_OPEN_MS = 5 * 60 * 1000;
// Googleへ移動する前の画面状態は、この時間内に戻ってきたときだけ復元する
const RESUME_TTL_MS = 30 * 60 * 1000;

const state = {
  view: 'month',
  month: thisMonth(),
  listDays: CONFIG.listDays,
  events: [],
  needsLogin: false,
  offline: !navigator.onLine,
  error: '',
  loadSeq: 0,
};

// 開いている予定フォームの情報
let formCtx = null; // { mode: 'new' | 'edit', event, initial, readOnly }
let dayDialogKey = null;

function load(key) {
  try { return JSON.parse(localStorage.getItem(key)); } catch { return null; }
}
function save(key, value) {
  try {
    if (value == null) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(value));
  } catch { /* 無視 */ }
}

// 小さなDOM作成ヘルパー
function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'style') Object.assign(el.style, v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : String(c));
  }
  return el;
}

function thisMonth() {
  const { y, m } = D.parts(D.todayKey());
  return D.monthKey(y, m);
}

/* ---------- 起動 ---------- */

function init() {
  const result = auth.handleRedirect();
  restoreView();
  bindUi();
  registerServiceWorker();

  if (CONFIG.clientId.startsWith('YOUR_')) {
    showLogin('config.js にクライアントIDを設定してください。');
    $('#login-btn').disabled = true;
    return;
  }
  if (!auth.getToken() && !auth.hasLoggedInBefore()) {
    showLogin(result.status === 'error' ? loginErrorText(result.error) : '');
    return;
  }

  showApp();
  refresh({ reloadCalendars: true }).then(resumeAfterLogin);

  setInterval(() => maybeRefreshToken(REFRESH_WHILE_OPEN_MS), 60 * 1000);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    if (!maybeRefreshToken(REFRESH_ON_RETURN_MS)) refresh();
  });
  window.addEventListener('online', () => { state.offline = false; refresh(); });
  window.addEventListener('offline', () => { state.offline = true; renderChrome(); });
}

function loginErrorText(error) {
  if (error === 'access_denied') return 'ログインがキャンセルされました。';
  return `ログインできませんでした（${error}）。もう一度お試しください。`;
}

function showLogin(message) {
  $('#login-message').textContent = message;
  $('#login-screen').hidden = false;
  $('#app').hidden = true;
}

function showApp() {
  $('#login-screen').hidden = true;
  $('#app').hidden = false;
  render();
}

function restoreView() {
  const saved = load(KEY_VIEW);
  if (!saved) return;
  if (saved.view === 'month' || saved.view === 'list') state.view = saved.view;
  // 表示中の月は、ログインで画面を離れた直後だけ復元する（普段は今月から）
  if (saved.month && Date.now() - saved.savedAt < RESUME_TTL_MS) state.month = saved.month;
}

function saveView() {
  save(KEY_VIEW, { view: state.view, month: state.month, savedAt: Date.now() });
}

function registerServiceWorker() {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js').catch((err) => console.warn(err));
  }
}

/* ---------- ログイン（トークン）の更新 ---------- */

// Googleへ移動して戻ってきたときに、入力中のフォームを開き直すための情報を残す
function saveResume() {
  const draft = formCtx && !formCtx.readOnly
    ? { mode: formCtx.mode, event: formCtx.event, fields: readForm() }
    : null;
  save(KEY_RESUME, draft ? { draft, savedAt: Date.now() } : null);
  saveView();
}

function resumeAfterLogin() {
  const resume = load(KEY_RESUME);
  if (!resume) return;
  if (Date.now() - resume.savedAt > RESUME_TTL_MS) { save(KEY_RESUME, null); return; }
  if (!auth.getToken()) return; // 再ログイン後に使うので残しておく
  save(KEY_RESUME, null);
  if (resume.draft) openEventForm(resume.draft.mode, resume.draft.event, resume.draft.fields);
}

// 画面を出さずにトークンを取り直す。Googleへ移動したら true
function redirectForToken() {
  saveResume();
  if (auth.refreshSilently()) return true;
  return false;
}

// 残り時間が少なければ取り直す（フォームなどを開いている間はしない）
function maybeRefreshToken(thresholdMs) {
  if (!auth.hasLoggedInBefore() || !navigator.onLine) return false;
  if (auth.remainingMs() > thresholdMs) return false;
  if (document.querySelector('dialog[open]')) return false;
  return redirectForToken();
}

function handleNoToken() {
  if (!navigator.onLine) {
    state.offline = true;
  } else if (!redirectForToken()) {
    state.needsLogin = true;
  }
  renderChrome();
}

function handleError(err) {
  if (err.auth) handleNoToken();
  else if (err.network) { state.offline = true; renderChrome(); }
  else { state.error = err.message; renderChrome(); }
}

function relogin() {
  saveResume();
  auth.login();
}

/* ---------- データの読み込み ---------- */

function gridStart(monthKey) {
  return D.addDays(monthKey, -D.weekday(monthKey));
}

function currentRange() {
  if (state.view === 'month') {
    const start = gridStart(state.month);
    return [start, D.addDays(start, 42)];
  }
  const from = D.todayKey();
  return [from, D.addDays(from, state.listDays)];
}

async function refresh({ reloadCalendars = false } = {}) {
  const seq = ++state.loadSeq;
  const [from, to] = currentRange();
  const cached = store.cachedEvents(from, to);
  state.events = cached || [];
  render();

  if (!auth.getToken()) { handleNoToken(); return; }

  setLoading(true);
  try {
    if (reloadCalendars || !store.calendars.length) {
      await store.loadCalendars();
      const primary = store.primaryCalendar();
      if (primary) auth.setEmail(primary.id); // メインカレンダーのIDはメールアドレス
    }
    const events = await store.loadEvents(from, to);
    if (seq !== state.loadSeq) return;
    state.events = events;
    state.offline = false;
    state.needsLogin = false;
    state.error = '';
    render();
  } catch (err) {
    if (seq === state.loadSeq) handleError(err);
  } finally {
    if (seq === state.loadSeq) setLoading(false);
  }
}

function setLoading(on) {
  $('#loading').hidden = !on;
}

/* ---------- 描画 ---------- */

function render() {
  renderChrome();
  if (state.view === 'month') renderMonth();
  else renderList();
  if (dayDialogKey && $('#day-dialog').open) renderDayDialog(dayDialogKey);
}

function renderChrome() {
  const isMonth = state.view === 'month';
  if (isMonth) {
    const { y, m } = D.parts(state.month);
    $('#title').textContent = `${y}年${m}月`;
  } else {
    $('#title').textContent = 'これからの予定';
  }
  $('#prev-btn').hidden = !isMonth;
  $('#next-btn').hidden = !isMonth;
  for (const btn of document.querySelectorAll('.seg button')) {
    btn.setAttribute('aria-selected', String(btn.dataset.view === state.view));
  }
  $('#add-btn').hidden = state.offline || (store.calendars.length > 0 && !store.writableCalendars().length);
  renderBanner();
}

function renderBanner() {
  const banner = $('#banner');
  banner.replaceChildren();
  banner.className = 'banner';
  if (state.needsLogin) {
    banner.classList.add('warn');
    banner.append(
      h('span', {}, 'ログインの有効期限が切れました'),
      h('button', { class: 'btn primary', type: 'button', onclick: relogin }, '再ログイン'),
    );
  } else if (state.offline) {
    banner.append(h('span', {}, 'オフラインです。最後に読み込んだ予定を表示しています（編集はできません）'));
  } else if (state.error) {
    banner.classList.add('warn');
    banner.append(
      h('span', {}, state.error),
      h('button', { class: 'btn', type: 'button', onclick: () => { state.error = ''; renderBanner(); } }, '閉じる'),
    );
  }
  banner.hidden = !banner.childElementCount;
}

function calendarColor(calendarId) {
  return store.calendarById(calendarId)?.color || '#888';
}

// 範囲内の各日付に、その日に重なる予定を割り当てる
function groupByDay(events, fromKey, toKey) {
  const map = new Map();
  for (const ev of events) {
    let day = ev.startKey < fromKey ? fromKey : ev.startKey;
    const last = ev.endKey;
    while (day <= last && day < toKey) {
      if (!map.has(day)) map.set(day, []);
      map.get(day).push(ev);
      day = D.addDays(day, 1);
    }
  }
  return map;
}

function isHolidayEvent(ev) {
  return store.calendarById(ev.calendarId)?.holiday;
}

function renderMonth() {
  const start = gridStart(state.month);
  const end = D.addDays(start, 42);
  const byDay = groupByDay(state.events, start, end);
  const today = D.todayKey();
  const monthPrefix = state.month.slice(0, 7);
  const maxChips = window.innerWidth >= 900 ? 5 : 3;
  const canHover = matchMedia('(hover: hover)').matches;

  const head = D.WEEKDAYS.map((w, i) =>
    h('div', { class: `wd ${i === 0 ? 'sun' : ''} ${i === 6 ? 'sat' : ''}` }, w));

  const cells = [];
  for (let i = 0; i < 42; i++) {
    const key = D.addDays(start, i);
    const events = byDay.get(key) || [];
    const wd = i % 7;
    const classes = ['cell'];
    if (!key.startsWith(monthPrefix)) classes.push('other');
    if (key === today) classes.push('today');
    if (wd === 0 || events.some(isHolidayEvent)) classes.push('sun');
    else if (wd === 6) classes.push('sat');

    const chips = events.slice(0, maxChips).map((ev) => {
      const color = calendarColor(ev.calendarId);
      const isBar = ev.allDay || ev.startKey !== ev.endKey;
      const onclick = canHover ? (e) => { e.stopPropagation(); openEvent(ev); } : null;
      return isBar
        ? h('div', { class: 'chip bar', style: { background: color }, onclick }, ev.title)
        : h('div', { class: 'chip', onclick },
          h('i', { class: 'dot', style: { background: color } }),
          h('span', { class: 't' }, ev.startTime), ev.title);
    });
    if (events.length > maxChips) chips.push(h('div', { class: 'more' }, `他${events.length - maxChips}件`));

    cells.push(h('div', { class: classes.join(' '), onclick: () => openDay(key) },
      h('div', { class: 'num' }, D.parts(key).d),
      chips));
  }

  $('#main').replaceChildren(h('div', { class: 'month' }, head, cells));
}

function timeText(ev) {
  if (ev.allDay) {
    return ev.startKey === ev.endKey ? '終日' : `終日〜${D.formatShort(ev.endKey)}`;
  }
  if (ev.startKey === ev.endKey) return `${ev.startTime}–${ev.endTime}`;
  return `${D.formatShort(ev.startKey)} ${ev.startTime}〜${D.formatShort(ev.endKey)} ${ev.endTime}`;
}

function eventRow(ev) {
  const cal = store.calendarById(ev.calendarId);
  return h('button', { class: 'event-row', type: 'button', onclick: () => openEvent(ev) },
    h('i', { class: 'bar', style: { background: calendarColor(ev.calendarId) } }),
    h('span', { class: 'time' }, timeText(ev)),
    h('span', { class: 'body' },
      h('span', { class: 'name' }, ev.title),
      cal ? h('span', { class: 'cal' }, cal.name) : null));
}

function renderList() {
  const [from, to] = currentRange();
  const today = D.todayKey();
  // 複数日の予定は、始まる日（範囲より前に始まったものは範囲の初日）に1回だけ表示する
  const byDay = new Map();
  for (const ev of state.events) {
    if (ev.endKey < from || ev.startKey >= to) continue;
    const day = ev.startKey < from ? from : ev.startKey;
    if (!byDay.has(day)) byDay.set(day, []);
    byDay.get(day).push(ev);
  }
  const days = [...byDay.keys()].sort();

  const sections = days.map((day) => h('section', { class: 'list-day' },
    h('h2', { class: day === today ? 'today' : '' },
      day === today ? `今日 ${D.formatDayLabel(day)}` : D.formatDayLabel(day)),
    byDay.get(day).map(eventRow)));

  $('#main').replaceChildren(h('div', { class: 'list' },
    sections.length ? sections : h('p', { class: 'empty' }, '予定はありません'),
    h('button', {
      class: 'btn block more-btn',
      type: 'button',
      onclick: () => { state.listDays += CONFIG.listDays; refresh(); },
    }, `さらに表示（${D.formatShort(to)}以降）`)));
}

/* ---------- 1日の予定 ---------- */

function openDay(key) {
  dayDialogKey = key;
  renderDayDialog(key);
  $('#day-add-btn').hidden = $('#add-btn').hidden;
  $('#day-dialog').showModal();
}

function renderDayDialog(key) {
  $('#day-title').textContent = D.formatDayLabel(key);
  const events = groupByDay(state.events, key, D.addDays(key, 1)).get(key) || [];
  $('#day-events').replaceChildren(...(events.length
    ? events.map(eventRow)
    : [h('p', { class: 'empty' }, '予定はありません')]));
}

/* ---------- 予定フォーム ---------- */

function defaultFields(dayKey) {
  const today = D.todayKey();
  const key = dayKey || today;
  let hour = 10;
  if (key === today) hour = Math.min(23, Number(D.timeFromMs(Date.now()).slice(0, 2)) + 1);
  const startTime = `${String(hour).padStart(2, '0')}:00`;
  const endKey = hour === 23 ? D.addDays(key, 1) : key;
  const endTime = hour === 23 ? '00:00' : `${String(hour + 1).padStart(2, '0')}:00`;
  const last = load(KEY_LAST_CALENDAR);
  const writable = store.writableCalendars();
  const calendarId = writable.some((c) => c.id === last) ? last
    : (store.primaryCalendar()?.id || writable[0]?.id || '');
  return { title: '', calendarId, allDay: false, startKey: key, startTime, endKey, endTime, description: '' };
}

// Googleカレンダーのメモは HTML のことがあるので、文字だけにする
function htmlToText(html) {
  if (!/<[a-z][\s\S]*>/i.test(html)) return html;
  const withBreaks = html.replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|li)>/gi, '\n');
  const doc = new DOMParser().parseFromString(withBreaks, 'text/html');
  return (doc.body.textContent || '').replace(/\n{3,}/g, '\n\n').trim();
}

function fieldsFromEvent(ev) {
  return {
    title: ev.summary,
    calendarId: ev.calendarId,
    allDay: ev.allDay,
    startKey: ev.startKey,
    startTime: ev.startTime || '10:00',
    endKey: ev.endKey,
    endTime: ev.endTime || '11:00',
    description: htmlToText(ev.description),
  };
}

// フォームを開く前にトークンを取り直す。戻ってきたらこのフォームを開く
function redirectWithDraft(draft) {
  save(KEY_RESUME, { draft, savedAt: Date.now() });
  saveView();
  if (auth.refreshSilently()) return true;
  save(KEY_RESUME, null);
  return false;
}

function openNewEvent(dayKey) {
  if (state.offline) return;
  // 入力の途中でトークンが切れないよう、残りが短ければ先に取り直す
  const fields = defaultFields(dayKey);
  if (navigator.onLine && auth.remainingMs() < REFRESH_BEFORE_EDIT_MS) {
    if (redirectWithDraft({ mode: 'new', event: null, fields })) return;
  }
  openEventForm('new', null, fields);
}

function openEvent(ev) {
  const writable = store.calendarById(ev.calendarId)?.writable;
  if (writable && !state.offline && navigator.onLine && auth.remainingMs() < REFRESH_BEFORE_EDIT_MS) {
    if (redirectWithDraft({ mode: 'edit', event: ev, fields: fieldsFromEvent(ev) })) return;
  }
  openEventForm('edit', ev, fieldsFromEvent(ev));
}

function openEventForm(mode, event, fields) {
  const form = $('#event-form');
  const cal = event ? store.calendarById(event.calendarId) : null;
  const readOnly = state.offline || (mode === 'edit' && !cal?.writable);
  formCtx = { mode, event, readOnly, initial: event ? fieldsFromEvent(event) : null };

  const select = form.elements.calendarId;
  const options = mode === 'new' ? store.writableCalendars() : (cal ? [cal] : []);
  select.replaceChildren(...options.map((c) => h('option', { value: c.id }, c.name)));
  if (mode === 'edit' && !cal) select.append(h('option', { value: event.calendarId }, event.calendarId));
  select.disabled = mode === 'edit' || readOnly;

  writeForm(fields);
  for (const el of form.elements) {
    if (el.name && el.name !== 'calendarId') el.disabled = readOnly;
  }

  $('#event-dialog-title').textContent = readOnly ? '予定' : (mode === 'new' ? '予定を追加' : '予定を編集');
  $('#delete-btn').hidden = mode !== 'edit' || readOnly;
  $('#save-btn').hidden = readOnly;

  const note = [];
  if (readOnly && !state.offline) note.push('このカレンダーは閲覧のみです。');
  if (event?.recurring && !readOnly) note.push('繰り返し予定です。変更・削除はこの回だけに適用されます。');
  $('#event-note').textContent = note.join('');
  $('#event-note').hidden = !note.length;
  showFormError('');

  if ($('#day-dialog').open) $('#day-dialog').close();
  if (!$('#event-dialog').open) $('#event-dialog').showModal();
  if (mode === 'new') form.elements.title.focus();
}

function writeForm(f) {
  const els = $('#event-form').elements;
  els.title.value = f.title;
  if (f.calendarId) els.calendarId.value = f.calendarId;
  els.allDay.checked = f.allDay;
  els.startKey.value = f.startKey;
  els.startTime.value = f.startTime;
  els.endKey.value = f.endKey;
  els.endTime.value = f.endTime;
  els.description.value = f.description;
  updateTimeFields();
  rememberStart();
}

function readForm() {
  const els = $('#event-form').elements;
  return {
    title: els.title.value.trim(),
    calendarId: els.calendarId.value,
    allDay: els.allDay.checked,
    startKey: els.startKey.value,
    startTime: els.startTime.value,
    endKey: els.endKey.value,
    endTime: els.endTime.value,
    description: els.description.value,
  };
}

function updateTimeFields() {
  const allDay = $('#event-form').elements.allDay.checked;
  for (const el of document.querySelectorAll('#event-form .field.time')) el.hidden = allDay;
}

function minutes(time) {
  const [hh, mm] = time.split(':').map(Number);
  return hh * 60 + mm;
}

// 開始を変えたら、予定の長さを保ったまま終了もずらす
let lastStart = null;
function rememberStart() {
  const f = readForm();
  lastStart = { key: f.startKey, time: f.startTime };
}
function shiftEnd() {
  const els = $('#event-form').elements;
  const f = readForm();
  if (!lastStart || !f.startKey || !lastStart.key) { rememberStart(); return; }
  const before = D.diffDays('2000-01-01', lastStart.key) * 1440 + minutes(lastStart.time || '00:00');
  const after = D.diffDays('2000-01-01', f.startKey) * 1440 + minutes(f.startTime || '00:00');
  const end = D.diffDays('2000-01-01', f.endKey || f.startKey) * 1440 + minutes(f.endTime || '00:00');
  const newEnd = end + (after - before);
  els.endKey.value = D.addDays('2000-01-01', Math.floor(newEnd / 1440));
  const m = ((newEnd % 1440) + 1440) % 1440;
  els.endTime.value = `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
  rememberStart();
}

function showFormError(message) {
  $('#event-error').textContent = message;
  $('#event-error').hidden = !message;
}

function validate(f) {
  if (!f.calendarId) return '保存先のカレンダーを選んでください。';
  if (!f.startKey || !f.endKey) return '日付を入力してください。';
  if (f.allDay) {
    if (f.endKey < f.startKey) return '終了日は開始日以降にしてください。';
  } else {
    if (!f.startTime || !f.endTime) return '時刻を入力してください。';
    const start = D.toDateTime(f.startKey, f.startTime);
    const end = D.toDateTime(f.endKey, f.endTime);
    if (Date.parse(end) <= Date.parse(start)) return '終了は開始より後にしてください。';
  }
  return '';
}

function timesBody(f, switching) {
  // 終日⇔時刻ありを切り替えるときは、もう一方の項目を null で消す
  if (f.allDay) {
    const clear = switching ? { dateTime: null, timeZone: null } : {};
    return {
      start: { date: f.startKey, ...clear },
      end: { date: D.addDays(f.endKey, 1), ...clear }, // APIの終了日は「含まない日」
    };
  }
  const clear = switching ? { date: null } : {};
  return {
    start: { dateTime: D.toDateTime(f.startKey, f.startTime), timeZone: CONFIG.timeZone, ...clear },
    end: { dateTime: D.toDateTime(f.endKey, f.endTime), timeZone: CONFIG.timeZone, ...clear },
  };
}

function timesChanged(a, b) {
  if (a.allDay !== b.allDay || a.startKey !== b.startKey || a.endKey !== b.endKey) return true;
  return !a.allDay && (a.startTime !== b.startTime || a.endTime !== b.endTime);
}

async function submitEvent(e) {
  e.preventDefault();
  if (!formCtx || formCtx.readOnly) return;
  const f = readForm();
  const message = validate(f);
  if (message) { showFormError(message); return; }

  setFormBusy(true);
  try {
    if (formCtx.mode === 'new') {
      await api.insertEvent(f.calendarId, {
        summary: f.title,
        description: f.description || undefined,
        ...timesBody(f, false),
      });
      save(KEY_LAST_CALENDAR, f.calendarId);
    } else {
      const init = formCtx.initial;
      const changes = {};
      if (f.title !== init.title) changes.summary = f.title;
      if (f.description !== init.description) changes.description = f.description;
      if (timesChanged(f, init)) Object.assign(changes, timesBody(f, f.allDay !== init.allDay));
      if (Object.keys(changes).length) {
        await api.patchEvent(formCtx.event.calendarId, formCtx.event.id, changes);
      }
    }
    closeEventForm();
    refresh();
  } catch (err) {
    handleFormError(err);
  } finally {
    setFormBusy(false);
  }
}

async function deleteCurrentEvent() {
  const ev = formCtx?.event;
  if (!ev) return;
  const extra = ev.recurring ? '\n（繰り返し予定のこの回だけを削除します）' : '';
  if (!confirm(`「${ev.title}」を削除しますか？${extra}`)) return;
  setFormBusy(true);
  try {
    await api.deleteEvent(ev.calendarId, ev.id);
    closeEventForm();
    refresh();
  } catch (err) {
    handleFormError(err);
  } finally {
    setFormBusy(false);
  }
}

function handleFormError(err) {
  if (err.auth) {
    // 入力内容を残してトークンを取り直す。戻ってきたらフォームを開き直す
    saveResume();
    if (auth.refreshSilently()) return;
    state.needsLogin = true;
    renderChrome();
    showFormError('ログインの有効期限が切れました。画面上部の「再ログイン」を押してください（入力内容は保持されます）。');
  } else if (err.network) {
    showFormError('通信できませんでした。電波の良いところでもう一度お試しください。');
  } else {
    showFormError(err.message);
  }
}

function setFormBusy(on) {
  $('#save-btn').disabled = on;
  $('#delete-btn').disabled = on;
}

function closeEventForm() {
  formCtx = null;
  if ($('#event-dialog').open) $('#event-dialog').close();
}

/* ---------- メニュー ---------- */

function openMenu() {
  const email = auth.getEmail();
  $('#menu-account').textContent = email ? `ログイン中: ${email}` : '';
  $('#menu-calendars').replaceChildren(...store.calendars.map((c) => h('li', {},
    h('i', { class: 'dot', style: { background: c.color } }),
    h('span', {}, c.name),
    c.writable ? null : h('span', { class: 'muted small' }, '閲覧のみ'))));
  $('#menu-dialog').showModal();
}

function logout() {
  if (!confirm('ログアウトしますか？')) return;
  auth.logout();
  store.clearCache();
  save(KEY_RESUME, null);
  save(KEY_LAST_CALENDAR, null);
  save(KEY_VIEW, null);
  location.reload();
}

/* ---------- 操作の登録 ---------- */

function moveMonth(delta) {
  const { y, m } = D.parts(state.month);
  state.month = D.monthKey(y, m + delta);
  saveView();
  refresh();
}

function bindUi() {
  $('#login-btn').addEventListener('click', () => auth.login());
  $('#prev-btn').addEventListener('click', () => moveMonth(-1));
  $('#next-btn').addEventListener('click', () => moveMonth(1));
  $('#today-btn').addEventListener('click', () => {
    const { y, m } = D.parts(D.todayKey());
    state.month = D.monthKey(y, m);
    saveView();
    if (state.view === 'list') window.scrollTo({ top: 0 });
    refresh();
  });
  for (const btn of document.querySelectorAll('.seg button')) {
    btn.addEventListener('click', () => {
      if (state.view === btn.dataset.view) return;
      state.view = btn.dataset.view;
      saveView();
      window.scrollTo({ top: 0 });
      refresh();
    });
  }
  $('#add-btn').addEventListener('click', () => {
    const today = D.todayKey();
    const inMonth = state.view === 'month' && !today.startsWith(state.month.slice(0, 7));
    openNewEvent(inMonth ? state.month : today);
  });
  $('#day-add-btn').addEventListener('click', () => openNewEvent(dayDialogKey));
  $('#menu-btn').addEventListener('click', openMenu);
  $('#reload-btn').addEventListener('click', () => { $('#menu-dialog').close(); refresh({ reloadCalendars: true }); });
  $('#logout-btn').addEventListener('click', logout);

  const form = $('#event-form');
  form.addEventListener('submit', submitEvent);
  form.elements.allDay.addEventListener('change', updateTimeFields);
  form.elements.startKey.addEventListener('change', shiftEnd);
  form.elements.startTime.addEventListener('change', shiftEnd);
  $('#delete-btn').addEventListener('click', deleteCurrentEvent);
  $('#event-dialog').addEventListener('close', () => { formCtx = null; });

  for (const btn of document.querySelectorAll('[data-close]')) {
    btn.addEventListener('click', () => btn.closest('dialog').close());
  }
  // シートの外側（背景）をタップしたら閉じる
  for (const dialog of document.querySelectorAll('dialog')) {
    dialog.addEventListener('click', (e) => { if (e.target === dialog) dialog.close(); });
  }

  // 月表示は左右のスワイプで月を移動
  let touch = null;
  $('#main').addEventListener('touchstart', (e) => {
    const t = e.touches[0];
    touch = { x: t.clientX, y: t.clientY };
  }, { passive: true });
  $('#main').addEventListener('touchend', (e) => {
    if (!touch || state.view !== 'month') return;
    const t = e.changedTouches[0];
    const dx = t.clientX - touch.x;
    const dy = t.clientY - touch.y;
    touch = null;
    if (Math.abs(dx) > 60 && Math.abs(dy) < 40) moveMonth(dx < 0 ? 1 : -1);
  });

  let resizeTimer;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => { if (state.view === 'month') renderMonth(); }, 150);
  });
}

init();
