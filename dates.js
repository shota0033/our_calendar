// 日付の計算。表示・入力はすべて日本時間で扱う（端末のタイムゾーンに左右されない）。
// 日本時間には夏時間がないので、UTCに9時間足した時刻を UTC のメソッドで読む。
// 日付は 'YYYY-MM-DD' 形式の文字列（以下「日付キー」）で扱う。

const OFFSET_MS = 9 * 60 * 60 * 1000;
const OFFSET_TEXT = '+09:00';
const DAY_MS = 24 * 60 * 60 * 1000;

export const WEEKDAYS = ['日', '月', '火', '水', '木', '金', '土'];

const pad = (n) => String(n).padStart(2, '0');

function keyFromUtcDate(d) {
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

function utcDateFromKey(key) {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

export function keyFromMs(ms) {
  return keyFromUtcDate(new Date(ms + OFFSET_MS));
}

export function timeFromMs(ms) {
  const d = new Date(ms + OFFSET_MS);
  return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}

export function todayKey() {
  return keyFromMs(Date.now());
}

export function addDays(key, n) {
  return keyFromUtcDate(new Date(utcDateFromKey(key).getTime() + n * DAY_MS));
}

export function diffDays(fromKey, toKey) {
  return Math.round((utcDateFromKey(toKey) - utcDateFromKey(fromKey)) / DAY_MS);
}

export function weekday(key) {
  return utcDateFromKey(key).getUTCDay();
}

export function parts(key) {
  const [y, m, d] = key.split('-').map(Number);
  return { y, m, d };
}

export function monthKey(y, m) {
  // m は 1〜12。範囲外なら年をまたいで調整する
  const d = new Date(Date.UTC(y, m - 1, 1));
  return keyFromUtcDate(d);
}

// 日付キー＋'HH:MM' を、APIに渡す日時文字列にする
export function toDateTime(key, time) {
  return `${key}T${time}:00${OFFSET_TEXT}`;
}

// 日付キー（日本時間の0時）をAPIの timeMin / timeMax 用にする
export function startOfDayIso(key) {
  return toDateTime(key, '00:00');
}

export function formatDayLabel(key) {
  const { m, d } = parts(key);
  return `${m}月${d}日（${WEEKDAYS[weekday(key)]}）`;
}

export function formatShort(key) {
  const { m, d } = parts(key);
  return `${m}/${d}`;
}

// APIの予定を、表示に使う形にそろえる。
// Googleカレンダーはこのアプリのデータ置き場として使い、アプリ独自の情報は
// extendedProperties.shared に持つ:
//   ocKind: 'event' | 'task'
//   ocTime: 'start'（開始だけ）| 'end'（終了だけ）| 'both' | 'due'（タスクの期限時刻）
//   ocDone: '1'（タスク完了）
//   ocPersons: 'cat' / 'fish' / 'cat,fish'（誰の予定か）
// ocPersons がない予定（メールから追加したものなど）は、入っているカレンダーで誰の予定かを決める。
export function normalizeEvent(raw, calendar, knownPersons) {
  const allDay = !!raw.start?.date;
  let startKey, endKey, startMs, endMs;
  if (allDay) {
    startKey = raw.start.date;
    endKey = addDays(raw.end?.date || addDays(startKey, 1), -1); // APIの終了日は翌日（含まない）
    if (endKey < startKey) endKey = startKey;
    startMs = utcDateFromKey(startKey).getTime() - OFFSET_MS;
    endMs = utcDateFromKey(endKey).getTime() - OFFSET_MS + DAY_MS;
  } else {
    startMs = Date.parse(raw.start.dateTime);
    endMs = Date.parse(raw.end?.dateTime || raw.start.dateTime);
    startKey = keyFromMs(startMs);
    // ちょうど0時に終わる予定は、翌日に表示しない
    endKey = endMs > startMs ? keyFromMs(endMs - 1) : startKey;
  }

  const shared = raw.extendedProperties?.shared || {};
  const kind = shared.ocKind === 'task' ? 'task' : 'event';
  const summary = raw.summary || '';
  const tagged = (shared.ocPersons || '').split(',').filter((p) => knownPersons.includes(p));
  const persons = tagged.length ? tagged : (calendar.person ? [calendar.person] : []);
  let timeMode = 'none';
  if (!allDay) {
    timeMode = ['start', 'end', 'both', 'due'].includes(shared.ocTime)
      ? shared.ocTime
      : (endMs === startMs ? 'start' : 'both');
  }

  return {
    id: raw.id,
    calendarId: calendar.id,
    title: summary || '（タイトルなし）',
    summary,
    description: raw.description || '',
    allDay,
    startKey,
    endKey,
    startMs,
    endMs,
    startTime: allDay ? '' : timeFromMs(startMs),
    endTime: allDay ? '' : timeFromMs(endMs),
    timeMode,
    kind,
    done: shared.ocDone === '1',
    persons,
    recurring: !!raw.recurringEventId,
    htmlLink: raw.htmlLink || '',
  };
}
