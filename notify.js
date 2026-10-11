// 通知の受け取り（Web Push）。設定画面の「このデバイスで通知を受け取る」から使う。
// 受け取り先は通知の中継（worker/push.js、Cloudflare Workers）に登録し、GAS（gas/notify.gs）が送る。
// iPhone では、ホーム画面に追加したアプリからだけ使える（iOS 16.4 以降）。
import { CONFIG } from './config.js?v=32';
import * as auth from './auth.js?v=32';

const KEY_RESENT = 'oc.pushResent';
const RESEND_MS = 24 * 60 * 60 * 1000;

export function isConfigured() {
  return !!CONFIG.pushUrl;
}

export function isSupported() {
  return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
}

async function currentSubscription() {
  const reg = await navigator.serviceWorker.ready;
  return reg.pushManager.getSubscription();
}

// 設定画面に出す状態：'unsupported' | 'denied' | 'on' | 'off'
export async function status() {
  if (!isSupported()) return 'unsupported';
  if (Notification.permission === 'denied') return 'denied';
  if (Notification.permission === 'granted' && await currentSubscription()) return 'on';
  return 'off';
}

async function post(path, body) {
  const res = await fetch(`${CONFIG.pushUrl}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `通知の登録に失敗しました（${res.status}）`);
  return data;
}

function keyFromB64url(s) {
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

// 受け取りを始める。ボタンを押したときに呼ぶ（iPhone では、許可の確認はタップの直後でないと出ない）
export async function enable() {
  const token = auth.getToken();
  if (!token) throw new Error('ログインの有効期限が切れています。アプリを開き直してから、もう一度押してください。');
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') throw new Error('通知が許可されませんでした。');
  const reg = await navigator.serviceWorker.ready;
  const res = await fetch(`${CONFIG.pushUrl}/vapid`);
  if (!res.ok) throw new Error(`通知の中継につながりません（${res.status}）`);
  const { publicKey } = await res.json();
  let sub = await reg.pushManager.getSubscription();
  // 前の鍵で作った受け取り先なら作り直す
  const key = sub?.options?.applicationServerKey;
  if (sub && key && btoa(String.fromCharCode(...new Uint8Array(key))) !== btoa(String.fromCharCode(...keyFromB64url(publicKey)))) {
    await sub.unsubscribe();
    sub = null;
  }
  if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyFromB64url(publicKey) });
  const out = await post('/subscribe', { token, subscription: sub.toJSON() });
  saveResent();
  return out.person;
}

export async function disable() {
  const sub = await currentSubscription();
  if (!sub) return;
  const token = auth.getToken();
  if (token) await post('/unsubscribe', { token, endpoint: sub.endpoint }).catch((err) => console.warn(err));
  await sub.unsubscribe();
}

function saveResent() {
  try { localStorage.setItem(KEY_RESENT, String(Date.now())); } catch { /* 無視 */ }
}

// 受け取り中なら、1日に1回、受け取り先を登録し直す（iPhone 側で受け取り先が変わった場合や、中継が忘れた場合に備える）
export async function resendIfNeeded() {
  if (!isConfigured() || !isSupported() || Notification.permission !== 'granted') return;
  let last = 0;
  try { last = Number(localStorage.getItem(KEY_RESENT)) || 0; } catch { /* 無視 */ }
  if (Date.now() - last < RESEND_MS) return;
  const token = auth.getToken();
  const sub = await currentSubscription();
  if (!token || !sub) return;
  await post('/subscribe', { token, subscription: sub.toJSON() });
  saveResent();
}
