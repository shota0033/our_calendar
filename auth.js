// Googleログイン（アクセストークンの取得と更新）。
//
// サーバーなしで画面を出さずにトークンを取り直すため、OAuth 2.0 の
// 画面遷移型フロー（response_type=token）に prompt=none を付けて使う。
// Googleにログイン中かつ同意済みなら、Googleへ一瞬移動してすぐ戻ってくる。
// 将来この方式が使えなくなったら、このファイルだけ差し替える。
import { CONFIG } from './config.js?v=25';

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const KEY_TOKEN = 'oc.token';
const KEY_EMAIL = 'oc.email';
const KEY_PENDING = 'oc.oauthPending';
const KEY_SILENT_FAILED = 'oc.silentFailedAt';

// 自動更新に失敗した直後は、何度もGoogleへ飛ばないよう一定時間待つ
const SILENT_RETRY_MS = 10 * 60 * 1000;

function load(key) {
  try { return JSON.parse(localStorage.getItem(key)); } catch { return null; }
}
function save(key, value) {
  try {
    if (value == null) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(value));
  } catch { /* 保存できない環境では毎回ログインになる */ }
}

function redirectUri() {
  return location.origin + location.pathname.replace(/index\.html$/, '');
}

function randomState() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

function goToGoogle(silent) {
  const state = randomState();
  save(KEY_PENDING, { state, silent });
  const params = new URLSearchParams({
    client_id: CONFIG.clientId,
    redirect_uri: redirectUri(),
    response_type: 'token',
    scope: CONFIG.scopes.join(' '),
    include_granted_scopes: 'true',
    state,
  });
  const email = getEmail();
  if (email) params.set('login_hint', email);
  if (silent) params.set('prompt', 'none');
  else if (!email) params.set('prompt', 'select_account');
  location.assign(`${AUTH_URL}?${params}`);
}

// Googleから戻ってきたときのURL（#access_token=...）を処理する。
// 戻り値: { status: 'none' | 'ok' | 'error', error?, silent? }
export function handleRedirect() {
  const hash = location.hash.startsWith('#') ? location.hash.slice(1) : '';
  const params = new URLSearchParams(hash);
  if (!params.has('access_token') && !params.has('error')) return { status: 'none' };

  history.replaceState(null, '', location.pathname + location.search);
  const pending = load(KEY_PENDING);
  save(KEY_PENDING, null);
  if (!pending || pending.state !== params.get('state')) {
    return { status: 'error', error: 'state_mismatch' };
  }

  if (params.has('error')) {
    if (pending.silent) save(KEY_SILENT_FAILED, Date.now());
    return { status: 'error', error: params.get('error'), silent: pending.silent };
  }

  const expiresIn = Number(params.get('expires_in')) || 3600;
  save(KEY_TOKEN, {
    accessToken: params.get('access_token'),
    expiresAt: Date.now() + expiresIn * 1000,
  });
  save(KEY_SILENT_FAILED, null);
  return { status: 'ok' };
}

export function getToken() {
  const token = load(KEY_TOKEN);
  if (!token || token.expiresAt - Date.now() < 30 * 1000) return null;
  return token.accessToken;
}

// トークンの残り時間（ミリ秒）。トークンがなければ 0。
export function remainingMs() {
  const token = load(KEY_TOKEN);
  return token ? Math.max(0, token.expiresAt - Date.now()) : 0;
}

export function invalidateToken() {
  save(KEY_TOKEN, null);
}

export function getEmail() {
  return load(KEY_EMAIL);
}

export function setEmail(email) {
  save(KEY_EMAIL, email);
}

export function hasLoggedInBefore() {
  return !!getEmail();
}

// 画面を出さずにトークンを取り直す（Googleへ移動する）。
// 移動できない状況なら false を返すので、呼び出し側で「再ログイン」ボタンを出す。
export function refreshSilently() {
  if (!getEmail() || !navigator.onLine) return false;
  const failedAt = load(KEY_SILENT_FAILED);
  if (failedAt && Date.now() - failedAt < SILENT_RETRY_MS) return false;
  goToGoogle(true);
  return true;
}

// 「ログイン」「再ログイン」ボタンから呼ぶ
export function login() {
  goToGoogle(false);
}

export function logout() {
  [KEY_TOKEN, KEY_EMAIL, KEY_PENDING, KEY_SILENT_FAILED].forEach((k) => save(k, null));
}
