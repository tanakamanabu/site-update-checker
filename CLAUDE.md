# site-update-checker

サイトの更新（リニューアル・デプロイ・WordPress等のアップデート）の前後で、サイト全体を外部からクロールし、ビジュアルリグレッション（スクリーンショット差分）とリンク切れを検出して HTML レポートを生成するツール。対象サーバーへの追加インストールは不要。特定のCMSに依存しない汎用クローラ。

## 現状

- Chat（生成AI）で作成された初期実装を持ち込み、実サイトで動作確認済み。
- `before` → `after` → `diff` の全パイプラインがエンドツーエンドで動作することを確認（28ページ規模のサイトでクロール・SS撮影・差分比較・HTMLレポート生成まで成功）。
- 設定は `config.sample.js`（テンプレート、コミット対象）をコピーして `config.js`（実設定、`.gitignore` 済み）を作る方式。URL や認証情報がリポジトリに上がらない。
- 自動テストや CI はまだない。エラーハンドリング強化も未着手。

## 技術スタック

- Node.js (ESM / `"type": "module"`、Node 18 以上、ローカルは v22)
- [Playwright](https://playwright.dev/) (chromium) — クロールとスクリーンショット
- [pixelmatch](https://github.com/mapbox/pixelmatch) + [pngjs](https://github.com/lukeapage/pngjs) — 画像差分

## 構成

```
site-update-checker/
├── config.sample.js   # 設定テンプレート（コミット対象）
├── config.js          # 実際の設定（.gitignore 済み）。config.sample.js をコピーして作る
├── package.json
├── src/
│   ├── crawl.js       # サイトを再帰クロールし、各ページのSS撮影＋リンク切れ記録
│   ├── diff.js        # before/after のSSを比較しHTMLレポート生成
│   ├── check.js       # after → diff を対象名を引き継いで連続実行
│   └── target.js      # 実行時引数から対象を解決し共通設定とマージ
└── reports/           # 実行時に生成（gitignore対象）
    └── <対象名>/        # config.targets[].name ごとに分離
        ├── before/{screenshots/, results.json}
        ├── after/{screenshots/, results.json}
        ├── diff/      # 差分ハイライト画像
        └── report.html  # 最終レポート
```

## 開発コマンド

```bash
npm install
npx playwright install chromium   # 初回のみ

# <name> は config.targets[].name。対象が1つなら省略可、複数なら必須。
npm run before -- <name>   # アップデート前にクロール → reports/<name>/before/
# （ここでサイトを更新: デプロイ / WordPress等のアップデート など）
npm run after  -- <name>   # アップデート後にクロール → reports/<name>/after/
npm run diff   -- <name>   # 差分比較＋レポート生成 → reports/<name>/report.html
npm run check  -- <name>   # after + diff を連続実行
```

## 設計メモ

- **複数対象**: `config.targets[]` に `{ name, baseUrl, basicAuth, ...上書き }` を並べる。`src/target.js` の `resolveTarget(name)` が実行時引数から対象を選び、共通設定（concurrency / timeout / diffThreshold / viewport / excludePatterns / stayOnDomain / userAgent）とマージして返す。`reportDir` は `reports/<name>` に解決され、対象ごとにレポートが分離される。対象が複数あるのに名前未指定だとエラーで一覧を出す。
- `crawl.js`: 引数 `[before|after] [対象名]`。解決済み `baseUrl` を起点に BFS でクロール、`concurrency` 件ずつ並列。`excludePatterns`（正規表現）と `stayOnDomain` で対象を絞る。リンク切れはページ内で `fetch(HEAD)` を実行しステータス判定。結果は各フェーズの `results.json` に保存。
- `diff.js`: 引数 `[対象名]`。before/after を URL でマッチング。SS はサイズが違う場合は大きい方に白埋めリサイズしてから pixelmatch で比較。`diffThreshold` を超えた差分のみ diff 画像を出力。`report.html` は `reportDir` 直下に置き、SS への相対パスは `./before|after|diff/`（report.html と同階層）。ビジュアル差分 / リンク切れ / ステータス変化 / 新規・削除ページを分類して単一 HTML に出力。
- `check.js`: `spawnSync` で after → diff を順に呼び、対象名引数をそのまま引き継ぐ（npm の `--` 経由だと両方に引数が渡らない問題を回避するため）。

## 注意点 / TODO

- 初回は `cp config.sample.js config.js` してから `baseUrl` を対象サイトへ書き換える。`config.js` は `.gitignore` 済みなので URL・認証情報は上がらない。設定項目を増やすときは `config.sample.js` も更新すること。
- `reports/` は大量のスクリーンショットが入るため `.gitignore` 済み。
- Basic 認証付きステージング環境にも対応（`config.basicAuth`）。
- CI・自動テストは未着手。

### エラーハンドリング強化 TODO（feature/error-handling で対応中）

優先度高（検出すべき異常の見逃し・成果消失を防ぐ）:

1. **スクショ欠損が diff で素通りする問題**: `crawl.js` で `page.goto` 失敗時は `screenshot: null` になるが、`diff.js` は before/after 両方に screenshot がある時しか比較せず、片方だけ撮影失敗だと差分0扱いで素通りする。片側だけ撮れたケースを「撮影失敗」として分類・表示する。
2. **`results.json` 破損で diff が即死**: `diff.js` の `JSON.parse` が裸。不完全な JSON で例外。try/catch して原因の分かるメッセージを出す。
3. **クロール途中クラッシュで成果全消失**: `results.json` の書き出しが全巡回後の1回だけ。途中で落ちると部分結果が残らない。途中保存 or `try/finally` で部分結果を書き出す。

優先度中（精度・堅牢性）:

4. **HEAD fetch のリンク切れ誤検出**: `HEAD` 固定で 405/501 を返すサーバーを誤爆。HEAD が 405/501 のとき GET でフォールバック。
5. **ディスク書き込みエラーが無防備**: スクショ保存・`writeFileSync` が容量/権限エラーで全体停止。個別 try/catch でそのページだけ失敗に留める。
6. **`loadPNG` の名ばかり Promise**: `PNG.sync.read` の同期例外が reject されず比較ループ全体が落ちる。`compareScreenshots` を try/catch で囲み、壊れた画像は「比較不能」として記録。

優先度低:

- `config.js` 不在時に「`cp config.sample.js config.js` してね」と案内する。
- ネットワーク不通・DNS 失敗を個別ページエラーと区別して冒頭で気づけるようにする。
