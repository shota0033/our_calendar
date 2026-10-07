#!/bin/sh
# ファイルの版番号を上げる。更新を公開するたびに実行する。
# 使い方: sh bump-version.sh 6
# import や index.html の読み込みURLに ?v=番号 を付け、古いファイルと新しいファイルが混ざるのを防ぐ。
set -e
v="$1"
[ -n "$v" ] || { echo "使い方: sh bump-version.sh <番号>"; exit 1; }
cd "$(dirname "$0")"
for f in *.js index.html; do
  sed -i -E "s#(\./[a-z]+\.js|\"(app\.js|styles\.css))(\?v=[0-9]+)?#\1?v=$v#g" "$f"
done
sed -i -E "s#const VERSION = 'v[0-9]+';#const VERSION = 'v$v';#" sw.js
echo "v$v にしました"
