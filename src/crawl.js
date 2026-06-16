/**
 * crawl.js
 * サイトをクロールして各ページのスクリーンショットを撮り、
 * リンク切れを記録する。
 *
 * 使い方:
 *   node src/crawl.js before   # アップデート前
 *   node src/crawl.js after    # アップデート後
 */

import { chromium } from "playwright";
import fs from "fs";
import path from "path";
import { config } from "../config.js";

const phase = process.argv[2];
if (!["before", "after"].includes(phase)) {
  console.error("Usage: node src/crawl.js [before|after]");
  process.exit(1);
}

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

async function crawl() {
  console.log(`\n🚀 クロール開始 [${phase}] - ${config.baseUrl}\n`);

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

          // スクリーンショット保存
          const filename = urlToFilename(url) + ".png";
          const ssPath = path.join(ssDir, filename);
          await page.screenshot({ path: ssPath, fullPage: true });
          result.screenshot = filename;

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
                  const r = await fetch(href, { method: "HEAD", redirect: "follow" });
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
          await page.close();
        }

        results.push(result);
      })
    );
  }

  await browser.close();

  // 結果を保存
  const output = {
    phase,
    baseUrl: config.baseUrl,
    crawledAt: new Date().toISOString(),
    totalPages: results.length,
    brokenLinks,
    pages: results,
  };

  fs.writeFileSync(dataFile, JSON.stringify(output, null, 2));

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
