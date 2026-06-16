# site-update-checker

サイトの更新（リニューアル・デプロイ・WordPress等のアップデート）の前後で、サイト全体を外部からチェックするツールです。  
外部から実行する方式なので対象サーバーへの追加インストール不要。

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
  // 共通設定
  concurrency: 2,   // 同時実行数（サーバー負荷を考えて1〜3推奨）
  diffThreshold: 0.01,
  // ...

  // チェック対象（複数定義可）
  targets: [
    { name: "siteA", baseUrl: "https://staging-a.example.com", basicAuth: null },
    { name: "siteB", baseUrl: "https://staging-b.example.com", basicAuth: { username: "u", password: "p" } },
  ],
};
```

各対象に `name` を付けて配列で複数定義できます。実行時に `-- <name>` で対象を切り替えます。
**対象が1つだけなら名前は省略可**、複数あって未指定の場合はエラーで一覧を表示します。

### 2. アップデート前にクロール

```bash
npm run before -- siteA
```

→ `reports/siteA/before/` にスクリーンショット＋結果JSONが保存される

### 3. サイトを更新

ステージング環境でサイトを更新（リニューアル反映・デプロイ・WordPress等のアップデートなど）

### 4. アップデート後にクロール＋レポート生成

```bash
npm run after -- siteA   # アップデート後のクロール
npm run diff  -- siteA   # レポート生成
```

または一括実行：

```bash
npm run check -- siteA   # after + diff を連続実行
```

> `npm run` に引数を渡すときは `--` が必要です（例: `npm run before -- siteA`）。

### 5. レポートを確認

```
reports/siteA/report.html
```

対象ごとに `reports/<name>/` 配下へ分かれて出力されます。ブラウザで開くと差分サムネイル付きの一覧が見られます。

---

## ディレクトリ構成

```
site-update-checker/
├── config.sample.js   # 設定テンプレート（これをコピーして config.js を作る）
├── config.js          # ← 実際の設定（.gitignore 済み・ここだけ編集すればOK）
├── package.json
├── src/
│   ├── crawl.js       # クロール・SS撮影・リンクチェック
│   ├── diff.js        # 差分比較・レポート生成
│   ├── check.js       # after + diff を対象名を引き継いで連続実行
│   └── target.js      # 実行時引数から対象を解決（共通設定とマージ）
└── reports/
    └── <対象名>/           # 対象（target.name）ごとに分離
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
