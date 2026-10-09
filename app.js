// 画面の表示と操作
import { CONFIG } from './config.js?v=19';
import * as auth from './auth.js?v=19';
import * as store from './store.js?v=19';
import * as D from './dates.js?v=19';
import * as form from './form.js?v=19';
import * as convert from './convert.js?v=19';
import { h, $ } from './dom.js?v=19';

const KEY_VIEW = 'oc.view';
const KEY_RESUME = 'oc.resume';
const KEY_FILTER = 'oc.filter';

// トークンの残りがこれより短ければ、先に取り直す
const REFRESH_BEFORE_EDIT_MS = 10 * 60 * 1000;
const REFRESH_ON_RETURN_MS = 10 * 60 * 1000;
const REFRESH_WHILE_OPEN_MS = 5 * 60 * 1000;
// アプリを開いている間、Googleカレンダー側の変更（メールから追加された予定など）を取り込む間隔
const POLL_MS = 60 * 1000;
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
  // カレンダー画面で表示する人（猫・魚のボタン）
  filter: loadFilter(),
};

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

function loadFilter() {
  const saved = load(KEY_FILTER);
  const persons = store.PERSONS.filter((p) => !saved || saved.includes(p));
  return persons.length ? persons : [...store.PERSONS];
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
  form.initForm({ onSaved: showSaved, onSaveError: handleSaveError });
  convert.initConvert({ onDone: () => refresh() });
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

  setInterval(poll, POLL_MS);
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
    navigator.serviceWorker.register('./sw.js?v=19').catch((err) => console.warn(err));
  }
}

/* ---------- ログイン（トークン）の更新 ---------- */

// Googleへ移動して戻ってきたときに、入力中のフォームを開き直すための情報を残す
function saveResume() {
  const draft = form.currentDraft();
  save(KEY_RESUME, draft ? { draft, savedAt: Date.now() } : null);
  saveView();
}

function resumeAfterLogin() {
  const resume = load(KEY_RESUME);
  if (!resume) return;
  if (Date.now() - resume.savedAt > RESUME_TTL_MS) { save(KEY_RESUME, null); return; }
  if (!auth.getToken()) return; // 再ログイン後に使うので残しておく
  save(KEY_RESUME, null);
  if (resume.draft) form.openForm(resume.draft.mode, resume.draft.event, resume.draft.fields);
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

// 定期的にトークンを確認し、最新の予定を読み込み直す（入力中や画面が裏にあるときはしない）
function poll() {
  if (maybeRefreshToken(REFRESH_WHILE_OPEN_MS)) return;
  if (document.visibilityState !== 'visible' || !navigator.onLine) return;
  if (document.querySelector('dialog.page[open]') || !auth.getToken()) return;
  refresh({ quiet: true });
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

async function refresh({ reloadCalendars = false, quiet = false } = {}) {
  const seq = ++state.loadSeq;
  const [from, to] = currentRange();
  if (!quiet) {
    state.events = store.cachedEvents(from, to) || [];
    try {
      render();
    } catch (err) {
      // キャッシュが壊れていても、Googleからの読み込みは続ける
      console.warn('キャッシュを表示できませんでした', err);
      store.clearCache();
      state.events = [];
      render();
    }
  }

  if (!auth.getToken()) { handleNoToken(); return; }

  if (!quiet) setLoading(true);
  try {
    if (reloadCalendars || !store.calendars.length) {
      await store.loadCalendars();
      const primary = store.primaryCalendar();
      if (primary) auth.setEmail(primary.id); // メインカレンダーのIDはメールアドレス
    }
    const events = await store.loadEvents(from, to);
    if (seq !== state.loadSeq) return;
    // 定期読み込みで何も変わっていなければ、描き直さない（画面のちらつきを防ぐ）
    const changed = !quiet || state.offline || state.needsLogin || state.error ||
      JSON.stringify(events) !== JSON.stringify(state.events);
    const loadError = store.loadErrors.length
      ? `読み込めなかったカレンダーがあります：${store.loadErrors.join('、')}` : '';
    state.events = events;
    state.offline = false;
    state.needsLogin = false;
    if (state.error !== loadError) { state.error = loadError; render(); return; }
    if (changed) render();
  } catch (err) {
    if (seq === state.loadSeq && !(quiet && err.network)) handleError(err);
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
  for (const btn of document.querySelectorAll('.view-seg button')) {
    btn.setAttribute('aria-selected', String(btn.dataset.view === state.view));
  }
  for (const btn of document.querySelectorAll('#filters button')) {
    btn.setAttribute('aria-pressed', String(state.filter.includes(btn.dataset.person)));
  }
  $('#add-btn').hidden = state.offline || (store.calendars.length > 0 && !store.saveCalendar());
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

function eventColor(ev) {
  if (ev.persons.length > 1) return CONFIG.bothColor;
  if (ev.persons.length === 1) return CONFIG.people[ev.persons[0]].color;
  return store.calendarById(ev.calendarId)?.color || '#888';
}

// 猫・魚のボタンで表示する人を絞り込む（2人以外のカレンダー、祝日などはいつも表示）
function visibleEvents() {
  return state.events.filter((ev) => !ev.persons.length || ev.persons.some((p) => state.filter.includes(p)));
}

function toggleFilter(person) {
  const on = state.filter.includes(person);
  if (on && state.filter.length === 1) return; // 少なくとも1人は表示する
  state.filter = on ? state.filter.filter((p) => p !== person)
    : store.PERSONS.filter((p) => p === person || state.filter.includes(p));
  save(KEY_FILTER, state.filter);
  render();
}

function personIcons(ev) {
  return ev.persons.map((p) => CONFIG.people[p].icon).join('');
}

function displayTitle(ev) {
  if (ev.kind !== 'task') return ev.title;
  return `${ev.done ? '☑' : '☐'} ${ev.title}`;
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

// 1マスに表示する帯の数。スマホでは、マスの高さに入るだけ表示する（少なくとも3件）
// all: すべて帯で表示できる数、withMore: 「他n件」を出すときの帯の数
// rowH: マスの高さ（実際に表示した高さ。わからなければ画面の高さから見積もる）
function chipsPerCell(weeks, rowH) {
  if (window.innerWidth >= 600) {
    const n = window.innerWidth >= 900 ? 5 : 3;
    return { all: n, withMore: n };
  }
  // styles.css のスマホ用の値：日付 20.5px＋余白 3px、帯 29px（2行 26px＋間隔 3px）、「他n件」14px
  if (!rowH) {
    const top = document.documentElement.style.getPropertyValue('--month-top');
    rowH = (window.innerHeight - (parseFloat(top) || 120) - 20) / weeks; // 20: 曜日の行
  }
  return {
    all: Math.max(1, Math.floor((rowH - 23.5 + 3) / 29)),
    withMore: Math.max(1, Math.floor((rowH - 23.5 - 14) / 29)),
  };
}

function renderMonth(rowH) {
  // スマホで月のカレンダーを画面の下まで広げるため、上部バーなどの高さを渡す
  const top = $('#main').getBoundingClientRect().top + window.scrollY;
  document.documentElement.style.setProperty('--month-top', `${Math.round(top)}px`);

  const start = gridStart(state.month);
  const monthPrefix = state.month.slice(0, 7);
  // その月の日が入っている週だけ表示する（5週で収まる月は、マスを縦に広く使う）
  let weeks = 6;
  while (weeks > 4 && !D.addDays(start, (weeks - 1) * 7).startsWith(monthPrefix)) weeks--;
  const end = D.addDays(start, weeks * 7);
  const byDay = groupByDay(visibleEvents(), start, end);
  const today = D.todayKey();
  const maxChips = chipsPerCell(weeks, rowH);
  const canHover = matchMedia('(hover: hover)').matches;

  const head = D.WEEKDAYS.map((w, i) =>
    h('div', { class: `wd ${i === 0 ? 'sun' : ''} ${i === 6 ? 'sat' : ''}` }, w));

  const cells = [];
  for (let i = 0; i < weeks * 7; i++) {
    const key = D.addDays(start, i);
    const events = byDay.get(key) || [];
    const wd = i % 7;
    const classes = ['cell'];
    if (!key.startsWith(monthPrefix)) classes.push('other');
    if (key === today) classes.push('today');
    if (wd === 0 || events.some(isHolidayEvent)) classes.push('sun');
    else if (wd === 6) classes.push('sat');

    // 終日も時刻ありも、すべて色の帯で表示する。
    // スマホでは帯を2行にし、時刻のある予定は1行目に時刻、2行目にタイトルを出す（styles.css）
    // 入りきらないときは、最後の1行を「他n件」にする
    const shown = events.length > maxChips.all ? maxChips.withMore : events.length;
    const chips = events.slice(0, shown).map((ev) => {
      const onclick = canHover ? (e) => { e.stopPropagation(); openEvent(ev); } : null;
      const showTime = !ev.allDay && ev.startKey === ev.endKey;
      const cls = `chip bar${showTime ? ' timed' : ''}${ev.kind === 'task' && ev.done ? ' done' : ''}`;
      return h('div', { class: cls, style: { background: eventColor(ev) }, onclick },
        showTime ? h('span', { class: 't' }, ev.timeMode === 'end' ? `〜${ev.endTime}` : ev.startTime) : null,
        h('span', { class: 'n' }, displayTitle(ev)));
    });
    if (events.length > shown) chips.push(h('div', { class: 'more' }, `他${events.length - shown}件`));

    cells.push(h('div', { class: classes.join(' '), onclick: () => openDay(key) },
      h('div', { class: 'num' }, D.parts(key).d),
      chips));
  }

  $('#main').replaceChildren(h('div', { class: 'month', style: { '--weeks': weeks } }, head, cells));

  // 見積もりと実際のマスの高さで入る数が違ったら、実際の高さで描き直す
  if (!rowH && window.innerWidth < 600) {
    const actual = $('#main .cell')?.getBoundingClientRect().height;
    const fit = actual && chipsPerCell(weeks, actual);
    if (fit && (fit.all !== maxChips.all || fit.withMore !== maxChips.withMore)) renderMonth(actual);
  }
}

function timeText(ev) {
  const multi = ev.startKey !== ev.endKey;
  const sd = D.formatShort(ev.startKey);
  const ed = D.formatShort(ev.endKey);
  if (ev.kind === 'task') return ev.allDay ? '期限' : `${ev.startTime}まで`;
  if (ev.allDay) return multi ? `終日〜${ed}` : '終日';
  switch (ev.timeMode) {
    case 'start': return multi ? `${sd} ${ev.startTime}〜${ed}` : `${ev.startTime}〜`;
    case 'end': return multi ? `${sd}〜${ed} ${ev.endTime}` : `〜${ev.endTime}`;
    default: return multi ? `${sd} ${ev.startTime}〜${ed} ${ev.endTime}` : `${ev.startTime}–${ev.endTime}`;
  }
}

function eventRow(ev) {
  const cal = store.calendarById(ev.calendarId);
  const who = ev.persons.length ? personIcons(ev) : cal?.name;
  return h('button', {
    class: `event-row${ev.kind === 'task' && ev.done ? ' done' : ''}`,
    type: 'button',
    onclick: () => openEvent(ev),
  },
  h('i', { class: 'bar', style: { background: eventColor(ev) } }),
  h('span', { class: 'time' }, timeText(ev)),
  h('span', { class: 'body' },
    h('span', { class: 'name' }, displayTitle(ev)),
    who ? h('span', { class: 'cal' }, who) : null));
}

function renderList() {
  const [from, to] = currentRange();
  const today = D.todayKey();
  // 複数日の予定は、始まる日（範囲より前に始まったものは範囲の初日）に1回だけ表示する
  const byDay = new Map();
  for (const ev of visibleEvents()) {
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
  const events = groupByDay(visibleEvents(), key, D.addDays(key, 1)).get(key) || [];
  $('#day-events').replaceChildren(...(events.length
    ? events.map(eventRow)
    : [h('p', { class: 'empty' }, '予定はありません')]));
}

/* ---------- 予定フォーム ---------- */

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
  const fields = form.defaultFields(dayKey);
  if (navigator.onLine && auth.remainingMs() < REFRESH_BEFORE_EDIT_MS) {
    if (redirectWithDraft({ mode: 'new', event: null, fields })) return;
  }
  closeDayDialog();
  form.openForm('new', null, fields);
}

function openEvent(ev) {
  const fields = form.fieldsFromEvent(ev);
  if (store.canEdit(ev) && !state.offline && navigator.onLine && auth.remainingMs() < REFRESH_BEFORE_EDIT_MS) {
    if (redirectWithDraft({ mode: 'edit', event: ev, fields })) return;
  }
  closeDayDialog();
  form.openForm('edit', ev, fields, { offline: state.offline });
}

function closeDayDialog() {
  if ($('#day-dialog').open) $('#day-dialog').close();
}

// 保存したら、その予定が見える月に移動して読み込み直す
function showSaved(dayKey) {
  if (dayKey && state.view === 'month' && !dayKey.startsWith(state.month.slice(0, 7))) {
    const { y, m } = D.parts(dayKey);
    state.month = D.monthKey(y, m);
    saveView();
  }
  refresh();
}

function handleSaveError(err) {
  if (err.auth) {
    // 入力内容を残してトークンを取り直す。戻ってきたらフォームを開き直す
    saveResume();
    if (auth.refreshSilently()) return;
    state.needsLogin = true;
    renderChrome();
    form.showError('ログインの有効期限が切れました。閉じずに、画面上部の「再ログイン」を押してください（入力内容は保持されます）。');
  } else if (err.network) {
    form.showError('通信できませんでした。電波の良いところでもう一度お試しください。');
  } else {
    form.showError(err.message);
    refresh(); // 一部だけ保存できた場合に備えて読み込み直す
  }
}

/* ---------- メニュー ---------- */

function openMenu() {
  const email = auth.getEmail();
  $('#menu-account').textContent = email ? `ログイン中: ${email}` : '';
  $('#menu-calendars').replaceChildren(...store.calendars.map((c) => h('li', {},
    h('i', { class: 'dot', style: { background: c.color } }),
    h('span', {}, c.person ? `${CONFIG.people[c.person].icon} ${c.name}` : c.name),
    c.writable ? null : h('span', { class: 'muted small' }, '閲覧のみ'))));
  $('#menu-dialog').showModal();
}

function logout() {
  if (!confirm('ログアウトしますか？')) return;
  auth.logout();
  store.clearCache();
  save(KEY_RESUME, null);
  save(KEY_FILTER, null);
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
  $('#filters').replaceChildren(...store.PERSONS.map((p) => h('button', {
    type: 'button',
    class: 'filter-btn',
    'data-person': p,
    'aria-label': `${CONFIG.people[p].label}の予定を表示`,
    style: { '--person-color': CONFIG.people[p].color },
    onclick: () => toggleFilter(p),
  }, CONFIG.people[p].icon)));
  for (const btn of document.querySelectorAll('.view-seg button')) {
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
  $('#convert-btn').addEventListener('click', () => {
    $('#menu-dialog').close();
    if (state.offline || !navigator.onLine) return;
    // 変換の途中でトークンが切れないよう、残りが短ければ先に取り直す
    if (auth.remainingMs() < REFRESH_BEFORE_EDIT_MS && redirectForToken()) return;
    convert.openConvert();
  });

  for (const btn of document.querySelectorAll('[data-close]')) {
    btn.addEventListener('click', () => btn.closest('dialog').close());
  }
  // シートの外側（背景）をタップしたら閉じる
  for (const dialog of document.querySelectorAll('dialog.sheet')) {
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
