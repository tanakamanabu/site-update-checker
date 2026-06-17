# site-update-checker

サイトの更新（リニューアル・デプロイ・WordPress等のアップデート）の前後で、サイト全体を外部からクロールし、ビジュアルリグレッション（スクリーンショット差分）とリンク切れを検出して HTML レポートを生成するツール。対象サーバーへの追加インストールは不要。特定のCMSに依存しない汎用クローラ。

## 現状

- Chat（生成AI）で作成された初期実装を持ち込み、実サイトで動作確認済み。
- `before` → `after` → `diff` の全パイプラインがエンドツーエンドで動作することを確認（28ページ規模のサイトでクロール・SS撮影・差分比較・HTMLレポート生成まで成功）。
- 設定は `config.sample.js`（テンプレート、コミット対象）をコピーして `config.js`（実設定、`.gitignore` 済み）を作る方式。URL や認証情報がリポジトリに上がらない。
- ユニットテスト（node:test）と CI（GitHub Actions）、エラーハンドリング強化は対応済み。
- 大規模サイト（1000ページ規模）で運用中。フェードイン演出による誤検出はスクショ安定化で対策、画像が重く遅い対象は `blockResources` で高速化できる。

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
│   ├── target.js      # 実行時引数から対象を解決し共通設定とマージ
│   └── util.js        # 副作用のない純粋関数群（crawl/diff から共有・テスト対象）
├── test/              # node:test によるユニットテスト（*.test.js）
├── .github/workflows/ci.yml  # GitHub Actions（Node 18/20/22 で npm test）
└── reports/           # 実行時に生成（gitignore対象）
    └── <対象名>/        # config.targets[].name ごとに分離
        ├── before/{screenshots/, results.json}
        ├── after/{screenshots/, results.json}
        ├── diff/      # 差分ハイライト画像（作業用）
        └── report/    # ★納品用 self-contained フォルダ（これごとクライアントに渡せる）
            ├── report.html  # 最終レポート
            └── assets/      # レポートで使う画像だけを集約（before_/after_/diff_）
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

npm test                   # ユニットテスト（node:test、ブラウザ不要）
```

## 設計メモ

- **複数対象**: `config.targets[]` に `{ name, baseUrl, basicAuth, ...上書き }` を並べる。`src/target.js` の `resolveTarget(name)` が実行時引数から対象を選び、共通設定（concurrency / timeout / diffThreshold / viewport / excludePatterns / stayOnDomain / userAgent / disableAnimations / screenshotDelay / blockResources）とマージして返す。`reportDir` は `reports/<name>` に解決され、対象ごとにレポートが分離される。対象が複数あるのに名前未指定だとエラーで一覧を出す。
- `crawl.js`: 引数 `[before|after] [対象名]`。解決済み `baseUrl` を起点に BFS でクロール、`concurrency` 件ずつ並列。`excludePatterns`（正規表現）と `stayOnDomain` で対象を絞る。リンク切れはページ内で `fetch(HEAD)` を実行しステータス判定。結果は各フェーズの `results.json` に保存。
- **スクショ安定化（`crawl.js` の `stabilizePage`）**: `goto` は `waitUntil:"networkidle"` だが、フェードイン演出は networkidle 後に再生されるため、そのまま撮ると before/after で別々の中間フレームを撮って誤検出になる。撮影直前に (1) CSS アニメーション/トランジションを `0s !important` で無効化して最終状態へ飛ばす、(2) ページ全体を段階スクロールして IntersectionObserver 系の遅延表示を発火させ先頭へ戻す、(3) `screenshotDelay`(ms) だけ待つ（JS/rAF 駆動のフェードイン対策）。`disableAnimations`（既定 true）/ `screenshotDelay`（既定 0）で制御。演出自体の変化を見たい対象だけ `disableAnimations:false`。
- **リソースブロック（`crawl.js` の `blockResources`）**: 画像が多いサイトは networkidle 待ちがボトルネックで遅い。`blockResources`（Playwright の resourceType 配列、例 `["image"]` / `["media","font"]`）を指定するとそのリソースを `context.route` で abort して高速化する。**既定は `[]`（全部読み込む）**。ブロックした分はスクショに写らず差分検出もできなくなるトレードオフなので、画像差分が不要な対象だけ targets[] 側で指定する。変更したら撮り条件が変わるので before/after を両方撮り直すこと。
- `diff.js`: 引数 `[対象名]`。before/after を URL でマッチング。SS はサイズが違う場合は大きい方に白埋めリサイズしてから pixelmatch で比較。**本番チェックの自動化向けにヒットミスを避ける方針**: 1px でも差分があれば一覧に出し（diff 画像も出力）、`diffThreshold`（比率）を超えたものだけ「要確認」として強調表示する（`util.js` の `classifyVisualChange` が `none/minor/significant` を判定）。差分率は 0.00% に丸まる微小変更でも分かるよう実 px 数も併記。`diffThreshold` は「出す/出さない」ではなく「強調する/しない」の閾値。**納品用に self-contained 化**: `report.html` は `reportDir/report/` に出力し、レポートで実際に使う画像だけを `report/assets/` に集約コピーする（before/after は同名衝突を避け `before_`/`after_` を前置、diff は `diff_` のまま）。相対パスは `./assets/...`。`report/` フォルダごと渡せば before/after/diff の作業データ（全ページの生スクショ）を含めず分離できる。`assets/` は毎回作り直す。ビジュアル差分 / リンク切れ / ステータス変化 / 新規・削除ページを分類して単一 HTML に出力。
- `check.js`: `spawnSync` で after → diff を順に呼び、対象名引数をそのまま引き継ぐ（npm の `--` 経由だと両方に引数が渡らない問題を回避するため）。
- `util.js`: I/O・`process.exit`・グローバル設定参照を持たない純粋関数だけを置く（`urlToFilename` / `isNetworkUnreachable` / `isSameDomain` / `isExcluded` / `escapeHtml` / `toPercent` / `detectMissingScreenshot` / `classifyVisualChange`）。crawl.js / diff.js は import 時にトップレベル await で処理を開始するためそのままではテストできないので、テストしたいロジックはここへ切り出す方針。
- `target.js`: 純粋関数 `resolveTargetConfig(config, name)`（エラーは throw）と、config.js を動的 import して失敗時に案内＋exit する CLI ラッパー `resolveTarget(name)` に分離。前者は config.js 不要でテストできる。
- **テスト / CI**: `npm test` = `node --test`（標準ランナー、依存追加なし）。`test/*.test.js` が `util.js` と `target.js` の純粋ロジックを検証。GitHub Actions（`.github/workflows/ci.yml`）が push(master) / 全 PR で Node 18/20/22 のマトリクス実行。ユニットテストはブラウザ不要なので CI は `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1` でブラウザDLを省略。

## 注意点 / TODO

- 初回は `cp config.sample.js config.js` してから `baseUrl` を対象サイトへ書き換える。`config.js` は `.gitignore` 済みなので URL・認証情報は上がらない。設定項目を増やすときは `config.sample.js` も更新すること。
- `reports/` は大量のスクリーンショットが入るため `.gitignore` 済み。
- Basic 認証付きステージング環境にも対応（`config.basicAuth`）。
- フェードイン等の演出で誤検出が出る場合は `screenshotDelay` を足す（CSS無効化で止まらない JS 駆動アニメ向け）。クロールが遅い大規模・画像過多サイトは `blockResources:["image"]` で大幅短縮できる（画像差分は捨てる前提）。

### エラーハンドリング強化（feature/error-handling で対応済み）

1. **スクショ欠損が diff で素通りしない**: 両フェーズにページが存在するのに片方（または両方）のスクショが無い／PNG が壊れて比較できないケースを `diff.js` が「撮影失敗・比較不能」として分類し、サマリーカード・専用セクションに表示する。差分0で素通りしなくなった。
2. **`results.json` 破損で即死しない**: `diff.js` の読み込みを `loadResults()` に集約。ファイル・フェーズ・パースエラーを明示し、crawl の再実行を促す。`pages[]` の存在も検証。
3. **クロール途中クラッシュで成果が残る**: `crawl.js` は `writeResults()` をバッチごと＋`finally` で呼び、途中で落ちても部分結果の `results.json` が残る。書き込みエラーは警告のみで続行。
4. **HEAD fetch の誤検出を抑制**: リンク切れ判定で HEAD が 405/501 のとき GET でフォールバックしてから判定。
5. **スクショ書き込み失敗を局所化**: `page.screenshot()` を専用 try/catch で囲み、撮影失敗を「読み込みエラー」と混同しない（screenshot は null のまま → diff 側が「撮影失敗」で拾う）。`page.close()` も保護。
6. **壊れた PNG で比較ループが止まらない**: `compareScreenshots()` を try/catch 化（`loadPNG` は同期関数に戻した）。壊れた画像は `{ error }` を返し「比較不能」として記録。
- **config.js 不在時の案内**: `target.js` は config.js を動的 import し、不在なら `cp config.sample.js config.js` を案内。`resolveTarget` は async になり、呼び出し側はトップレベル await（ESM）。
- **ネットワーク到達不可の区別**: DNS 失敗・接続拒否（`ERR_NAME_NOT_RESOLVED`/`ECONNREFUSED` 等）を検出。起点 URL が到達不可なら冒頭で目立つ警告を出し、サマリーに到達不可件数を計上。

### テスト・CI（対応済み）

- `node:test` による純粋関数のユニットテストを `test/` に追加（`npm test`）。テスト容易化のため純粋ロジックを `util.js` / `target.js` の `resolveTargetConfig` に切り出した。
- GitHub Actions で push(master) / 全 PR 時に Node 18/20/22 で `npm test` を実行。