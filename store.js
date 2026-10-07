// カレンダーと予定の読み込み・保存、オフライン用のキャッシュ
import { CONFIG } from './config.js?v=7';
import * as api from './api.js?v=7';
import * as D from './dates.js?v=7';

// キャッシュの形式を変えたら CACHE_SCHEMA を上げる。古い形式のキャッシュは読まずに捨てる
// （古い形式の予定を表示しようとして画面が止まるのを防ぐため）。
const CACHE_SCHEMA = 3;
const KEY_CALENDARS = `oc.cache.v${CACHE_SCHEMA}.calendars`;
const KEY_EVENTS = `oc.cache.v${CACHE_SCHEMA}.events`;
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

function colorFor(id, person) {
  if (CONFIG.calendarColors[id]) return CONFIG.calendarColors[id];
  if (person) return CONFIG.people[person].color;
  if (isHoliday(id)) return CONFIG.holidayColor;
  let h = 0;
  for (const ch of id) h = (h * 31 + ch.codePointAt(0)) >>> 0;
  return CONFIG.palette[h % CONFIG.palette.length];
}

function rank(cal) {
  if (cal.person) return PERSONS.indexOf(cal.person);
  if (cal.holiday) return PERSONS.length + 1;
  return PERSONS.length;
}

function removeOldCaches() {
  try {
    for (const key of Object.keys(localStorage)) {
      if (key.startsWith('oc.cache.') && key !== KEY_CALENDARS && key !== KEY_EVENTS) localStorage.removeItem(key);
    }
  } catch { /* 無視 */ }
}
removeOldCaches();

export let calendars = load(KEY_CALENDARS) || [];

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

// 表示しない古い予定か（アプリの表示から外すだけで、Googleカレンダーからは削除しない）
function isHiddenGoogleEvent(ev, cal) {
  const before = CONFIG.hideGoogleEventsBefore;
  return !!before && !ev.appFormat && !cal.holiday && ev.endKey < before;
}

// 直近の読み込みで失敗したカレンダー（画面に知らせるため）
export let loadErrors = [];

// fromKey 以上 toKey 未満の日付に重なる予定を全カレンダーから読み込む
export async function loadEvents(fromKey, toKey) {
  const errors = [];
  const timeMin = D.startOfDayIso(fromKey);
  const timeMax = D.startOfDayIso(toKey);
  const results = await Promise.all(calendars.map(async (cal) => {
    try {
      const items = await api.listEvents(cal.id, timeMin, timeMax, CONFIG.timeZone);
      return items
        .filter((e) => e.status !== 'cancelled' && e.start)
        .map((e) => D.normalizeEvent(e, cal, PERSONS))
        .filter((ev) => !isHiddenGoogleEvent(ev, cal));
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
  } catch { /* 無視 */ }
  calendars = [];
}

/* ---------- 保存 ---------- */

export function isWritable(ev) {
  return !!calendarById(ev.calendarId)?.writable;
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

function eventBody(f, times, { description, forPatch }) {
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

// 予定を保存する。original があれば、その予定をその場で更新する。
// descriptionChanged が false のときはメモを送らない（Google側のHTMLのメモを壊さないため）。
export async function saveEvent(f, original, { descriptionChanged = true } = {}) {
  const times = eventTimes(f);
  if (original) {
    const body = eventBody(f, times, { description: descriptionChanged ? f.description : undefined, forPatch: true });
    await api.patchEvent(original.calendarId, original.id, body);
    return;
  }
  const cal = saveCalendar();
  if (!cal) throw new Error('予定を保存できるカレンダーがありません。');
  await api.insertEvent(cal.id, eventBody(f, times, { description: f.description || undefined }));
}

export async function deleteEvent(ev) {
  await api.deleteEvent(ev.calendarId, ev.id);
}
