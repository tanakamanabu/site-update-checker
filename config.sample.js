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

  // ビジュアル差分の閾値（0〜1、0.01 = 1%以上の差分を検出）
  diffThreshold: 0.01,

  // スクリーンショットのビューポートサイズ
  viewport: { width: 1280, height: 900 },

  // クロール除外パターン（正規表現）
  excludePatterns: [
    /\.(pdf|zip|jpg|jpeg|png|gif|svg|webp|mp4|mp3|woff|woff2|ttf|eot|ico)$/i,
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
    //   // concurrency: 1,  // ← この対象だけ上書きしたい場合
    // },
  ],
};
