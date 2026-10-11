// our_calendar の通知（Google Apps Script）。
// 5分ごとに動き、次の2つをカレンダーのアプリに通知する（通知の中継 worker/push.js を通す）。
//   1. 毎朝6時：今日の全員の予定と、自分のタスク（期限の5日前・2日前・1日前・当日）
//   2. 相手が予定を追加・削除したとき：もう1人に知らせる（タスクは、対象の人にだけ）
//      削除は、アプリで削除したときに削除した人のカレンダーに残る「削除の記録」（ocDelLog）で知る
// 設定のしかたは gas/README.md を参照。
// 送り先は、公開しないよう「スクリプト プロパティ」に入れる：
//   PUSH_URL, PUSH_SECRET … 通知の中継（worker/push.js）の URL と合言葉

const TZ = 'Asia/Tokyo';

// 毎朝の通知の時刻（時）。この時刻から DAILY_UNTIL_HOUR 時までの間に1回だけ送る
const DAILY_HOUR = 6;
const DAILY_UNTIL_HOUR = 10;
// タスクを知らせる日（期限の何日前か。0 は当日）
const TASK_REMIND_DAYS = [5, 2, 1, 0];
// この時間より前に作られた予定は、「追加された」として知らせない（同期の再開時などに古い予定を送らないため）
const NEW_EVENT_WINDOW_MS = 60 * 60 * 1000;

// 2人の設定（アプリの config.js と同じ。カレンダーIDの SHA-256）
const PEOPLE = {
  cat: {
    icon: '🐱',
    nickname: 'しょーちゃん',
    calendars: ['a8e58c5914793c26c3a45e4b040749723482ed57030ab1fe7e668268fbf83ccd'],
  },
  fish: {
    icon: '🐟',
    nickname: 'にゃんちゃん',
    calendars: [
      '1fd1ef0de0e58cf6a5b6f09dc1b3ef788ef8fb3a64c27de79981dcf966da5f0d',
      '436cf38ebc67fc09757130a27f4310cf5bde6dab5fdcb6c804908d5b648f771d',
    ],
  },
};
const PERSONS = Object.keys(PEOPLE);
const WEEKDAYS = ['日', '月', '火', '水', '木', '金', '土'];

/* ---------- 入口 ---------- */

// 最初に1回だけ実行する（送り先を変えたときも、もう一度実行してよい）：
// 5分ごとのトリガーを作り、見つかったカレンダーを記録し、試しの通知を送る
function setup() {
  for (const t of ScriptApp.getProjectTriggers()) {
    if (t.getHandlerFunction() === 'tick') ScriptApp.deleteTrigger(t);
  }
  ScriptApp.newTrigger('tick').timeBased().everyMinutes(5).create();

  for (const cal of loadCalendars()) {
    console.log(`${cal.person ? PEOPLE[cal.person].icon : '　'} ${cal.name}${cal.holiday ? '（祝日）' : ''}`);
  }
  const props = PropertiesService.getScriptProperties();
  if (!props.getProperty('PUSH_URL') || !props.getProperty('PUSH_SECRET')) {
    throw new Error('スクリプト プロパティに、PUSH_URL と PUSH_SECRET を入れてください');
  }
  checkNewEvents(); // 最初は、今ある予定を覚えるだけ（通知しない）
  for (const p of PERSONS) send(p, '通知の設定ができました', `${PEOPLE[p].icon} ${PEOPLE[p].nickname}のスマホに届いています`);
  console.log('設定しました。5分ごとに動きます');
}

// 毎朝の通知を、時刻に関係なく今すぐ送る（確かめる用）
function testDaily() {
  for (const p of PERSONS) send(p, ...dailyMessage(p, todayKey()));
}

// 5分ごとに動く
function tick() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(1000)) return; // 前の回がまだ動いている
  try {
    checkNewEvents();
    maybeSendDaily();
  } finally {
    lock.releaseLock();
  }
}

/* ---------- カレンダー ---------- */

function sha256(text) {
  const bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, text, Utilities.Charset.UTF_8);
  return bytes.map((b) => ((b + 256) % 256).toString(16).padStart(2, '0')).join('');
}

function personOfCalendar(id) {
  const hash = sha256(id.toLowerCase());
  return PERSONS.find((p) => PEOPLE[p].calendars.includes(hash)) || null;
}

// このアカウントから見えるカレンダー（アプリと同じく、すべて）
function loadCalendars() {
  const list = [];
  let pageToken;
  do {
    const res = Calendar.CalendarList.list({ pageToken, maxResults: 250 });
    for (const c of res.items || []) {
      list.push({
        id: c.id,
        name: c.summaryOverride || c.summary || c.id,
        person: personOfCalendar(c.id),
        holiday: c.id.includes('#holiday@'),
      });
    }
    pageToken = res.nextPageToken;
  } while (pageToken);
  return list;
}

function listEvents(calendarId, fromKey, toKey) {
  const items = [];
  let pageToken;
  do {
    const res = Calendar.Events.list(calendarId, {
      timeMin: `${fromKey}T00:00:00+09:00`,
      timeMax: `${toKey}T00:00:00+09:00`,
      singleEvents: true,
      maxResults: 2500,
      timeZone: TZ,
      pageToken,
    });
    items.push(...(res.items || []));
    pageToken = res.nextPageToken;
  } while (pageToken);
  return items.filter((e) => e.status !== 'cancelled' && e.start);
}

// アプリで書き換え・非表示にした元の予定（「カレンダーID|予定ID」の集合）。アプリと同じく表示しない
function loadOverridden(calendars) {
  const set = new Set();
  for (const cal of calendars.filter((c) => c.person)) {
    let pageToken;
    do {
      const res = Calendar.Events.list(cal.id, {
        sharedExtendedProperty: 'ocOverride=1',
        maxResults: 2500,
        pageToken,
      });
      for (const e of res.items || []) {
        const src = e.extendedProperties?.shared?.ocSource;
        if (e.status !== 'cancelled' && src) set.add(src);
      }
      pageToken = res.nextPageToken;
    } while (pageToken);
  }
  return set;
}

// APIの予定を、通知に使う形にそろえる（アプリの dates.js の normalizeEvent を簡単にしたもの）
function normalize(raw, cal) {
  const shared = raw.extendedProperties?.shared || {};
  const allDay = !!raw.start.date;
  let startKey, endKey, startTime = '', endTime = '';
  if (allDay) {
    startKey = raw.start.date;
    endKey = addDays(raw.end?.date || addDays(startKey, 1), -1);
    if (endKey < startKey) endKey = startKey;
  } else {
    const s = new Date(raw.start.dateTime);
    const e = new Date(raw.end?.dateTime || raw.start.dateTime);
    startKey = keyOf(s);
    endKey = e > s ? keyOf(new Date(e.getTime() - 1)) : startKey;
    startTime = Utilities.formatDate(s, TZ, 'HH:mm');
    endTime = Utilities.formatDate(e, TZ, 'HH:mm');
  }
  const tagged = (shared.ocPersons || '').split(',').filter((p) => PERSONS.includes(p));
  let timeMode = 'none';
  if (!allDay) {
    timeMode = ['start', 'end', 'both', 'due'].includes(shared.ocTime)
      ? shared.ocTime : (startTime === endTime && startKey === endKey ? 'start' : 'both');
  }
  return {
    id: raw.id,
    title: raw.summary || '（タイトルなし）',
    allDay, startKey, endKey, startTime, endTime, timeMode,
    startMs: allDay ? 0 : new Date(raw.start.dateTime).getTime(),
    kind: shared.ocKind === 'task' ? 'task' : 'event',
    done: shared.ocDone === '1',
    persons: tagged.length ? tagged : (cal.person ? [cal.person] : []),
    calendar: cal,
    shared,
  };
}

// アプリに表示しない予定か（変換済みの元の予定・非表示の印・書き換えた元の予定）
function isHidden(raw, cal, overridden) {
  const shared = raw.extendedProperties?.shared || {};
  return shared.ocConverted === '1' || shared.ocHidden === '1' || overridden.has(`${cal.id}|${raw.id}`);
}

/* ---------- 毎朝の通知 ---------- */

function maybeSendDaily() {
  const now = new Date();
  const hour = Number(Utilities.formatDate(now, TZ, 'H'));
  if (hour < DAILY_HOUR || hour >= DAILY_UNTIL_HOUR) return;
  const today = keyOf(now);
  const props = PropertiesService.getScriptProperties();
  if (props.getProperty('dailySent') === today) return;
  for (const p of PERSONS) send(p, ...dailyMessage(p, today));
  props.setProperty('dailySent', today);
}

// その人に送る [タイトル, 本文]。予定は全員分、タスクは対象の人の分だけ
function dailyMessage(person, today) {
  const calendars = loadCalendars();
  const overridden = loadOverridden(calendars);
  const last = TASK_REMIND_DAYS.reduce((a, b) => Math.max(a, b), 0);
  const events = [];
  for (const cal of calendars) {
    for (const raw of listEvents(cal.id, today, addDays(today, last + 1))) {
      if (!isHidden(raw, cal, overridden)) events.push(normalize(raw, cal));
    }
  }

  const todays = events
    .filter((ev) => ev.kind === 'event' && ev.startKey <= today && today <= ev.endKey)
    .sort((a, b) => Number(b.allDay) - Number(a.allDay) || a.startMs - b.startMs || a.title.localeCompare(b.title, 'ja'));
  const tasks = events
    .filter((ev) => ev.kind === 'task' && !ev.done && ev.persons.includes(person) &&
      TASK_REMIND_DAYS.includes(diffDays(today, ev.endKey)))
    .sort((a, b) => a.endKey.localeCompare(b.endKey) || a.startMs - b.startMs);

  const lines = todays.length ? todays.map(eventLine) : ['今日の予定はありません'];
  if (tasks.length) {
    lines.push('', '📝 タスク');
    for (const t of tasks) {
      const days = diffDays(today, t.endKey);
      const due = `${days === 0 ? '今日' : formatShort(t.endKey)}${t.allDay ? '' : ` ${t.startTime}`}まで`;
      lines.push(`・${t.title}（${days === 0 ? due : `あと${days}日・${due}`}）`);
    }
  }
  return [`${formatDay(today)}の予定`, lines.join('\n')];
}

function eventLine(ev) {
  const who = ev.persons.length
    ? ev.persons.map((p) => PEOPLE[p].icon).join('')
    : `［${ev.calendar.holiday ? '祝日' : ev.calendar.name}］`;
  return `${timeText(ev)} ${who} ${ev.title}`;
}

// 時刻の書き方はアプリの一覧と同じ
function timeText(ev) {
  const multi = ev.startKey !== ev.endKey;
  const sd = formatShort(ev.startKey);
  const ed = formatShort(ev.endKey);
  if (ev.allDay) return multi ? `終日〜${ed}` : '終日';
  switch (ev.timeMode) {
    case 'start': return multi ? `${sd} ${ev.startTime}〜${ed}` : `${ev.startTime}〜`;
    case 'end': return multi ? `${sd}〜${ed} ${ev.endTime}` : `〜${ev.endTime}`;
    default: return multi ? `${sd} ${ev.startTime}〜${ed} ${ev.endTime}` : `${ev.startTime}–${ev.endTime}`;
  }
}

/* ---------- 相手が予定を追加したときの通知 ---------- */

// 2人のカレンダーの変更を、前回からの差分（syncToken）で調べる
function checkNewEvents() {
  const props = PropertiesService.getScriptProperties();
  const notified = JSON.parse(props.getProperty('notified') || '{}');
  const now = Date.now();

  for (const cal of loadCalendars().filter((c) => c.person)) {
    const key = `sync:${sha256(cal.id).slice(0, 16)}`;
    const token = props.getProperty(key);
    if (!token) {
      // 初回（または同期をやり直すとき）は、今ある予定を覚えるだけで通知しない
      props.setProperty(key, fullSync(cal.id));
      continue;
    }
    let changed;
    try {
      changed = syncChanges(cal.id, token);
    } catch (err) {
      if (String(err).includes('410') || /sync token/i.test(String(err))) {
        props.deleteProperty(key); // 古くなった印。次の回で覚え直す
        continue;
      }
      throw err;
    }
    for (const raw of changed.items) {
      if (isDeletionLog(raw, notified, now)) {
        notified[raw.id] = now;
        notifyDeleted(raw, cal);
      } else if (isNewEvent(raw, notified, now)) {
        notified[raw.id] = now;
        notifyNewEvent(normalize(raw, cal));
      }
    }
    props.setProperty(key, changed.syncToken);
  }

  // 2日より前の記録は消す
  for (const [id, at] of Object.entries(notified)) if (now - at > 2 * 24 * 60 * 60 * 1000) delete notified[id];
  props.setProperty('notified', JSON.stringify(notified));
}

function fullSync(calendarId) {
  let pageToken, res;
  do {
    res = Calendar.Events.list(calendarId, { maxResults: 2500, pageToken, fields: 'nextPageToken,nextSyncToken' });
    pageToken = res.nextPageToken;
  } while (pageToken);
  return res.nextSyncToken;
}

function syncChanges(calendarId, syncToken) {
  const items = [];
  let pageToken, res;
  do {
    res = Calendar.Events.list(calendarId, { syncToken, pageToken, maxResults: 250 });
    items.push(...(res.items || []));
    pageToken = res.nextPageToken;
  } while (pageToken);
  return { items, syncToken: res.nextSyncToken };
}

// 新しく追加された予定か。アプリの「書き換え」で作られる予定（元の予定を指す印つき）、
// 非表示の印、変換済みの印、繰り返しの予定の1回分の変更は、追加として扱わない
function isNewEvent(raw, notified, now) {
  if (raw.status === 'cancelled' || !raw.start || !raw.created) return false;
  if (notified[raw.id] || raw.recurringEventId) return false;
  const shared = raw.extendedProperties?.shared || {};
  if (shared.ocSource || shared.ocHidden === '1' || shared.ocConverted === '1') return false;
  return now - new Date(raw.created).getTime() < NEW_EVENT_WINDOW_MS;
}

// 予定は「入れた人」（予定が入ったカレンダーの持ち主）でないほうへ、
// タスクは対象の人のうち、入れた人でない人へ知らせる
function notifyNewEvent(ev) {
  const by = ev.calendar.person;
  const to = PERSONS.filter((p) => p !== by && (ev.kind === 'event' || ev.persons.includes(p)));
  if (!to.length) return;
  const who = ev.persons.map((p) => PEOPLE[p].icon).join('');
  const when = ev.kind === 'task'
    ? `${formatDay(ev.endKey)}${ev.allDay ? '' : ` ${ev.startTime}`}まで`
    : `${formatDay(ev.startKey)} ${timeText(ev)}`;
  const title = `${PEOPLE[by].icon} ${PEOPLE[by].nickname}が${ev.kind === 'task' ? 'タスク' : '予定'}を追加しました`;
  for (const p of to) send(p, title, `${when}\n${who} ${ev.title}`);
}

/* ---------- 相手が予定を削除したときの通知 ---------- */

// 新しくできた「削除の記録」か（アプリの store.js の insertDeletionLog が作る）
function isDeletionLog(raw, notified, now) {
  const shared = raw.extendedProperties?.shared || {};
  if (raw.status === 'cancelled' || shared.ocDelLog !== '1' || !raw.created || notified[raw.id]) return false;
  return now - new Date(raw.created).getTime() < NEW_EVENT_WINDOW_MS;
}

// 削除した人でないほうへ知らせる（タスクは、対象の人のうち削除した人でない人へ）
function notifyDeleted(raw, cal) {
  const s = raw.extendedProperties.shared;
  const by = PERSONS.includes(s.ocDelBy) ? s.ocDelBy : cal.person;
  const ev = {
    title: s.ocDelTitle || '（タイトルなし）',
    kind: s.ocDelKind === 'task' ? 'task' : 'event',
    persons: (s.ocDelPersons || '').split(',').filter((p) => PERSONS.includes(p)),
    startKey: s.ocDelStart,
    endKey: s.ocDelEnd || s.ocDelStart,
    allDay: s.ocDelAllDay === '1',
    startTime: s.ocDelStartTime || '',
    endTime: s.ocDelEndTime || '',
    timeMode: s.ocDelTimeMode || 'none',
  };
  if (!by || !ev.startKey) return;
  const to = PERSONS.filter((p) => p !== by && (ev.kind === 'event' || ev.persons.includes(p)));
  if (!to.length) return;
  const who = ev.persons.map((p) => PEOPLE[p].icon).join('');
  const when = ev.kind === 'task'
    ? `${formatDay(ev.endKey)}${ev.allDay ? '' : ` ${ev.startTime}`}まで`
    : `${formatDay(ev.startKey)} ${timeText(ev)}`;
  const title = `${PEOPLE[by].icon} ${PEOPLE[by].nickname}が${ev.kind === 'task' ? 'タスク' : '予定'}を削除しました`;
  for (const p of to) send(p, title, `${when}\n${who} ${ev.title}`);
}

/* ---------- 送る ---------- */

// カレンダーのアプリへの通知（worker/push.js に頼む）。
// 一時的につながらなくても、ほかの人への通知や、ほかの処理は止めない
function send(person, title, body) {
  const props = PropertiesService.getScriptProperties();
  const url = props.getProperty('PUSH_URL');
  const secret = props.getProperty('PUSH_SECRET');
  if (!url || !secret) return;
  try {
    const res = UrlFetchApp.fetch(`${url.replace(/\/+$/, '')}/send`, {
      method: 'post',
      contentType: 'application/json',
      headers: { Authorization: `Bearer ${secret}` },
      payload: JSON.stringify({ person, title, body }),
      muteHttpExceptions: true,
    });
    const text = res.getContentText();
    if (res.getResponseCode() >= 300) console.warn(`${PEOPLE[person].icon} 通知を送れませんでした（${res.getResponseCode()}）`, text);
    else console.log(`${PEOPLE[person].icon} 通知`, text);
  } catch (err) {
    console.warn(`${PEOPLE[person].icon} 通知を送れませんでした`, err);
  }
}

/* ---------- 日付（日本時間。'YYYY-MM-DD'） ---------- */

function keyOf(date) {
  return Utilities.formatDate(date, TZ, 'yyyy-MM-dd');
}

function todayKey() {
  return keyOf(new Date());
}

function utcOf(key) {
  const [y, m, d] = key.split('-').map(Number);
  return Date.UTC(y, m - 1, d);
}

function addDays(key, n) {
  return new Date(utcOf(key) + n * 86400000).toISOString().slice(0, 10);
}

function diffDays(fromKey, toKey) {
  return Math.round((utcOf(toKey) - utcOf(fromKey)) / 86400000);
}

function formatShort(key) {
  const [, m, d] = key.split('-').map(Number);
  return `${m}/${d}`;
}

function formatDay(key) {
  const [, m, d] = key.split('-').map(Number);
  return `${m}月${d}日（${WEEKDAYS[new Date(utcOf(key)).getUTCDay()]}）`;
}
