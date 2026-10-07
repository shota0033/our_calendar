// アプリの設定。クライアントIDは Google Cloud の「クライアント」で作成したものを入れる。
export const CONFIG = {
  clientId: '91511096162-7i0bj85899pdfil0sm3cm82bl6j29qkg.apps.googleusercontent.com',

  scopes: [
    'https://www.googleapis.com/auth/calendar.events',
    'https://www.googleapis.com/auth/calendar.calendarlist.readonly',
  ],

  timeZone: 'Asia/Tokyo',

  // 2人の設定。calendars には、その人のカレンダーID（メールアドレス）を小文字にして
  // SHA-256 で変換した値を書く（公開リポジトリにアドレスを載せないため）。
  // 先頭のカレンダーが、追加画面でその人を選んだときの保存先になる。
  // 2つ目以降は表示のときだけその人の予定として扱う（例: 彼女のアカウント2）。
  // 値の作り方（PowerShell / Git Bash）: printf '%s' 'address@gmail.com' | sha256sum
  people: {
    cat: {
      label: '僕',
      icon: '🐱',
      color: '#3f7ce0',
      calendars: ['a8e58c5914793c26c3a45e4b040749723482ed57030ab1fe7e668268fbf83ccd'],
    },
    fish: {
      label: '彼女',
      icon: '🐟',
      color: '#e0577a',
      calendars: ['1fd1ef0de0e58cf6a5b6f09dc1b3ef788ef8fb3a64c27de79981dcf966da5f0d'],
    },
  },
  // 2人の予定の色
  bothColor: '#8e63ce',

  // Googleカレンダーから反映された予定（アプリで作っていないもの）のうち、
  // この日より前に終わるものはアプリに表示しない。Googleカレンダー側の予定は消さない。
  // 祝日カレンダーの予定は対象外。
  hideGoogleEventsBefore: '2026-10-01',

  // 一覧表示で最初に読み込む日数（「さらに表示」で同じ日数ずつ延びる）
  listDays: 30,

  // カレンダーの色。2人とも同じ色で見えるよう、カレンダーIDで固定する。
  // ここに書いていないカレンダーは、IDから自動でパレットの色を割り当てる。
  // 例: 'someone@gmail.com': '#e67c73',
  calendarColors: {},

  // カレンダーの表示名。メインカレンダーはメールアドレスで表示されるので、ここで名前を付けられる。
  // 例: 'someone@gmail.com': '自分',
  calendarNames: {},

  palette: [
    '#3f7ce0', '#e0577a', '#33a875', '#f09a2a', '#8e63ce',
    '#1fa3b5', '#c9822b', '#d14fb4', '#5f8f2e', '#6b7a99',
  ],

  holidayColor: '#d9534f',
};
