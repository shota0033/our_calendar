// アプリの設定。クライアントIDは Google Cloud の「クライアント」で作成したものを入れる。
export const CONFIG = {
  clientId: '91511096162-7i0bj85899pdfil0sm3cm82bl6j29qkg.apps.googleusercontent.com',

  scopes: [
    'https://www.googleapis.com/auth/calendar.events',
    'https://www.googleapis.com/auth/calendar.calendarlist.readonly',
  ],

  timeZone: 'Asia/Tokyo',

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
