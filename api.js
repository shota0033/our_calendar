// Google Calendar API の呼び出し
import { getToken, invalidateToken } from './auth.js?v=13';

const BASE = 'https://www.googleapis.com/calendar/v3';

export class ApiError extends Error {
  constructor(message, { status = 0, auth = false, network = false } = {}) {
    super(message);
    this.status = status;
    this.auth = auth;       // トークン切れなど、ログインし直せば直るもの
    this.network = network; // 通信できなかったもの
  }
}

async function request(method, path, { query, body } = {}) {
  const token = getToken();
  if (!token) throw new ApiError('ログインが必要です', { auth: true });

  const url = new URL(BASE + path);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== null) url.searchParams.set(k, v);
    }
  }

  let res;
  try {
    res = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new ApiError('通信できませんでした', { network: true });
  }

  if (res.status === 401) {
    invalidateToken();
    throw new ApiError('ログインの有効期限が切れました', { status: 401, auth: true });
  }
  if (res.status === 204) return null;

  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const message = data?.error?.message || `エラーが発生しました（${res.status}）`;
    throw new ApiError(message, { status: res.status });
  }
  return data;
}

async function listAll(path, query) {
  const items = [];
  let pageToken;
  do {
    const data = await request('GET', path, { query: { ...query, pageToken } });
    items.push(...(data.items || []));
    pageToken = data.nextPageToken;
  } while (pageToken);
  return items;
}

export function listCalendars() {
  return listAll('/users/me/calendarList', { maxResults: 250 });
}

// 繰り返し予定は1回ずつに展開して取得する（singleEvents）。
// 展開された1回分のIDで更新・削除すると、その回だけが変わる。
export function listEvents(calendarId, timeMin, timeMax, timeZone) {
  return listAll(`/calendars/${encodeURIComponent(calendarId)}/events`, {
    timeMin, timeMax, timeZone,
    singleEvents: 'true',
    orderBy: 'startTime',
    maxResults: 2500,
  });
}

// アプリで書き換え・非表示にした印（ocOverride=1）の付いた予定を、日付に関係なくすべて取得する
export function listOverrides(calendarId) {
  return listAll(`/calendars/${encodeURIComponent(calendarId)}/events`, {
    sharedExtendedProperty: 'ocOverride=1',
    maxResults: 2500,
  });
}

export function insertEvent(calendarId, event) {
  return request('POST', `/calendars/${encodeURIComponent(calendarId)}/events`, { body: event });
}

export function patchEvent(calendarId, eventId, changes) {
  return request(
    'PATCH',
    `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`,
    { body: changes },
  );
}

export function deleteEvent(calendarId, eventId) {
  return request(
    'DELETE',
    `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`,
  );
}
