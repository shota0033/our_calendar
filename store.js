// カレンダーと予定の読み込み、オフライン用のキャッシュ
import { CONFIG } from './config.js';
import * as api from './api.js';
import { normalizeEvent, startOfDayIso } from './dates.js';

const KEY_CALENDARS = 'oc.cache.calendars';
const KEY_EVENTS = 'oc.cache.events';
const MAX_CACHED_RANGES = 8;

function load(key) {
  try { return JSON.parse(localStorage.getItem(key)); } catch { return null; }
}
function save(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* 容量不足などは無視 */ }
}

function isHoliday(id) {
  return id.includes('#holiday@');
}

function colorFor(id) {
  if (CONFIG.calendarColors[id]) return CONFIG.calendarColors[id];
  if (isHoliday(id)) return CONFIG.holidayColor;
  let h = 0;
  for (const ch of id) h = (h * 31 + ch.codePointAt(0)) >>> 0;
  return CONFIG.palette[h % CONFIG.palette.length];
}

function rank(cal) {
  if (cal.primary) return 0;
  if (cal.writable) return 1;
  if (cal.holiday) return 3;
  return 2;
}

export let calendars = load(KEY_CALENDARS) || [];

export function calendarById(id) {
  return calendars.find((c) => c.id === id);
}

export function writableCalendars() {
  return calendars.filter((c) => c.writable);
}

export function primaryCalendar() {
  return calendars.find((c) => c.primary);
}

export async function loadCalendars() {
  const items = await api.listCalendars();
  calendars = items
    .map((c) => ({
      id: c.id,
      name: CONFIG.calendarNames[c.id] || c.summaryOverride || c.summary || c.id,
      color: colorFor(c.id),
      primary: !!c.primary,
      holiday: isHoliday(c.id),
      writable: c.accessRole === 'owner' || c.accessRole === 'writer',
    }))
    .sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name, 'ja'));
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

// fromKey 以上 toKey 未満の日付に重なる予定を全カレンダーから読み込む
export async function loadEvents(fromKey, toKey) {
  const timeMin = startOfDayIso(fromKey);
  const timeMax = startOfDayIso(toKey);
  const results = await Promise.all(calendars.map(async (cal) => {
    try {
      const items = await api.listEvents(cal.id, timeMin, timeMax, CONFIG.timeZone);
      return items
        .filter((e) => e.status !== 'cancelled' && e.start)
        .map((e) => normalizeEvent(e, cal));
    } catch (err) {
      // 1つのカレンダーが読めなくても他は表示する。ログインや通信の問題は呼び出し側へ
      if (err.auth || err.network) throw err;
      console.warn('カレンダーを読み込めませんでした', cal.name, err);
      return [];
    }
  }));
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
