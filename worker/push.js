// our_calendar の通知の中継（Cloudflare Workers）。
// カレンダーのアプリ（PWA）の通知の受け取り先を覚え、GAS から頼まれた通知を Web Push で届ける。
// 設定のしかたは worker/README.md を参照。
//
// 必要な設定（Cloudflare のダッシュボード）
//   KV の割り当て SUBS … 受け取り先と、通知の署名用の鍵（VAPID）を保存する
//   シークレット SEND_SECRET … GAS がこの Worker に通知を頼むときの合言葉
//
// 入口
//   GET  /vapid        … 通知の署名用の公開鍵（アプリが受け取り先を作るときに使う）
//   POST /subscribe    … { token, subscription } アプリから。Google のアクセストークンで誰のスマホかを確かめて覚える
//   POST /unsubscribe  … { token, endpoint } アプリから。受け取り先を消す
//   POST /send         … { person, title, body } GAS から（Authorization: Bearer SEND_SECRET）

const CLIENT_ID = '91511096162-7i0bj85899pdfil0sm3cm82bl6j29qkg.apps.googleusercontent.com';
const APP_URL = 'https://shota0033.github.io/our_calendar/';
const ALLOWED_ORIGINS = ['https://shota0033.github.io'];
// アプリの config.js と同じ（カレンダーIDの SHA-256）
const PEOPLE = {
  cat: ['a8e58c5914793c26c3a45e4b040749723482ed57030ab1fe7e668268fbf83ccd'],
  fish: [
    '1fd1ef0de0e58cf6a5b6f09dc1b3ef788ef8fb3a64c27de79981dcf966da5f0d',
    '436cf38ebc67fc09757130a27f4310cf5bde6dab5fdcb6c804908d5b648f771d',
  ],
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const cors = corsHeaders(request);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    try {
      let out;
      if (request.method === 'GET' && url.pathname === '/vapid') {
        out = { publicKey: (await vapidKeys(env)).publicKey };
      } else if (request.method === 'POST' && url.pathname === '/subscribe') {
        out = await subscribe(env, await request.json());
      } else if (request.method === 'POST' && url.pathname === '/unsubscribe') {
        out = await unsubscribe(env, await request.json());
      } else if (request.method === 'POST' && url.pathname === '/send') {
        if (!env.SEND_SECRET || request.headers.get('Authorization') !== `Bearer ${env.SEND_SECRET}`) {
          throw httpError(401, '合言葉が違います');
        }
        out = await sendTo(env, await request.json());
      } else {
        throw httpError(404, 'not found');
      }
      return json(out, 200, cors);
    } catch (err) {
      return json({ error: err.message }, err.status || 500, cors);
    }
  },
};

function corsHeaders(request) {
  const origin = request.headers.get('Origin');
  if (!origin || !ALLOWED_ORIGINS.includes(origin)) return {};
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}

function json(data, status, headers) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', ...headers } });
}

function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}

/* ---------- 受け取り先 ---------- */

// Google のアクセストークンから、誰のスマホかを決める（このアプリのトークンで、2人のどちらかのものだけ）
async function personOfToken(token) {
  if (!token) throw httpError(401, 'ログインしてください');
  const info = await fetch(`https://oauth2.googleapis.com/tokeninfo?access_token=${encodeURIComponent(token)}`);
  if (!info.ok || (await info.json()).aud !== CLIENT_ID) throw httpError(401, 'ログインし直してください');
  const res = await fetch('https://www.googleapis.com/calendar/v3/users/me/calendarList/primary', {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw httpError(401, 'ログインし直してください');
  const hash = await sha256Hex((await res.json()).id.toLowerCase());
  const person = Object.keys(PEOPLE).find((p) => PEOPLE[p].includes(hash));
  if (!person) throw httpError(403, 'このアカウントでは使えません');
  return person;
}

const subKey = async (person, endpoint) => `sub:${person}:${(await sha256Hex(endpoint)).slice(0, 32)}`;

async function subscribe(env, { token, subscription }) {
  const person = await personOfToken(token);
  const s = subscription || {};
  if (!/^https:\/\//.test(s.endpoint || '') || !s.keys?.p256dh || !s.keys?.auth) throw httpError(400, '受け取り先の形が正しくありません');
  // 同じ端末が別の人として登録されていたら消す（ログインし直した場合など）
  for (const p of Object.keys(PEOPLE)) await env.SUBS.delete(await subKey(p, s.endpoint));
  await env.SUBS.put(await subKey(person, s.endpoint), JSON.stringify({
    endpoint: s.endpoint, keys: { p256dh: s.keys.p256dh, auth: s.keys.auth }, savedAt: Date.now(),
  }));
  return { ok: true, person };
}

async function unsubscribe(env, { token, endpoint }) {
  await personOfToken(token);
  for (const p of Object.keys(PEOPLE)) await env.SUBS.delete(await subKey(p, endpoint || ''));
  return { ok: true };
}

async function sendTo(env, { person, title, body, url }) {
  if (!PEOPLE[person]) throw httpError(400, '人の指定が正しくありません');
  const payload = JSON.stringify({ title: String(title || ''), body: String(body || ''), url: url || APP_URL });
  const keys = await vapidKeys(env);
  const list = await env.SUBS.list({ prefix: `sub:${person}:` });
  let sent = 0;
  const errors = [];
  for (const { name } of list.keys) {
    const sub = JSON.parse(await env.SUBS.get(name) || 'null');
    if (!sub) continue;
    const res = await webPush(sub, payload, keys);
    if (res.status === 404 || res.status === 410) {
      await env.SUBS.delete(name); // 受け取りをやめた端末
    } else if (res.ok) {
      sent++;
    } else {
      errors.push(`${res.status} ${await res.text()}`.slice(0, 200));
    }
  }
  return { sent, errors };
}

/* ---------- Web Push（RFC 8291 の暗号化と RFC 8292 の VAPID） ---------- */

// 署名用の鍵は、最初に使うときに作って KV に保存する（作り直すと、今ある受け取り先が使えなくなる）
async function vapidKeys(env) {
  const saved = await env.SUBS.get('vapid');
  if (saved) return JSON.parse(saved);
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const keys = {
    publicKey: b64url(await crypto.subtle.exportKey('raw', pair.publicKey)),
    privateJwk: await crypto.subtle.exportKey('jwk', pair.privateKey),
  };
  await env.SUBS.put('vapid', JSON.stringify(keys));
  return keys;
}

async function vapidAuth(endpoint, keys) {
  const enc = (o) => b64url(new TextEncoder().encode(JSON.stringify(o)));
  const unsigned = `${enc({ typ: 'JWT', alg: 'ES256' })}.${enc({
    aud: new URL(endpoint).origin,
    exp: Math.floor(Date.now() / 1000) + 12 * 3600,
    sub: APP_URL,
  })}`;
  const key = await crypto.subtle.importKey('jwk', keys.privateJwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, new TextEncoder().encode(unsigned));
  return `vapid t=${unsigned}.${b64url(sig)}, k=${keys.publicKey}`;
}

async function encryptPayload(sub, payload) {
  const uaPublic = fromB64url(sub.keys.p256dh);
  const authSecret = fromB64url(sub.keys.auth);
  const local = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const asPublic = new Uint8Array(await crypto.subtle.exportKey('raw', local.publicKey));
  const uaKey = await crypto.subtle.importKey('raw', uaPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const ecdhSecret = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: uaKey }, local.privateKey, 256));

  const text = new TextEncoder();
  const ikm = await hkdf(authSecret, ecdhSecret, concat(text.encode('WebPush: info\0'), uaPublic, asPublic), 32);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, text.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, ikm, text.encode('Content-Encoding: nonce\0'), 12);

  const aes = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  const plain = concat(text.encode(payload), new Uint8Array([2])); // 2: 最後の（1つだけの）記録
  const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, aes, plain));

  const header = new Uint8Array(16 + 4 + 1 + asPublic.length);
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(16, 4096);
  header[20] = asPublic.length;
  header.set(asPublic, 21);
  return concat(header, cipher);
}

async function webPush(sub, payload, keys) {
  return fetch(sub.endpoint, {
    method: 'POST',
    headers: {
      Authorization: await vapidAuth(sub.endpoint, keys),
      'Content-Encoding': 'aes128gcm',
      'Content-Type': 'application/octet-stream',
      TTL: '86400',
      Urgency: 'high',
    },
    body: await encryptPayload(sub, payload),
  });
}

async function hkdf(salt, ikm, info, length) {
  const key = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, key, length * 8));
}

/* ---------- 小さな道具 ---------- */

function concat(...parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let i = 0;
  for (const p of parts) { out.set(p, i); i += p.length; }
  return out;
}

function b64url(buf) {
  let s = '';
  for (const b of new Uint8Array(buf)) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromB64url(s) {
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

async function sha256Hex(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
