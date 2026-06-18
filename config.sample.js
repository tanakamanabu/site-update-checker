// =============================================
//  site-update-checker 設定ファイル（テンプレート）
//  このファイルを config.js にコピーして編集してください:
//    cp config.sample.js config.js
//  config.js は .gitignore 済みなので URL 等が GitHub に上がりません。
// =============================================

export const config = {
  // ---- 共通設定（全対象で共有） ----

  // クロールの同時実行数（サーバー負荷を考慮して 1〜3 推奨）
  concurrency: 2,

  // ページ読み込みタイムアウト（ミリ秒）
  timeout: 30000,

  // ビジュアル差分の「強調」閾値（0〜1）。
  // 1px でも違うページは必ず一覧に出る（取りこぼし防止）。この閾値は
  // 「出す/出さない」ではなく、これ以上の差分を「要確認」として強調表示
  // するためのもの。0.01 = ページの 1% 以上が変化したら強調。
  diffThreshold: 0.01,

  // スクリーンショットのビューポートサイズ
  viewport: { width: 1280, height: 900 },

  // スクショ前にCSSアニメーション/トランジションを無効化し最終状態へ飛ばす。
  // フェードイン等の途中フレームを撮って before/after が誤差分になるのを防ぐ。
  // 通常は true 推奨。アニメーション自体を差分として見たい場合のみ false。
  disableAnimations: true,

  // スクショ前の追加待機（ミリ秒）。CSS無効化では止まらない JS(rAF)駆動の
  // フェードインがある場合に効く。0 で無効。重いサイトでは 300〜1000 程度。
  screenshotDelay: 0,

  // 指定種別のリソースを読み込まずブロックして高速化する（Playwrightの
  // resourceType: "image" / "media" / "font" / "stylesheet" など）。
  // 画像が多くクロールが遅い対象で効果大。ただしブロックした分はスクショに
  // 写らないので差分検出もできなくなる（トレードオフ）。
  //   []                 … 既定。全部読み込む（画像差分も検出できる）
  //   ["image"]          … 画像も全スキップで最速。画像の差分は捨てる
  //   ["media", "font"]  … 動画/フォントだけ落とし画像は残す（そこそこ高速）
  // 対象ごとに上書き可（重いサイトだけ targets[] 側で指定するのが便利）。
  blockResources: [],

  // ページ内リンクのリンク切れチェックで外部ドメインも確認するか。
  //   true  … 既定。外部リンク（SNS・他サイト等）もHTTPステータスを確認する
  //   false … 同一ドメインのリンクのみ確認し、外部リンクはスキップする
  // 外部リンク（Facebook共有/はてブ/YouTube等）は応答が遅い・CORSで弾かれる
  // ことが多く、クロールが遅くなる主因になりやすい。リンク切れ検出を内部
  // リンクだけで十分とする対象では false にすると大幅に高速化できる。
  checkExternalLinks: true,

  // リンク切れチェック1本あたりのタイムアウト（ミリ秒）。
  // ブラウザの fetch 自体にはタイムアウトが無いため、応答しないリンクに
  // 当たると既定のネットワークタイムアウトまで固まる。これで上限を付ける。
  linkCheckTimeout: 8000,

  // クロール除外パターン（正規表現）
  excludePatterns: [
    // 拡張子の後ろにクエリ(?…)やフラグメント(#…)が付くURLも除外できるよう、
    // 末尾固定($)ではなく ?・# が続くケースも許容する。
    /\.(pdf|zip|jpg|jpeg|png|gif|svg|webp|mp4|mp3|woff|woff2|ttf|eot|ico)(\?|#|$)/i,
    /\/wp-admin\//,
    /\/wp-login\.php/,
    /\?replytocom=/,
    /\/feed\//,
    /\/xmlrpc\.php/,
  ],

  // クロールするドメインを baseUrl のみに限定する
  stayOnDomain: true,

  // クローラーのUser-Agent
  userAgent: "site-update-checker-bot/1.0 (regression testing)",

  // レポートの出力先（この下に対象名ごとのサブフォルダが作られる）
  reportDir: "./reports",

  // ---- チェック対象（複数定義可） ----
  // name で実行時に切り替える:  npm run before -- <name>
  // 対象が1つだけなら name 省略可。複数ある場合は名前指定が必須。
  // basicAuth / concurrency など共通設定は対象ごとに上書き可能。
  targets: [
    {
      name: "example",
      baseUrl: "https://your-staging-site.example.com",  // 末尾スラッシュなし
      basicAuth: null,  // Basic認証がある場合は { username: "user", password: "pass" }
    },
    // {
    //   name: "another",
    //   baseUrl: "https://another-staging.example.com",
    //   basicAuth: { username: "user", password: "pass" },
    //   // concurrency: 1,              // ← この対象だけ上書きしたい場合
    //   // blockResources: ["image"],   // ← 画像が多く遅い対象だけ画像スキップで高速化
    // },
  ],
};
