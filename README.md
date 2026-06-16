# wp-checker

WordPressアップデートの前後でサイト全体をチェックするツールです。  
外部から実行する方式なのでWPサーバーへの追加インストール不要。

## できること

- 🕷️ サイト全体を再帰的にクロール（数百ページ対応）
- 📸 全ページのスクリーンショットを撮影・比較（ビジュアルリグレッション）
- 🔗 リンク切れ検出（HTTPステータスで判定）
- 📊 差分サムネイル付きのHTMLレポートを生成

---

## セットアップ

```bash
# Node.js 18以上が必要
node -v

# 依存パッケージをインストール
npm install

# Playwrightのブラウザをインストール（初回のみ）
npx playwright install chromium
```

---

## 使い方

### 1. config.js を用意して編集

`config.sample.js` をコピーして `config.js` を作り、対象サイトに合わせて編集します。

```bash
cp config.sample.js config.js
```

> `config.js` は `.gitignore` 済みです。チェック対象の URL や Basic 認証情報はここに書くため、リポジトリには上がりません。設定項目を増やしたいときは `config.sample.js` 側を更新してコミットします。

```js
export const config = {
  baseUrl: "https://your-staging-site.example.com",  // ← チェック対象URL
  basicAuth: null,  // Basic認証がある場合は { username: "user", password: "pass" }
  concurrency: 2,   // 同時実行数（サーバー負荷を考えて1〜3推奨）
  ...
};
```

### 2. アップデート前にクロール

```bash
npm run before
```

→ `reports/before/` にスクリーンショット＋結果JSONが保存される

### 3. WordPressをアップデート

ステージング環境でWP本体・プラグインをアップデート

### 4. アップデート後にクロール＋レポート生成

```bash
npm run after   # アップデート後のクロール
npm run diff    # レポート生成
```

または一括実行：

```bash
npm run check   # after + diff を連続実行
```

### 5. レポートを確認

```
reports/report.html
```

ブラウザで開くと差分サムネイル付きの一覧が見られます。

---

## ディレクトリ構成

```
wp-checker/
├── config.sample.js   # 設定テンプレート（これをコピーして config.js を作る）
├── config.js          # ← 実際の設定（.gitignore 済み・ここだけ編集すればOK）
├── package.json
├── src/
│   ├── crawl.js       # クロール・SS撮影・リンクチェック
│   └── diff.js        # 差分比較・レポート生成
└── reports/
    ├── before/
    │   ├── screenshots/   # アプデ前のSS
    │   └── results.json   # クロール結果
    ├── after/
    │   ├── screenshots/   # アプデ後のSS
    │   └── results.json
    ├── diff/              # 差分ハイライト画像
    └── report.html        # ← 最終レポート
```

---

## ヒント

- **Basic認証つきステージング環境**でも動きます（config.jsで設定）
- `concurrency: 1` にするとサーバーへの負荷を最小限にできます
- `diffThreshold: 0.01` を上げると微細な差分を無視できます
- `reports/` ディレクトリは `.gitignore` に追加推奨（SSが大量に入るため）
