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
import {
  escapeHtml,
  toPercent,
  detectMissingScreenshot,
  classifyVisualChange,
  isUniformBlackBand,
} from "./util.js";

const config = await resolveTarget(process.argv[2]);

const beforeDir = path.join(config.reportDir, "before", "screenshots");
const afterDir = path.join(config.reportDir, "after", "screenshots");
const diffDir = path.join(config.reportDir, "diff");
const beforeData = path.join(config.reportDir, "before", "results.json");
const afterData = path.join(config.reportDir, "after", "results.json");

// クライアント納品用の自己完結フォルダ。report.html と、レポートで実際に
// 使う画像だけを assets/ に集約する。これごと渡せば before/after/diff の
// 作業データ（全ページの生スクショ）を含めずに分離できる。
const reportOutDir = path.join(config.reportDir, "report");
const assetsDir = path.join(reportOutDir, "assets");

fs.mkdirSync(diffDir, { recursive: true });

// レポートで参照する画像を assets/ にコピーして相対パスを返す。
// before/after は同名なので prefix で衝突回避（diff は既に diff_ 前置済み）。
// 同一ファイルの二重コピーは copiedAssets で抑止する。
const copiedAssets = new Set();
function copyAsset(srcDir, filename, prefix = "") {
  if (!filename) return null;
  const dest = prefix + filename;
  const rel = "./assets/" + dest;
  if (copiedAssets.has(dest)) return rel;
  try {
    fs.copyFileSync(path.join(srcDir, filename), path.join(assetsDir, dest));
    copiedAssets.add(dest);
    return rel;
  } catch (err) {
    console.error(`⚠️  画像コピー失敗: ${filename} - ${err.message}`);
    return null;
  }
}

function loadPNG(filepath) {
  // readFileSync / PNG.sync.read は同期。破損 PNG はここで throw する。
  const data = fs.readFileSync(filepath);
  return PNG.sync.read(data);
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

function compareScreenshots(filename) {
  const beforePath = path.join(beforeDir, filename);
  const afterPath = path.join(afterDir, filename);

  if (!fs.existsSync(beforePath) || !fs.existsSync(afterPath)) {
    return null;
  }

  // PNG 読み込み・比較・diff 書き出しのいずれかが失敗しても、
  // 比較ループ全体を巻き込まず「比較不能」として返す。
  try {
    let imgBefore = loadPNG(beforePath);
    let imgAfter = loadPNG(afterPath);

    // サイズが異なる場合は大きい方に合わせる
    const width = Math.max(imgBefore.width, imgAfter.width);
    const height = Math.max(imgBefore.height, imgAfter.height);

    // 高さが違う場合、「高い方だけにある末尾領域」が全幅・純黒の一様帯なら
    // fullPage スクショのアーティファクト（末尾黒帯）とみなす。低い方は単なる
    // 余白なので、この帯は実コンテンツの差ではない。差分から除外して別枠で扱う。
    let artifact = null;
    if (imgBefore.height !== imgAfter.height) {
      const tallerIsAfter = imgAfter.height > imgBefore.height;
      const taller = tallerIsAfter ? imgAfter : imgBefore;
      const minH = Math.min(imgBefore.height, imgAfter.height);
      // taller の幅が共通幅と一致する前提（viewport 固定なので通常一致する）
      if (taller.width === width && isUniformBlackBand(taller.data, taller.width, minH, taller.height)) {
        artifact = {
          type: "bottom-black-band",
          phase: tallerIsAfter ? "after" : "before",
          bandHeight: taller.height - minH,
          bandPx: (taller.height - minH) * width,
        };
      }
    }

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

    // アーティファクト帯のぶんを差し引いた「実差分」。帯領域は白パディング vs
    // 黒で必ず全画素 diff になるため bandPx を引く。これを分類・表示に使うことで
    // 末尾黒帯で差分率が膨らんだり「要確認」に化けたりするのを防ぐ。
    const realNumDiff = artifact ? Math.max(0, numDiff - artifact.bandPx) : numDiff;
    const realDiffRatio = realNumDiff / totalPixels;

    // 1px でも違えば diff 画像を残す（取りこぼし防止）。閾値はあくまで
    // 「強調するか」の判定で、ここでは「変化があるか」だけを見る。
    if (numDiff > 0) {
      const diffFilename = "diff_" + filename;
      fs.writeFileSync(
        path.join(diffDir, diffFilename),
        PNG.sync.write(diffImg)
      );
      return { diffRatio, diffFilename, numDiff, totalPixels, realNumDiff, realDiffRatio, artifact };
    }

    return { diffRatio, diffFilename: null, numDiff, totalPixels, realNumDiff, realDiffRatio, artifact };
  } catch (err) {
    return { error: `画像比較失敗: ${err.message}` };
  }
}

// results.json を読み込む。クロールが途中で落ちると JSON が壊れている
// ことがあるので、原因の分かるメッセージを出して終了する。
function loadResults(filepath, phase) {
  let raw;
  try {
    raw = fs.readFileSync(filepath, "utf8");
  } catch (err) {
    console.error(`❌ ${phase} の results.json を読み込めません: ${err.message}`);
    process.exit(1);
  }

  let data;
  try {
    data = JSON.parse(raw);
  } catch (err) {
    console.error(`❌ ${phase} の results.json が壊れています（${filepath}）: ${err.message}`);
    console.error("   クロールが途中で失敗した可能性があります。crawl を再実行してください。");
    process.exit(1);
  }

  if (!data || !Array.isArray(data.pages)) {
    console.error(`❌ ${phase} の results.json に pages 配列がありません（${filepath}）。`);
    console.error("   crawl を再実行してください。");
    process.exit(1);
  }

  return data;
}

async function generateReport() {
  console.log("\n🔍 差分レポート生成中...\n");

  if (!fs.existsSync(beforeData) || !fs.existsSync(afterData)) {
    console.error("❌ before/after の results.json が見つかりません。先に crawl を実行してください。");
    process.exit(1);
  }

  const before = loadResults(beforeData, "before");
  const after = loadResults(afterData, "after");

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
      numDiff: 0,
      rawNumDiff: 0,
      diffFilename: null,
      // 末尾黒帯アーティファクト（自動判定）。検出時のみオブジェクトが入る。
      artifact: null,
      hasBrokenLinks: (afterPage?.outboundBroken ?? []).length > 0,
      brokenLinks: afterPage?.outboundBroken ?? [],
      // 両フェーズにページは存在するのにスクショが欠落・比較不能なケース
      captureFailed: false,
      captureNote: null,
    };

    // スクリーンショット比較
    if (beforePage?.screenshot && afterPage?.screenshot && beforePage.screenshot === afterPage.screenshot) {
      const result = await compareScreenshots(beforePage.screenshot);
      if (result && result.error) {
        // PNG 破損などで比較できなかった
        entry.captureFailed = true;
        entry.captureNote = result.error;
      } else if (result) {
        // 分類・表示はアーティファクト帯を除いた実差分で行う（黒帯で % が
        // 膨らんだり「要確認」に化けたりしないように）。raw は参考に保持。
        entry.diffRatio = result.realDiffRatio ?? result.diffRatio;
        entry.numDiff = result.realNumDiff ?? result.numDiff;
        entry.rawNumDiff = result.numDiff;
        entry.artifact = result.artifact ?? null;
        entry.diffFilename = result.diffFilename;
      }
    } else {
      // 両フェーズにページはあるのに片方（または両方）のスクショが無い＝撮影失敗。
      // ここを見逃すと「壊れてスクショが撮れなくなったページ」が差分0で素通りする。
      const missing = detectMissingScreenshot(beforePage, afterPage);
      if (missing) {
        entry.captureFailed = missing.captureFailed;
        entry.captureNote = missing.captureNote;
      }
    }

    diffResults.push(entry);
  }

  console.log("\n");

  // 変化ありのページを分類。
  // 1px でも違えば一覧に出す（ヒットミス防止）。各ページの分類は
  // classifyVisualChange が "significant"（閾値以上＝強調）/ "minor" を返す。
  const visualDiffs = diffResults
    .map((r) => ({
      ...r,
      changeLevel: classifyVisualChange(r, config.diffThreshold),
    }))
    .filter((r) => r.changeLevel !== "none")
    .sort((a, b) => b.diffRatio - a.diffRatio);

  // 閾値以上の「要確認」件数（サマリーで強調するため）
  const significantDiffs = visualDiffs.filter((r) => r.changeLevel === "significant");

  // 末尾黒帯アーティファクト（自動判定）として検出されたページ。実差分は
  // 帯を除いて分類済みなので、純粋な黒帯だけのページは visualDiffs に出ない。
  // 人が後から確認できるよう別枠で一覧する（誤判定だった場合の保険）。
  const artifactPages = diffResults.filter((r) => r.artifact);

  // 納品用 assets/ を作り直し（古い画像を残さない）、レポートで使う
  // before/after/diff 画像だけをコピーして相対パスを各エントリに付与する。
  // ビジュアル差分とアーティファクト両方の画像を集約する（copyAsset は重複抑止）。
  fs.rmSync(assetsDir, { recursive: true, force: true });
  fs.mkdirSync(assetsDir, { recursive: true });
  for (const r of [...visualDiffs, ...artifactPages]) {
    r.beforeAsset = copyAsset(beforeDir, beforeMap[r.url]?.screenshot, "before_");
    r.afterAsset = copyAsset(afterDir, afterMap[r.url]?.screenshot, "after_");
    r.diffAsset = copyAsset(diffDir, r.diffFilename, "");
  }

  const newPages = diffResults.filter((r) => r.isNew);
  const removedPages = diffResults.filter((r) => r.isRemoved);
  const captureFailures = diffResults.filter((r) => r.captureFailed);
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

  // HTMLレポート生成。report.html は assets/ と同じ report/ 配下に置くので
  // 画像への相対パスは "./assets/..."（copyAsset の戻り値）。
  const reportPath = path.join(reportOutDir, "report.html");

  const html = `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Site Update Checker Report</title>
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
  .diff-px { font-size: 0.72rem; color: #64748b; }
  tr.significant td { background: #2a1620; }
  tr.significant:hover td { background: #341a28; }
  .tag.review { background: #7f1d1d; color: #fecaca; font-weight: 700; }
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
  .tag.artifact { background: #1f2937; color: #9ca3af; }
  .empty { color: #475569; font-style: italic; padding: 20px 0; text-align: center; }
</style>
</head>
<body>
<header>
  <h1>🔍 Site Update Checker</h1>
  <div class="meta">
    対象: ${escapeHtml(config.baseUrl)} &nbsp;|&nbsp;
    Before: ${escapeHtml(before.crawledAt)} &nbsp;|&nbsp;
    After: ${escapeHtml(after.crawledAt)}
  </div>
</header>

<div class="summary">
  <div class="stat ${visualDiffs.length > 0 ? "warn" : "ok"}">
    <div class="num">${visualDiffs.length}</div>
    <div class="label">ビジュアル差分あり（1px〜）</div>
  </div>
  <div class="stat ${significantDiffs.length > 0 ? "danger" : "ok"}">
    <div class="num">${significantDiffs.length}</div>
    <div class="label">うち要確認（閾値以上）</div>
  </div>
  <div class="stat ${uniqueBrokenLinks.length > 0 ? "danger" : "ok"}">
    <div class="num">${uniqueBrokenLinks.length}</div>
    <div class="label">リンク切れ（ユニーク）</div>
  </div>
  <div class="stat ${statusChanged.length > 0 ? "warn" : "ok"}">
    <div class="num">${statusChanged.length}</div>
    <div class="label">ステータス変化</div>
  </div>
  <div class="stat ${captureFailures.length > 0 ? "danger" : "ok"}">
    <div class="num">${captureFailures.length}</div>
    <div class="label">撮影失敗・比較不能</div>
  </div>
  <div class="stat ${artifactPages.length > 0 ? "warn" : "ok"}">
    <div class="num">${artifactPages.length}</div>
    <div class="label">末尾黒帯（自動補正）</div>
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
      const isSignificant = r.changeLevel === "significant";
      return `<tr class="${isSignificant ? "significant" : ""}">
        <td class="url"><a href="${escapeHtml(r.url)}" target="_blank">${escapeHtml(r.url)}</a>${isSignificant ? ` <span class="tag review">要確認</span>` : ""}${r.artifact ? ` <span class="tag artifact">末尾黒帯補正</span>` : ""}</td>
        <td><span class="diff-pct ${cls}">${toPercent(r.diffRatio)}</span> <span class="diff-px">${r.numDiff.toLocaleString()}px</span></td>
        <td>
          <div class="screenshots">
            ${r.beforeAsset ? `<div><a href="${r.beforeAsset}" target="_blank"><img src="${r.beforeAsset}" loading="lazy"></a><div class="cap">Before</div></div>` : ""}
            ${r.afterAsset ? `<div><a href="${r.afterAsset}" target="_blank"><img src="${r.afterAsset}" loading="lazy"></a><div class="cap">After</div></div>` : ""}
            ${r.diffAsset ? `<div><a href="${r.diffAsset}" target="_blank"><img src="${r.diffAsset}" loading="lazy"></a><div class="cap">Diff</div></div>` : ""}
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

  <!-- 撮影失敗・比較不能 -->
  <h2>🚫 撮影失敗・比較不能 <span class="badge">${captureFailures.length}件</span></h2>
  ${captureFailures.length === 0
    ? `<div class="empty">なし ✅</div>`
    : `<table>
    <thead><tr><th>URL</th><th>Before</th><th>After</th><th>理由</th></tr></thead>
    <tbody>
    ${captureFailures.map((r) => {
      const bCls = (r.beforeStatus ?? 0) < 400 ? "ok" : "err";
      const aCls = (r.afterStatus ?? 0) < 400 ? "ok" : "err";
      return `<tr>
        <td class="url"><a href="${escapeHtml(r.url)}" target="_blank">${escapeHtml(r.url)}</a></td>
        <td><span class="status ${bCls}">${r.beforeStatus ?? "-"}</span></td>
        <td><span class="status ${aCls}">${r.afterStatus ?? "-"}</span></td>
        <td>${escapeHtml(r.captureNote ?? "")}</td>
      </tr>`;
    }).join("")}
    </tbody></table>`}

  <!-- 末尾黒帯アーティファクト（自動補正） -->
  <h2>🩹 末尾黒帯アーティファクト（自動補正） <span class="badge">${artifactPages.length}件</span></h2>
  ${artifactPages.length === 0
    ? `<div class="empty">なし ✅</div>`
    : `<div class="empty" style="text-align:left;font-style:normal;color:#94a3b8;padding:0 0 12px">
       fullPage スクショで「測定した高さ」と「実際に描画された高さ」が食い違うと末尾が純黒で埋まることがあります（実コンテンツの差ではありません）。
       この帯は差分計算から自動的に除外済みです。念のため一覧します（誤判定でないか確認用）。
     </div>
     <table>
    <thead><tr><th>URL</th><th>黒帯</th><th>除外後の実差分</th><th>スクリーンショット比較</th></tr></thead>
    <tbody>
    ${artifactPages.map((r) => `<tr>
      <td class="url"><a href="${escapeHtml(r.url)}" target="_blank">${escapeHtml(r.url)}</a></td>
      <td>${escapeHtml(String(r.artifact.phase))} 末尾 ${r.artifact.bandHeight}px</td>
      <td><span class="diff-px">${r.numDiff.toLocaleString()}px（${toPercent(r.diffRatio)}）</span></td>
      <td>
        <div class="screenshots">
          ${r.beforeAsset ? `<div><a href="${r.beforeAsset}" target="_blank"><img src="${r.beforeAsset}" loading="lazy"></a><div class="cap">Before</div></div>` : ""}
          ${r.afterAsset ? `<div><a href="${r.afterAsset}" target="_blank"><img src="${r.afterAsset}" loading="lazy"></a><div class="cap">After</div></div>` : ""}
          ${r.diffAsset ? `<div><a href="${r.diffAsset}" target="_blank"><img src="${r.diffAsset}" loading="lazy"></a><div class="cap">Diff</div></div>` : ""}
        </div>
      </td>
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
  console.log(`   ビジュアル差分  : ${visualDiffs.length}件（うち要確認 ${significantDiffs.length}件）`);
  console.log(`   リンク切れ      : ${uniqueBrokenLinks.length}件`);
  console.log(`   ステータス変化  : ${statusChanged.length}件`);
  console.log(`   撮影失敗・比較不能: ${captureFailures.length}件`);
  console.log(`   末尾黒帯補正    : ${artifactPages.length}件`);
  console.log(`   納品用画像      : ${copiedAssets.size}枚 → ${assetsDir}`);
  console.log(`\n   レポート: ${reportPath}`);
  console.log(`   （クライアントには "${reportOutDir}" フォルダごと渡せば self-contained）\n`);
}

generateReport().catch((err) => {
  console.error("致命的エラー:", err);
  process.exit(1);
});
