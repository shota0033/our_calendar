// Googleカレンダーの予定を、アプリ形式の予定に変換する画面（一度だけ使う）。
// 変換：抽出した「タイトル・日付・時間・メモ」で新しいアプリ形式の予定（🐟）を作り、
// 元の予定には「変換済み」の印（ocConverted）だけを付けてアプリに表示しない。元の予定は削除しない。
import { CONFIG } from './config.js?v=14';
import * as store from './store.js?v=14';
import * as D from './dates.js?v=14';
import { fieldsFromEvent } from './form.js?v=14';
import { h, $ } from './dom.js?v=14';

const PERSON = 'fish'; // 10月以降のGoogleの予定は、すべて彼女のもの
const TO_KEY = '2028-01-01'; // 2027年12月末まで

let items = []; // { ev, fields, checked, status, error }
let running = false;
let converted = false;
let message = '';
let onDone = () => {};

export function initConvert(callbacks) {
  onDone = callbacks.onDone;
  $('#convert-run-btn').addEventListener('click', run);
  $('#convert-all-btn').addEventListener('click', () => setAll(true));
  $('#convert-none-btn').addEventListener('click', () => setAll(false));
  $('#convert-dialog').addEventListener('cancel', (e) => { if (running) e.preventDefault(); });
  $('#convert-dialog').addEventListener('close', () => {
    if (converted) onDone();
    converted = false;
  });
}

// 変換できない理由（できるなら空文字）
function blockedReason(ev) {
  if (ev.recurring) return '繰り返しの予定のため対象外';
  // 元の予定に「変換済み」の印を付けられないと、元の予定も表示されて二重になる
  if (!store.calendarById(ev.calendarId)?.writable) return '閲覧のみのカレンダーのため対象外';
  return '';
}

function fromKey() {
  return CONFIG.hideGoogleEventsBefore || D.todayKey();
}

export async function openConvert() {
  items = [];
  message = '読み込んでいます…';
  render();
  $('#convert-dialog').showModal();
  try {
    const events = await store.findConvertCandidates(fromKey(), TO_KEY);
    items = events.map((ev) => ({
      ev,
      fields: toFields(ev),
      checked: !blockedReason(ev),
      status: '',
      error: '',
    }));
    message = items.length ? '' : '変換する予定はありません。';
  } catch (err) {
    message = `読み込めませんでした：${err.message}`;
  }
  render();
}

// Googleの予定から「タイトル・日付・時間・メモ」を取り出し、🐟の予定にする
function toFields(ev) {
  return { ...fieldsFromEvent(ev), kind: 'event', persons: [PERSON], dueTime: '', done: false };
}

function whenText(f) {
  const days = f.multi
    ? `${D.formatDayLabel(f.startKey)} 〜 ${D.formatDayLabel(f.endKey)}`
    : D.formatDayLabel(f.startKey);
  let time = '終日';
  if (f.startTime && f.endTime) time = `${f.startTime}–${f.endTime}`;
  else if (f.startTime) time = `${f.startTime}〜`;
  else if (f.endTime) time = `〜${f.endTime}`;
  return `${days}　${time}`;
}

function setAll(on) {
  if (running) return;
  for (const it of items) if (!blockedReason(it.ev) && it.status !== 'done') it.checked = on;
  render();
}

function selected() {
  return items.filter((it) => it.checked && it.status !== 'done');
}

function render() {
  const { y: fy, m: fm, d: fd } = D.parts(fromKey());
  $('#convert-intro').textContent =
    `${fy}年${fm}月${fd}日〜2027年12月31日の、Googleカレンダーから入った予定です（祝日を除く）。`
    + `チェックした予定を${CONFIG.people[PERSON].icon}の予定として作り直します。`
    + '元のGoogleの予定は削除せず、アプリに表示しないようにするだけです。';
  $('#convert-message').textContent = message;
  $('#convert-message').hidden = !message;

  $('#convert-list').replaceChildren(...items.map((it, i) => {
    const { ev, fields } = it;
    const cal = store.calendarById(ev.calendarId);
    const blocked = blockedReason(ev);
    const meta = [cal?.name, blocked];
    let status = null;
    if (it.status === 'done') status = h('span', { class: 'ok' }, '✓ 変換済み');
    else if (it.status === 'running') status = h('span', {}, '変換中…');
    else if (it.status === 'error') status = h('span', { class: 'ng' }, `失敗：${it.error}`);
    const memo = fields.description.split('\n').slice(0, 3).join('\n');
    return h('label', { class: `convert-row${blocked ? ' disabled' : ''}` },
      h('input', {
        type: 'checkbox',
        checked: it.checked,
        disabled: !!blocked || running || it.status === 'done',
        onchange: (e) => { items[i].checked = e.target.checked; renderFooter(); },
      }),
      h('div', { class: 'info' },
        h('div', { class: 'when' }, whenText(fields)),
        h('div', { class: 'name' }, fields.title || '（タイトルなし）'),
        memo ? h('div', { class: 'memo' }, memo) : null,
        h('div', { class: 'meta' }, meta.filter(Boolean).join('・'), status ? ' ' : '', status)));
  }));
  renderFooter();
}

function renderFooter() {
  const n = selected().length;
  const btn = $('#convert-run-btn');
  btn.textContent = running ? '変換しています…' : `選んだ${n}件を変換する`;
  btn.disabled = running || n === 0;
  $('#convert-all-btn').disabled = running || !items.length;
  $('#convert-none-btn').disabled = running || !items.length;
  const blocked = items.filter((it) => blockedReason(it.ev)).length;
  $('#convert-count').textContent = items.length ? `全${items.length}件（対象外 ${blocked}件）` : '';
  $('#convert-dialog [data-close]').disabled = running;
}

async function run() {
  const targets = selected();
  if (!targets.length || running) return;
  if (!confirm(`${targets.length}件を${CONFIG.people[PERSON].icon}の予定として変換します。よろしいですか？\n（元のGoogleの予定は削除しません）`)) return;

  running = true;
  message = '';
  let ok = 0;
  let ng = 0;
  // 1件ずつ順番に行う（途中で失敗しても、元の予定は残る）
  for (const it of targets) {
    it.status = 'running';
    render();
    try {
      await store.convertOne(it.ev, it.fields);
      it.status = 'done';
      it.checked = false;
      converted = true;
      ok++;
    } catch (err) {
      it.status = 'error';
      it.error = err.message;
      ng++;
      if (err.auth || err.network) {
        message = err.auth
          ? 'ログインの有効期限が切れたため中断しました。画面を閉じて読み込み直してから、もう一度開いてください（変換済みの予定は一覧に出ません）。'
          : '通信できなかったため中断しました。電波の良いところで、もう一度「変換する」を押してください。';
        break;
      }
    }
  }
  running = false;
  if (!message) message = ng ? `${ok}件を変換しました。${ng}件は失敗しました。` : `${ok}件を変換しました。`;
  render();
}
