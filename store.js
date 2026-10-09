// カレンダーと予定の読み込み・保存、オフライン用のキャッシュ
import { CONFIG } from './config.js?v=13';
import * as api from './api.js?v=13';
import * as D from './dates.js?v=13';

// キャッシュの形式を変えたら CACHE_SCHEMA を上げる。古い形式のキャッシュは読まずに捨てる
// （古い形式の予定を表示しようとして画面が止まるのを防ぐため）。
const CACHE_SCHEMA = 6;
const KEY_CALENDARS = `oc.cache.v${CACHE_SCHEMA}.calendars`;
const KEY_EVENTS = `oc.cache.v${CACHE_SCHEMA}.events`;
const KEY_OVERRIDDEN = `oc.cache.v${CACHE_SCHEMA}.overridden`;
const MAX_CACHED_RANGES = 8;
export const PERSONS = Object.keys(CONFIG.people); // ['cat', 'fish']

function load(key) {
  try { return JSON.parse(localStorage.getItem(key)); } catch { return null; }
}
function save(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* 容量不足などは無視 */ }
}

async function sha256(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');
}

function isHoliday(id) {
  return id.includes('#holiday@');
}

function personOfHash(hash) {
  return PERSONS.find((p) => CONFIG.people[p].calendars.includes(hash)) || null;
}

// 2人のカレンダーは人の色、それ以外（祝日など）はすべて緑
function colorFor(id, person) {
  if (person) return CONFIG.people[person].color;
  return CONFIG.calendarColors[id] || CONFIG.otherColor;
}

function rank(cal) {
  if (cal.person) return PERSONS.indexOf(cal.person);
  if (cal.holiday) return PERSONS.length + 1;
  return PERSONS.length;
}

function removeOldCaches() {
  try {
    for (const key of Object.keys(localStorage)) {
      if (key.startsWith('oc.cache.') && ![KEY_CALENDARS, KEY_EVENTS, KEY_OVERRIDDEN].includes(key)) localStorage.removeItem(key);
    }
  } catch { /* 無視 */ }
}
removeOldCaches();

export let calendars = load(KEY_CALENDARS) || [];

// アプリで書き換えた・非表示にした元の予定（sourceKey の集合）。アプリには表示しない
let overridden = new Set(load(KEY_OVERRIDDEN) || []);

export function calendarById(id) {
  return calendars.find((c) => c.id === id);
}

export function primaryCalendar() {
  return calendars.find((c) => c.primary);
}

// ログイン中の人（自分のメインカレンダーがどちらの人のものか）
export function selfPerson() {
  return primaryCalendar()?.person || null;
}

// 新しい予定の保存先。誰の予定かは予定自体に持たせるので、保存先はログイン中の人のカレンダーでよい
export function saveCalendar() {
  const primary = primaryCalendar();
  if (primary?.writable) return primary;
  return calendars.find((c) => c.person && c.writable) || null;
}

export async function loadCalendars() {
  const items = await api.listCalendars();
  const list = await Promise.all(items.map(async (c) => {
    const hash = await sha256(c.id.toLowerCase());
    const person = personOfHash(hash);
    return {
      id: c.id,
      hash,
      name: CONFIG.calendarNames[c.id] || c.summaryOverride || c.summary || c.id,
      color: colorFor(c.id, person),
      person,
      primary: !!c.primary,
      holiday: isHoliday(c.id),
      writable: c.accessRole === 'owner' || c.accessRole === 'writer',
    };
  }));
  calendars = list.sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name, 'ja'));
  save(KEY_CALENDARS, calendars);
  return calendars;
}

function sortEvents(events) {
  // 終日を先に、次に開始時刻順
  return events.sort((a, b) =>
    a.startKey.localeCompare(b.startKey) ||
    Number(b.allDay) - Number(a.allDay) ||
    a.startMs - b.startMs ||
    a.title.localeCompare(b.title, 'ja'));
}

// アプリに表示しない予定か（アプリの表示から外すだけで、Googleカレンダーからは削除しない）
function isHiddenEvent(ev, cal) {
  if (ev.converted || ev.marker) return true;
  if (overridden.has(D.sourceKey(cal.id, ev.id))) return true;
  const before = CONFIG.hideGoogleEventsBefore;
  return !!before && !ev.appFormat && !cal.holiday && ev.endKey < before;
}

/* ---------- Googleの予定をアプリ形式に変換（一度だけ使う） ---------- */

// 変換の候補：fromKey 以降（toKey まで）の、アプリ形式でも変換済みでもないGoogleの予定（祝日を除く）
export async function findConvertCandidates(fromKey, toKey) {
  const timeMin = D.startOfDayIso(fromKey);
  const timeMax = D.startOfDayIso(toKey);
  const lists = await Promise.all(calendars.filter((c) => !c.holiday).map(async (cal) => {
    const items = await api.listEvents(cal.id, timeMin, timeMax, CONFIG.timeZone);
    return items
      .filter((e) => e.status !== 'cancelled' && e.start)
      .map((raw) => D.normalizeEvent(raw, cal, PERSONS))
      .filter((ev) => !ev.appFormat && !ev.converted && !ev.marker && !overridden.has(D.sourceKey(cal.id, ev.id)));
  }));
  return sortEvents(lists.flat());
}

// 1件を変換する：新しいアプリ形式の予定を作り、元の予定には「変換済み」の印だけを付ける（削除しない）
export async function convertOne(original, fields) {
  await saveEvent(fields, null);
  await api.patchEvent(original.calendarId, original.id, {
    extendedProperties: { shared: { ocConverted: '1' } },
  });
}

// 直近の読み込みで失敗したカレンダー（画面に知らせるため）
export let loadErrors = [];

// fromKey 以上 toKey 未満の日付に重なる予定を全カレンダーから読み込む
export async function loadEvents(fromKey, toKey) {
  await loadOverrides();
  const errors = [];
  const timeMin = D.startOfDayIso(fromKey);
  const timeMax = D.startOfDayIso(toKey);
  const results = await Promise.all(calendars.map(async (cal) => {
    try {
      const items = await api.listEvents(cal.id, timeMin, timeMax, CONFIG.timeZone);
      return items
        .filter((e) => e.status !== 'cancelled' && e.start)
        .map((e) => D.normalizeEvent(e, cal, PERSONS))
        .filter((ev) => !isHiddenEvent(ev, cal));
    } catch (err) {
      // 1つのカレンダーが読めなくても他は表示する。ログインや通信の問題は呼び出し側へ
      if (err.auth || err.network) throw err;
      console.warn('カレンダーを読み込めませんでした', cal.name, err);
      errors.push(`${cal.name}（${err.message}）`);
      return [];
    }
  }));
  loadErrors = errors;
  const events = sortEvents(results.flat());
  cacheEvents(fromKey, toKey, events);
  return events;
}

// アプリで書き換え・非表示にした印を、2人のカレンダーから集める（日付に関係なくすべて）
async function loadOverrides() {
  const targets = calendars.filter((c) => c.person && !c.holiday);
  const lists = await Promise.all(targets.map(async (cal) => {
    try {
      return await api.listOverrides(cal.id);
    } catch (err) {
      if (err.auth || err.network) throw err;
      console.warn('書き換えの印を読み込めませんでした', cal.name, err);
      return null;
    }
  }));
  // 1つでも読めなかったら、前回の集合を使い続ける（元の予定が二重に出るのを防ぐ）
  if (lists.some((l) => l === null)) return;
  overridden = new Set(lists.flat()
    .filter((e) => e.status !== 'cancelled')
    .map((e) => e.extendedProperties?.shared?.ocSource)
    .filter(Boolean));
  save(KEY_OVERRIDDEN, [...overridden]);
}

function cacheEvents(fromKey, toKey, events) {
  const cache = load(KEY_EVENTS) || {};
  cache[`${fromKey}|${toKey}`] = { savedAt: Date.now(), events };
  const keys = Object.keys(cache).sort((a, b) => cache[b].savedAt - cache[a].savedAt);
  for (const k of keys.slice(MAX_CACHED_RANGES)) delete cache[k];
  save(KEY_EVENTS, cache);
}

// キャッシュから、指定の範囲を含むものを探す（なければ null）
export function cachedEvents(fromKey, toKey) {
  const cache = load(KEY_EVENTS) || {};
  const exact = cache[`${fromKey}|${toKey}`];
  if (exact) return exact.events;
  for (const [range, entry] of Object.entries(cache)) {
    const [f, t] = range.split('|');
    if (f <= fromKey && toKey <= t) {
      return entry.events.filter((e) => e.endKey >= fromKey && e.startKey < toKey);
    }
  }
  return null;
}

export function clearCache() {
  try {
    localStorage.removeItem(KEY_CALENDARS);
    localStorage.removeItem(KEY_EVENTS);
    localStorage.removeItem(KEY_OVERRIDDEN);
  } catch { /* 無視 */ }
  calendars = [];
  overridden = new Set();
}

/* ---------- 保存 ---------- */

export function isWritable(ev) {
  return !!calendarById(ev.calendarId)?.writable;
}

// アプリで編集できるか。祝日以外は、閲覧のみのカレンダーの予定や繰り返しの予定も編集できる
export function canEdit(ev) {
  const cal = calendarById(ev.calendarId);
  return !!cal && !cal.holiday && !!saveCalendar();
}

// その場で書き換える予定か（アプリで作った予定で、書き込めるカレンダーにあるもの）。
// それ以外（Googleカレンダーから入った予定など）は、元の予定には触らず、
// アプリ形式の予定を新しく作って元の予定をアプリで隠す（Google→アプリの一方向だけにするため）
export function editsInPlace(ev) {
  return ev.appFormat && isWritable(ev);
}

// フォームの値から、APIに渡す開始・終了を作る。
// f: { kind, multi, startKey, endKey, startTime, endTime, dueTime }
export function eventTimes(f) {
  const s = f.startKey;
  const e = f.kind === 'event' && f.multi ? f.endKey : s;
  const tz = CONFIG.timeZone;
  const at = (key, time) => ({ dateTime: D.toDateTime(key, time), timeZone: tz });
  const allDay = () => ({ mode: 'none', start: { date: s }, end: { date: D.addDays(e, 1) } });

  if (f.kind === 'task') {
    if (!f.dueTime) return allDay();
    return { mode: 'due', start: at(s, f.dueTime), end: at(s, f.dueTime) };
  }
  const st = f.startTime;
  const et = f.endTime;
  if (!st && !et) return allDay();
  if (st && !et) {
    // 開始だけ: 1日なら長さ0、複数日なら最終日の終わりまで
    return { mode: 'start', start: at(s, st), end: s === e ? at(s, st) : at(D.addDays(e, 1), '00:00') };
  }
  if (!st && et) {
    // 終了だけ: 1日なら長さ0、複数日なら初日の0時から
    return { mode: 'end', start: s === e ? at(e, et) : at(s, '00:00'), end: at(e, et) };
  }
  return { mode: 'both', start: at(s, st), end: at(e, et) };
}

function eventBody(f, times, { description, forPatch, source }) {
  const body = {
    summary: f.title,
    start: { ...times.start },
    end: { ...times.end },
    extendedProperties: {
      shared: {
        ocKind: f.kind,
        ocTime: times.mode,
        ocDone: f.kind === 'task' && f.done ? '1' : '0',
        ocPersons: f.persons.join(','),
      },
    },
  };
  // 書き換えた予定は、元の予定を隠し続けるための印を持ち続ける
  if (source) Object.assign(body.extendedProperties.shared, { ocOverride: '1', ocSource: source });
  if (description !== undefined) body.description = description;
  if (forPatch) {
    // 終日⇔時刻ありの切り替えに備えて、使わない側の項目を null で消す
    for (const k of ['start', 'end']) {
      if (body[k].date) Object.assign(body[k], { dateTime: null, timeZone: null });
      else body[k].date = null;
    }
  }
  return body;
}

function requireSaveCalendar() {
  const cal = saveCalendar();
  if (!cal) throw new Error('予定を保存できるカレンダーがありません。');
  return cal;
}

// 予定を保存する。original があれば、その予定を書き換える。
// アプリで作った予定はその場で更新する。descriptionChanged が false のときはメモを送らない。
// それ以外の予定は、元の予定には触らず、元を指す印を付けたアプリ形式の予定を新しく作る。
export async function saveEvent(f, original, { descriptionChanged = true } = {}) {
  const times = eventTimes(f);
  if (original && editsInPlace(original)) {
    const body = eventBody(f, times, {
      description: descriptionChanged ? f.description : undefined,
      forPatch: true,
      source: original.source,
    });
    await api.patchEvent(original.calendarId, original.id, body);
    return;
  }
  const cal = requireSaveCalendar();
  const source = original ? D.sourceKey(original.calendarId, original.id) : undefined;
  await api.insertEvent(cal.id, eventBody(f, times, { description: f.description || undefined, source }));
  if (source) overridden.add(source);
}

// 「非表示の印」だけの予定を作る（Googleカレンダーでは2000年1月1日に目立たない形で入る）
async function insertHiddenMarker(source) {
  const cal = requireSaveCalendar();
  await api.insertEvent(cal.id, {
    summary: 'our_calendar：非表示の印（削除しないでください）',
    start: { date: '2000-01-01' },
    end: { date: '2000-01-02' },
    transparency: 'transparent',
    extendedProperties: { shared: { ocOverride: '1', ocHidden: '1', ocSource: source } },
  });
  overridden.add(source);
}

// 予定を削除する。アプリで作った予定は本当に削除する（書き換えた予定なら、元の予定は隠したままにする）。
// それ以外の予定は、Googleカレンダーからは削除せず、アプリで隠すだけにする。
export async function deleteEvent(ev) {
  if (!editsInPlace(ev)) {
    await insertHiddenMarker(D.sourceKey(ev.calendarId, ev.id));
    return;
  }
  // 先に印を作ってから消す（途中で失敗しても、元の予定が二重に出ないように）
  if (ev.source) await insertHiddenMarker(ev.source);
  await api.deleteEvent(ev.calendarId, ev.id);
}
