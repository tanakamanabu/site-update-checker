/**
 * crawl.js
 * サイトをクロールして各ページのスクリーンショットを撮り、
 * リンク切れを記録する。
 *
 * 使い方:
 *   node src/crawl.js before [対象名]   # アップデート前
 *   node src/crawl.js after  [対象名]   # アップデート後
 */

import { chromium } from "playwright";
import fs from "fs";
import path from "path";
import { resolveTarget } from "./target.js";

const phase = process.argv[2];
if (!["before", "after"].includes(phase)) {
  console.error("Usage: node src/crawl.js [before|after] [対象名]");
  process.exit(1);
}

const config = resolveTarget(process.argv[3]);

const ssDir = path.join(config.reportDir, phase, "screenshots");
const dataFile = path.join(config.reportDir, phase, "results.json");

fs.mkdirSync(ssDir, { recursive: true });

// URL を安全なファイル名に変換
function urlToFilename(url) {
  return url
    .replace(/^https?:\/\//, "")
    .replace(/[^a-zA-Z0-9_\-]/g, "_")
    .replace(/_+/g, "_")
    .substring(0, 200);
}

// 除外URLかどうか判定
function isExcluded(url) {
  return config.excludePatterns.some((p) => p.test(url));
}

// 同一ドメインかどうか判定
function isSameDomain(url) {
  try {
    const base = new URL(config.baseUrl);
    const target = new URL(url);
    return target.hostname === base.hostname;
  } catch {
    return false;
  }
}

// 現在までの結果を results.json に書き出す。バッチごとと、最後（finally）に
// 呼ぶことで、クロールが途中でクラッシュしても部分結果が残るようにする。
function writeResults(results, brokenLinks) {
  const output = {
    phase,
    baseUrl: config.baseUrl,
    crawledAt: new Date().toISOString(),
    totalPages: results.length,
    brokenLinks,
    pages: results,
  };
  try {
    fs.writeFileSync(dataFile, JSON.stringify(output, null, 2));
  } catch (err) {
    console.error(`⚠️  results.json の書き込みに失敗: ${err.message}`);
  }
}

async function crawl() {
  console.log(`\n🚀 クロール開始 [${config.name}/${phase}] - ${config.baseUrl}\n`);

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent: config.userAgent,
    viewport: config.viewport,
    httpCredentials: config.basicAuth ?? undefined,
    ignoreHTTPSErrors: true,
  });

  const visited = new Set();
  const queue = [config.baseUrl];
  const results = []; // { url, status, screenshot, links, error }
  const brokenLinks = []; // { url, status, foundOn }

  let processed = 0;

  try {
    while (queue.length > 0) {
    // concurrency 分だけ並列処理
    const batch = queue.splice(0, config.concurrency);
    await Promise.all(
      batch.map(async (url) => {
        if (visited.has(url)) return;
        visited.add(url);

        const result = {
          url,
          status: null,
          screenshot: null,
          outboundBroken: [],
          error: null,
        };

        const page = await context.newPage();
        try {
          // ページ読み込み
          const response = await page.goto(url, {
            timeout: config.timeout,
            waitUntil: "networkidle",
          });

          result.status = response?.status() ?? 0;

          // スクリーンショット保存。撮影・書き込み失敗（容量不足・権限など）で
          // ページ全体を読み込みエラー扱いにせず、撮影失敗だけを記録する。
          // screenshot が null のままなら diff 側が「撮影失敗」として拾う。
          const filename = urlToFilename(url) + ".png";
          const ssPath = path.join(ssDir, filename);
          try {
            await page.screenshot({ path: ssPath, fullPage: true });
            result.screenshot = filename;
          } catch (ssErr) {
            result.error = `スクショ失敗: ${ssErr.message}`;
            console.log(`📷 [${processed}] スクショ失敗: ${url} - ${ssErr.message}`);
          }

          // ページ内のリンクを収集
          const links = await page.evaluate(() => {
            return Array.from(document.querySelectorAll("a[href]"))
              .map((a) => a.href)
              .filter(Boolean);
          });

          // リンク切れチェック（ページ内リンクをfetchで確認）
          const uniqueLinks = [...new Set(links)];
          for (const link of uniqueLinks) {
            if (isExcluded(link)) continue;

            // 同一ドメインのリンクはキューに追加
            if (config.stayOnDomain && isSameDomain(link) && !visited.has(link)) {
              const normalized = link.split("#")[0].split("?")[0];
              if (!visited.has(normalized) && !queue.includes(normalized)) {
                queue.push(normalized);
              }
            }

            // リンク先のHTTPステータス確認
            try {
              const res = await page.evaluate(async (href) => {
                try {
                  let r = await fetch(href, { method: "HEAD", redirect: "follow" });
                  // HEAD を許可しないサーバー（405/501）は GET で確認し直す。
                  // HEAD 固定だと生きてるリンクを誤って「リンク切れ」と判定する。
                  if (r.status === 405 || r.status === 501) {
                    r = await fetch(href, { method: "GET", redirect: "follow" });
                  }
                  return r.status;
                } catch {
                  return 0;
                }
              }, link);

              if (res === 0 || res >= 400) {
                result.outboundBroken.push({ link, status: res });
                brokenLinks.push({ url: link, status: res, foundOn: url });
              }
            } catch {
              // fetch失敗は無視
            }
          }

          processed++;
          const statusIcon = result.status < 400 ? "✅" : "❌";
          console.log(`${statusIcon} [${processed}] ${url} (${result.status})`);
        } catch (err) {
          result.error = err.message;
          result.status = 0;
          console.log(`💥 [${processed}] エラー: ${url} - ${err.message}`);
        } finally {
          await page.close().catch(() => {});
        }

        results.push(result);
      })
    );

      // バッチ完了ごとに逐次保存（途中クラッシュでも部分結果を残す）
      writeResults(results, brokenLinks);
    }
  } finally {
    await browser.close().catch(() => {});
    // 正常終了でもクラッシュ時でも、最終結果を確実に書き出す
    writeResults(results, brokenLinks);
  }

  // サマリー表示
  const errors = results.filter((r) => r.status === 0 || r.status >= 400);
  console.log(`\n📊 クロール完了 [${phase}]`);
  console.log(`   総ページ数    : ${results.length}`);
  console.log(`   エラーページ  : ${errors.length}`);
  console.log(`   リンク切れ    : ${brokenLinks.length}`);
  console.log(`   結果保存先    : ${dataFile}\n`);
}

crawl().catch((err) => {
  console.error("致命的エラー:", err);
  process.exit(1);
});
