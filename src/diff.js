/**
 * diff.js
 * before/after のスクリーンショットを比較し、
 * HTMLレポートを生成する。
 *
 * 使い方:
 *   node src/diff.js [対象名]
 */

import fs from "fs";
import path from "path";
import { PNG } from "pngjs";
import pixelmatch from "pixelmatch";
import { resolveTarget } from "./target.js";

const config = resolveTarget(process.argv[2]);

const beforeDir = path.join(config.reportDir, "before", "screenshots");
const afterDir = path.join(config.reportDir, "after", "screenshots");
const diffDir = path.join(config.reportDir, "diff");
const beforeData = path.join(config.reportDir, "before", "results.json");
const afterData = path.join(config.reportDir, "after", "results.json");

fs.mkdirSync(diffDir, { recursive: true });

function loadPNG(filepath) {
  return new Promise((resolve, reject) => {
    const data = fs.readFileSync(filepath);
    const png = PNG.sync.read(data);
    resolve(png);
  });
}

function resizePNG(png, width, height) {
  // 大きい方のサイズに合わせて余白を白で埋める
  const out = new PNG({ width, height, fill: true });
  // 白で初期化
  out.data.fill(255);
  // 元のデータをコピー
  const copyW = Math.min(png.width, width);
  const copyH = Math.min(png.height, height);
  for (let y = 0; y < copyH; y++) {
    for (let x = 0; x < copyW; x++) {
      const srcIdx = (y * png.width + x) * 4;
      const dstIdx = (y * width + x) * 4;
      out.data[dstIdx] = png.data[srcIdx];
      out.data[dstIdx + 1] = png.data[srcIdx + 1];
      out.data[dstIdx + 2] = png.data[srcIdx + 2];
      out.data[dstIdx + 3] = png.data[srcIdx + 3];
    }
  }
  return out;
}

async function compareScreenshots(filename) {
  const beforePath = path.join(beforeDir, filename);
  const afterPath = path.join(afterDir, filename);

  if (!fs.existsSync(beforePath) || !fs.existsSync(afterPath)) {
    return null;
  }

  let imgBefore = await loadPNG(beforePath);
  let imgAfter = await loadPNG(afterPath);

  // サイズが異なる場合は大きい方に合わせる
  const width = Math.max(imgBefore.width, imgAfter.width);
  const height = Math.max(imgBefore.height, imgAfter.height);

  if (imgBefore.width !== width || imgBefore.height !== height) {
    imgBefore = resizePNG(imgBefore, width, height);
  }
  if (imgAfter.width !== width || imgAfter.height !== height) {
    imgAfter = resizePNG(imgAfter, width, height);
  }

  const diffImg = new PNG({ width, height });
  const numDiff = pixelmatch(
    imgBefore.data,
    imgAfter.data,
    diffImg.data,
    width,
    height,
    { threshold: 0.1, includeAA: false }
  );

  const totalPixels = width * height;
  const diffRatio = numDiff / totalPixels;

  if (diffRatio > config.diffThreshold) {
    const diffFilename = "diff_" + filename;
    fs.writeFileSync(
      path.join(diffDir, diffFilename),
      PNG.sync.write(diffImg)
    );
    return { diffRatio, diffFilename, numDiff, totalPixels };
  }

  return { diffRatio, diffFilename: null, numDiff, totalPixels };
}

function toPercent(ratio) {
  return (ratio * 100).toFixed(2) + "%";
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

async function generateReport() {
  console.log("\n🔍 差分レポート生成中...\n");

  if (!fs.existsSync(beforeData) || !fs.existsSync(afterData)) {
    console.error("❌ before/after の results.json が見つかりません。先に crawl を実行してください。");
    process.exit(1);
  }

  const before = JSON.parse(fs.readFileSync(beforeData));
  const after = JSON.parse(fs.readFileSync(afterData));

  // ページをURLでマップ化
  const beforeMap = Object.fromEntries(before.pages.map((p) => [p.url, p]));
  const afterMap = Object.fromEntries(after.pages.map((p) => [p.url, p]));

  const allUrls = [...new Set([...Object.keys(beforeMap), ...Object.keys(afterMap)])];

  const diffResults = [];
  let i = 0;

  for (const url of allUrls) {
    i++;
    process.stdout.write(`\r  比較中... ${i}/${allUrls.length}`);

    const beforePage = beforeMap[url];
    const afterPage = afterMap[url];

    const entry = {
      url,
      beforeStatus: beforePage?.status ?? null,
      afterStatus: afterPage?.status ?? null,
      isNew: !beforePage,
      isRemoved: !afterPage,
      diffRatio: 0,
      diffFilename: null,
      hasBrokenLinks: (afterPage?.outboundBroken ?? []).length > 0,
      brokenLinks: afterPage?.outboundBroken ?? [],
    };

    // スクリーンショット比較
    if (beforePage?.screenshot && afterPage?.screenshot && beforePage.screenshot === afterPage.screenshot) {
      const result = await compareScreenshots(beforePage.screenshot);
      if (result) {
        entry.diffRatio = result.diffRatio;
        entry.diffFilename = result.diffFilename;
      }
    }

    diffResults.push(entry);
  }

  console.log("\n");

  // 変化ありのページを分類
  const visualDiffs = diffResults
    .filter((r) => r.diffRatio > config.diffThreshold)
    .sort((a, b) => b.diffRatio - a.diffRatio);

  const newPages = diffResults.filter((r) => r.isNew);
  const removedPages = diffResults.filter((r) => r.isRemoved);
  const statusChanged = diffResults.filter(
    (r) => r.beforeStatus !== null && r.afterStatus !== null && r.beforeStatus !== r.afterStatus
  );

  // アップデート後のリンク切れ（重複排除）
  const allBrokenLinks = after.brokenLinks ?? [];
  const uniqueBrokenLinks = [];
  const seenBroken = new Set();
  for (const b of allBrokenLinks) {
    const key = b.url;
    if (!seenBroken.has(key)) {
      seenBroken.add(key);
      uniqueBrokenLinks.push(b);
    }
  }

  // HTMLレポート生成
  const reportPath = path.join(config.reportDir, "report.html");

  // report.html は reportDir 直下、SS は reportDir/before|after|diff にあるので相対パスは "./"
  const relBefore = "./before/screenshots/";
  const relAfter = "./after/screenshots/";
  const relDiff = "./diff/";

  const html = `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>WP Update Checker Report</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: #0f1117; color: #e2e8f0; line-height: 1.6; }
  header { background: #1a1d2e; border-bottom: 1px solid #2d3154; padding: 24px 32px; }
  header h1 { font-size: 1.5rem; font-weight: 700; color: #7c9ef8; }
  header .meta { color: #64748b; font-size: 0.85rem; margin-top: 6px; }
  .summary { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 16px; padding: 24px 32px; }
  .stat { background: #1a1d2e; border: 1px solid #2d3154; border-radius: 10px; padding: 16px 20px; }
  .stat .num { font-size: 2rem; font-weight: 800; }
  .stat .label { font-size: 0.8rem; color: #64748b; margin-top: 2px; }
  .stat.danger .num { color: #f87171; }
  .stat.warn .num { color: #fbbf24; }
  .stat.ok .num { color: #34d399; }
  .stat.info .num { color: #7c9ef8; }
  section { padding: 0 32px 32px; }
  h2 { font-size: 1.1rem; font-weight: 700; color: #94a3b8; border-bottom: 1px solid #2d3154; padding-bottom: 10px; margin-bottom: 16px; margin-top: 32px; }
  h2 .badge { font-size: 0.75rem; background: #2d3154; padding: 2px 10px; border-radius: 20px; margin-left: 8px; }
  table { width: 100%; border-collapse: collapse; font-size: 0.875rem; }
  th { text-align: left; color: #475569; font-weight: 600; font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.05em; padding: 8px 12px; border-bottom: 1px solid #2d3154; }
  td { padding: 10px 12px; border-bottom: 1px solid #1e2235; vertical-align: top; }
  tr:hover td { background: #1a1d2e; }
  .url { color: #7c9ef8; word-break: break-all; font-family: monospace; font-size: 0.8rem; }
  .url a { color: inherit; text-decoration: none; }
  .url a:hover { text-decoration: underline; }
  .diff-pct { font-weight: 700; }
  .diff-pct.high { color: #f87171; }
  .diff-pct.mid { color: #fbbf24; }
  .diff-pct.low { color: #34d399; }
  .status { display: inline-block; padding: 2px 8px; border-radius: 4px; font-size: 0.75rem; font-weight: 700; }
  .status.ok { background: #14532d; color: #4ade80; }
  .status.err { background: #450a0a; color: #f87171; }
  .status.warn { background: #431407; color: #fb923c; }
  .screenshots { display: flex; gap: 8px; margin-top: 8px; flex-wrap: wrap; }
  .screenshots a { display: block; }
  .screenshots img { width: 200px; border: 1px solid #2d3154; border-radius: 4px; display: block; }
  .screenshots .cap { font-size: 0.7rem; color: #475569; text-align: center; margin-top: 2px; }
  .tag { display: inline-block; font-size: 0.7rem; padding: 1px 6px; border-radius: 3px; }
  .tag.new { background: #1e3a5f; color: #60a5fa; }
  .tag.removed { background: #3b0f0f; color: #f87171; }
  .empty { color: #475569; font-style: italic; padding: 20px 0; text-align: center; }
</style>
</head>
<body>
<header>
  <h1>🔍 WP Update Checker</h1>
  <div class="meta">
    対象: ${escapeHtml(config.baseUrl)} &nbsp;|&nbsp;
    Before: ${escapeHtml(before.crawledAt)} &nbsp;|&nbsp;
    After: ${escapeHtml(after.crawledAt)}
  </div>
</header>

<div class="summary">
  <div class="stat ${visualDiffs.length > 0 ? "warn" : "ok"}">
    <div class="num">${visualDiffs.length}</div>
    <div class="label">ビジュアル差分あり</div>
  </div>
  <div class="stat ${uniqueBrokenLinks.length > 0 ? "danger" : "ok"}">
    <div class="num">${uniqueBrokenLinks.length}</div>
    <div class="label">リンク切れ（ユニーク）</div>
  </div>
  <div class="stat ${statusChanged.length > 0 ? "warn" : "ok"}">
    <div class="num">${statusChanged.length}</div>
    <div class="label">ステータス変化</div>
  </div>
  <div class="stat info">
    <div class="num">${newPages.length}</div>
    <div class="label">新規ページ</div>
  </div>
  <div class="stat ${removedPages.length > 0 ? "warn" : "info"}">
    <div class="num">${removedPages.length}</div>
    <div class="label">消えたページ</div>
  </div>
  <div class="stat info">
    <div class="num">${allUrls.length}</div>
    <div class="label">総チェックページ</div>
  </div>
</div>

<section>
  <!-- ビジュアル差分 -->
  <h2>📸 ビジュアル差分 <span class="badge">${visualDiffs.length}件</span></h2>
  ${visualDiffs.length === 0
    ? `<div class="empty">差分なし ✅</div>`
    : `<table>
    <thead><tr>
      <th>URL</th>
      <th>差分率</th>
      <th>スクリーンショット比較</th>
    </tr></thead>
    <tbody>
    ${visualDiffs.map((r) => {
      const pct = r.diffRatio * 100;
      const cls = pct > 20 ? "high" : pct > 5 ? "mid" : "low";
      const bPage = beforeMap[r.url];
      const aPage = afterMap[r.url];
      return `<tr>
        <td class="url"><a href="${escapeHtml(r.url)}" target="_blank">${escapeHtml(r.url)}</a></td>
        <td><span class="diff-pct ${cls}">${toPercent(r.diffRatio)}</span></td>
        <td>
          <div class="screenshots">
            ${bPage?.screenshot ? `<div><a href="${relBefore}${escapeHtml(bPage.screenshot)}" target="_blank"><img src="${relBefore}${escapeHtml(bPage.screenshot)}" loading="lazy"></a><div class="cap">Before</div></div>` : ""}
            ${aPage?.screenshot ? `<div><a href="${relAfter}${escapeHtml(aPage.screenshot)}" target="_blank"><img src="${relAfter}${escapeHtml(aPage.screenshot)}" loading="lazy"></a><div class="cap">After</div></div>` : ""}
            ${r.diffFilename ? `<div><a href="${relDiff}${escapeHtml(r.diffFilename)}" target="_blank"><img src="${relDiff}${escapeHtml(r.diffFilename)}" loading="lazy"></a><div class="cap">Diff</div></div>` : ""}
          </div>
        </td>
      </tr>`;
    }).join("")}
    </tbody></table>`}

  <!-- リンク切れ -->
  <h2>🔗 リンク切れ <span class="badge">${uniqueBrokenLinks.length}件</span></h2>
  ${uniqueBrokenLinks.length === 0
    ? `<div class="empty">リンク切れなし ✅</div>`
    : `<table>
    <thead><tr>
      <th>リンク切れURL</th>
      <th>ステータス</th>
      <th>発見したページ</th>
    </tr></thead>
    <tbody>
    ${uniqueBrokenLinks.map((b) => `<tr>
      <td class="url">${escapeHtml(b.url)}</td>
      <td><span class="status err">${escapeHtml(String(b.status || "接続不可"))}</span></td>
      <td class="url"><a href="${escapeHtml(b.foundOn)}" target="_blank">${escapeHtml(b.foundOn)}</a></td>
    </tr>`).join("")}
    </tbody></table>`}

  <!-- ステータス変化 -->
  <h2>⚡ HTTPステータス変化 <span class="badge">${statusChanged.length}件</span></h2>
  ${statusChanged.length === 0
    ? `<div class="empty">ステータス変化なし ✅</div>`
    : `<table>
    <thead><tr><th>URL</th><th>Before</th><th>After</th></tr></thead>
    <tbody>
    ${statusChanged.map((r) => {
      const bCls = r.beforeStatus < 400 ? "ok" : "err";
      const aCls = r.afterStatus < 400 ? "ok" : r.afterStatus < 500 ? "warn" : "err";
      return `<tr>
        <td class="url"><a href="${escapeHtml(r.url)}" target="_blank">${escapeHtml(r.url)}</a></td>
        <td><span class="status ${bCls}">${r.beforeStatus}</span></td>
        <td><span class="status ${aCls}">${r.afterStatus}</span></td>
      </tr>`;
    }).join("")}
    </tbody></table>`}

  <!-- 新規・削除ページ -->
  <h2>🆕 新規ページ <span class="badge">${newPages.length}件</span></h2>
  ${newPages.length === 0
    ? `<div class="empty">なし</div>`
    : `<table><thead><tr><th>URL</th><th>ステータス</th></tr></thead><tbody>
    ${newPages.map((r) => `<tr>
      <td class="url"><a href="${escapeHtml(r.url)}" target="_blank">${escapeHtml(r.url)}</a> <span class="tag new">NEW</span></td>
      <td><span class="status ${(r.afterStatus ?? 0) < 400 ? "ok" : "err"}">${r.afterStatus ?? "-"}</span></td>
    </tr>`).join("")}
    </tbody></table>`}

  <h2>🗑️ 消えたページ <span class="badge">${removedPages.length}件</span></h2>
  ${removedPages.length === 0
    ? `<div class="empty">なし</div>`
    : `<table><thead><tr><th>URL</th><th>Beforeステータス</th></tr></thead><tbody>
    ${removedPages.map((r) => `<tr>
      <td class="url">${escapeHtml(r.url)} <span class="tag removed">REMOVED</span></td>
      <td><span class="status ${(r.beforeStatus ?? 0) < 400 ? "ok" : "err"}">${r.beforeStatus ?? "-"}</span></td>
    </tr>`).join("")}
    </tbody></table>`}
</section>
</body>
</html>`;

  fs.writeFileSync(reportPath, html);

  console.log("📊 レポート生成完了！");
  console.log(`   ビジュアル差分  : ${visualDiffs.length}件`);
  console.log(`   リンク切れ      : ${uniqueBrokenLinks.length}件`);
  console.log(`   ステータス変化  : ${statusChanged.length}件`);
  console.log(`\n   レポート: ${reportPath}\n`);
}

generateReport().catch((err) => {
  console.error("致命的エラー:", err);
  process.exit(1);
});
