// =============================================
//  wp-checker 設定ファイル（テンプレート）
//  このファイルを config.js にコピーして編集してください:
//    cp config.sample.js config.js
//  config.js は .gitignore 済みなので URL 等が GitHub に上がりません。
// =============================================

export const config = {
  // チェック対象のサイトURL（末尾スラッシュなし）
  baseUrl: "https://your-staging-site.example.com",

  // Basic認証が必要な場合（不要なら null のまま）
  basicAuth: null,
  // basicAuth: { username: "user", password: "pass" },

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
  userAgent: "wp-checker-bot/1.0 (regression testing)",

  // レポートの出力先
  reportDir: "./reports",
};
