# wp-checker

WordPress のアップデート前後でサイト全体を外部からクロールし、ビジュアルリグレッション（スクリーンショット差分）とリンク切れを検出して HTML レポートを生成するツール。WP サーバーへの追加インストールは不要。

## 現状

- Chat（生成AI）で作成された初期実装を持ち込んだ段階。動作確認はこれから。
- コア機能（クロール / 差分 / レポート生成）は実装済み。テストや CI はまだない。

## 技術スタック

- Node.js (ESM / `"type": "module"`、Node 18 以上、ローカルは v22)
- [Playwright](https://playwright.dev/) (chromium) — クロールとスクリーンショット
- [pixelmatch](https://github.com/mapbox/pixelmatch) + [pngjs](https://github.com/lukeapage/pngjs) — 画像差分

## 構成

```
wp-checker/
├── config.js          # 設定（チェック対象URL・Basic認証・並列数など）。ここだけ編集すれば動く
├── package.json
├── src/
│   ├── crawl.js       # サイトを再帰クロールし、各ページのSS撮影＋リンク切れ記録
│   └── diff.js        # before/after のSSを比較しHTMLレポート生成
└── reports/           # 実行時に生成（gitignore対象）
    ├── before/{screenshots/, results.json}
    ├── after/{screenshots/, results.json}
    ├── diff/          # 差分ハイライト画像
    └── report.html    # 最終レポート
```

## 開発コマンド

```bash
npm install
npx playwright install chromium   # 初回のみ

npm run before   # アップデート前にクロール → reports/before/
# （ここで WordPress をアップデート）
npm run after    # アップデート後にクロール → reports/after/
npm run diff     # 差分比較＋レポート生成 → reports/report.html
npm run check    # after + diff を連続実行
```

## 設計メモ

- `crawl.js`: `config.baseUrl` を起点に BFS でクロール。`config.concurrency` 件ずつ並列処理。`excludePatterns`（正規表現）と `stayOnDomain` で対象を絞る。リンク切れはページ内で `fetch(HEAD)` を実行しステータス判定。結果は各フェーズの `results.json` に保存。
- `diff.js`: before/after を URL でマッチング。SS はサイズが違う場合は大きい方に白埋めリサイズしてから pixelmatch で比較。`config.diffThreshold` を超えた差分のみ diff 画像を出力。ビジュアル差分 / リンク切れ / ステータス変化 / 新規・削除ページを分類して単一 HTML に出力。

## 注意点 / TODO

- `config.js` の `baseUrl` はプレースホルダ（`your-staging-site.example.com`）。実行前に対象サイトへ書き換える必要がある。
- `reports/` は大量のスクリーンショットが入るため `.gitignore` 済み。
- Basic 認証付きステージング環境にも対応（`config.basicAuth`）。
- 動作確認・CI・エラーハンドリングの強化は未着手。
