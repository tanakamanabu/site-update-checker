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
import {
  urlToFilename,
  isNetworkUnreachable,
  isSameDomain,
  isExcluded,
  isCheckableHttpLink,
} from "./util.js";

const phase = process.argv[2];
if (!["before", "after"].includes(phase)) {
  console.error("Usage: node src/crawl.js [before|after] [対象名]");
  process.exit(1);
}

const config = await resolveTarget(process.argv[3]);

const ssDir = path.join(config.reportDir, phase, "screenshots");
const dataFile = path.join(config.reportDir, phase, "results.json");

fs.mkdirSync(ssDir, { recursive: true });

// クロール開始時刻。最初の書き込み前に一度だけ確定させる。
const startedAt = new Date().toISOString();

// 現在までの結果を results.json に書き出す。バッチごとと、最後（finally）に
// 呼ぶことで、クロールが途中でクラッシュしても部分結果が残るようにする。
// finishedAt は呼ぶたびに更新されるので、最後の書き込み＝クロール終了時刻になる。
function writeResults(results, brokenLinks, rateLimited = []) {
  const finishedAt = new Date().toISOString();
  const output = {
    phase,
    baseUrl: config.baseUrl,
    startedAt,
    finishedAt,
    crawledAt: finishedAt, // 後方互換（旧 results.json 読み込み側のため）
    totalPages: results.length,
    brokenLinks,
    rateLimited,
    pages: results,
  };
  try {
    fs.writeFileSync(dataFile, JSON.stringify(output, null, 2));
  } catch (err) {
    console.error(`⚠️  results.json の書き込みに失敗: ${err.message}`);
  }
}

// スクショ前にページを安定化させる。フェードイン等のアニメーションは
// networkidle 後に再生されるため、そのまま撮ると before/after で別々の
// 中間フレームを撮ってしまい誤検出になる。対策として:
//  1. CSS アニメーション/トランジションを無効化し最終状態へ飛ばす
//  2. ページ全体をスクロールして IntersectionObserver 系の遅延表示を発火
//  3. JS（rAF）駆動のフェードイン用に screenshotDelay だけ待つ
async function stabilizePage(page, config) {
  if (config.disableAnimations !== false) {
    try {
      await page.addStyleTag({
        content: `
          *, *::before, *::after {
            animation-duration: 0s !important;
            animation-delay: 0s !important;
            animation-iteration-count: 1 !important;
            transition-duration: 0s !important;
            transition-delay: 0s !important;
            scroll-behavior: auto !important;
          }
        `,
      });
    } catch {
      // about:blank 等でスタイル注入に失敗しても撮影自体は続行する
    }
  }

  // 動的要素（カルーセル・広告・ランダム表示・#wrapper 内の演出等）が
  // before/after で別フレームになり誤差分を出す対象向けに、撮影前に
  // 任意のCSSを注入して特定要素を非表示（や固定）にできる。
  //  - hideSelectors: 非表示にしたいセレクタの配列 → display:none !important
  //  - injectCSS:     上記で足りない場合の生CSS文字列（任意の上書き）
  // この注入はスクロール／高さ安定待ちの前に行い、要素を消した後の高さで
  // fullPage スクショが安定するようにする。
  const hideSelectors = config.hideSelectors ?? [];
  const injectCSS = config.injectCSS ?? "";
  if (hideSelectors.length > 0 || injectCSS) {
    let content = "";
    if (hideSelectors.length > 0) {
      content += `${hideSelectors.join(", ")} { display: none !important; }\n`;
    }
    if (injectCSS) content += injectCSS;
    try {
      await page.addStyleTag({ content });
    } catch {
      // 注入失敗（about:blank 等）でも撮影は続行する
    }
  }

  // 遅延表示を発火させるため最下部まで段階スクロールしてから先頭へ戻す
  try {
    await page.evaluate(async () => {
      await new Promise((resolve) => {
        const step = window.innerHeight || 800;
        let y = 0;
        const timer = setInterval(() => {
          window.scrollTo(0, y);
          y += step;
          if (y >= document.body.scrollHeight) {
            clearInterval(timer);
            window.scrollTo(0, 0);
            resolve();
          }
        }, 50);
      });
    });
  } catch {
    // スクロール失敗は無視（撮影は続行）
  }

  // fullPage スクショは「測定した scrollHeight」と「実際に paint された高さ」が
  // 食い違うと、末尾の未描画分が純黒で埋まるアーティファクトを出す。直前の
  // スクロールで遅延要素や 100vh/sticky が再計算され高さが揺れている最中だと
  // 起きやすい。撮影前にドキュメント高さが連続して変わらなくなるまで待ち、
  // 揺れが収まってから撮ることで末尾黒帯を防ぐ。
  try {
    await page.evaluate(async () => {
      const getH = () =>
        Math.max(
          document.documentElement.scrollHeight,
          document.body ? document.body.scrollHeight : 0
        );
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const frame = () => new Promise((r) => requestAnimationFrame(() => r()));
      let last = getH();
      let stable = 0;
      // 3 回連続で高さが変わらなければ安定とみなす。最大 ~2s（40×50ms）で打ち切り。
      for (let i = 0; i < 40 && stable < 3; i++) {
        await sleep(50);
        await frame();
        const h = getH();
        if (h === last) {
          stable++;
        } else {
          stable = 0;
          last = h;
        }
      }
    });
  } catch {
    // 高さ監視の失敗は無視（撮影は続行）
  }

  const delay = config.screenshotDelay ?? 0;
  if (delay > 0) await page.waitForTimeout(delay);
}

// リンク先のHTTPステータスを確認する。ブラウザの fetch にはタイムアウトが
// 無いため、応答しない外部ホスト（SNS共有リンク等）に当たると既定の
// ネットワークタイムアウト（数十秒〜分）まで固まり、1ページの処理が極端に
// 遅くなる。AbortController で timeoutMs 上限を付けて頭打ちにする。
// 返り値: HTTPステータス（数値）/ fetch失敗は 0 / ページ消失等のNode側
// エラーは null（リンク切れとして誤計上しないため呼び出し側でスキップ）。
async function checkLinkStatus(page, href, timeoutMs) {
  try {
    return await page.evaluate(
      async ({ href, timeoutMs }) => {
        const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
        // 1回分の fetch（メソッド指定）。timeoutMs で AbortController 中断する。
        const doFetch = async (method) => {
          const controller = new AbortController();
          const t = setTimeout(() => controller.abort(), timeoutMs);
          try {
            return await fetch(href, {
              method,
              redirect: "follow",
              signal: controller.signal,
            });
          } finally {
            clearTimeout(t);
          }
        };
        try {
          let r = await doFetch("HEAD");
          // HEAD を許可しないサーバー（405/501）は GET で確認し直す。
          if (r.status === 405 || r.status === 501) {
            r = await doFetch("GET");
          }
          // 429（Too Many Requests）はリンク切れではなくレート制限。実際には
          // 生きているので、Retry-After を尊重して数回だけ待って再試行する。
          // 最後まで 429 のままなら呼び出し側で「死亡」扱いにせず「要確認
          // （レート制限）」へ振り分ける。
          let attempts = 0;
          while (r.status === 429 && attempts < 2) {
            attempts++;
            const ra = parseInt(r.headers.get("retry-after"), 10);
            // Retry-After（秒）が取れればそれに従い、無ければ指数的に待つ。
            // 1本のチェックが長引きすぎないよう上限 5s でクランプ。
            const waitMs = Math.min(
              Number.isFinite(ra) ? ra * 1000 : 1000 * attempts,
              5000
            );
            await sleep(waitMs);
            r = await doFetch("GET");
          }
          return r.status;
        } catch {
          // タイムアウト中断・ネットワーク失敗・CORS 等は到達不可とみなす
          return 0;
        }
      },
      { href, timeoutMs }
    );
  } catch {
    return null; // page.close 済み等、リンクとは無関係な失敗
  }
}

// 同時実行数に上限を付ける軽量リミッタ（外部依存なし）。max 件まで並行で
// 走らせ、超過分はキューに積んで空きが出たら順に実行する。リンク切れ
// チェックの瞬間同時リクエスト数を抑え、対象サーバーの 429（レート制限）を
// 防ぐために使う。
function createLimiter(max) {
  let active = 0;
  const queue = [];
  const next = () => {
    if (active >= max || queue.length === 0) return;
    active++;
    const { fn, resolve, reject } = queue.shift();
    fn().then(resolve, reject).finally(() => {
      active--;
      next();
    });
  };
  return (fn) =>
    new Promise((resolve, reject) => {
      queue.push({ fn, resolve, reject });
      next();
    });
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

  // 指定したリソース種別（image/media/font 等）をブロックして高速化する。
  // 画像が多いサイトは networkidle 待ちがボトルネックになるため、画像差分が
  // 不要な対象では blockResources:["image"] で大幅に短縮できる。
  // 既定（空）なら従来通り全リソースを読み込んでスクショに反映する。
  const blockResources = config.blockResources ?? [];
  if (blockResources.length > 0) {
    await context.route("**/*", (route) => {
      if (blockResources.includes(route.request().resourceType())) {
        route.abort().catch(() => route.continue().catch(() => {}));
      } else {
        route.continue().catch(() => {});
      }
    });
    console.log(`   リソースブロック: ${blockResources.join(", ")}`);
  }

  const visited = new Set();
  const queue = [config.baseUrl];
  const results = []; // { url, status, screenshot, links, error }
  const brokenLinks = []; // { url, status, foundOn }
  const rateLimited = []; // { url, status, foundOn } 429（要確認・死亡扱いしない）

  // リンク先のステータスを URL 単位でメモ化する。connpass/facebook/youtube 等の
  // 外部リンクは全ページ共通でリンクされているため、毎ページ確認し直すと
  // 1000 ページ規模では膨大な重複 fetch になる。値ではなく「確認中の Promise」を
  // 入れることで、複数ページが同じ URL を同時に確認し始めても fetch は1回に
  // 集約される（結果だけ入れると確認完了までの間にレースで重複 fetch が走る）。
  const linkStatusCache = new Map();

  const linkCheckTimeout = config.linkCheckTimeout ?? 8000;
  const checkExternalLinks = config.checkExternalLinks !== false; // 既定 On

  // リンク切れチェックの同時実行数の上限。従来は 1ページ内の全リンクを
  // Promise.all で一斉に叩き、さらにページ自体も concurrency 件並列だったため
  // 瞬間同時リクエストが (concurrency × ページ内リンク数) まで膨らみ、対象
  // サーバーに 429（レート制限）を出させていた。全ページ共有のリミッタで
  // 同時 fetch を linkConcurrency 件に頭打ちにする。
  const linkLimit = createLimiter(config.linkConcurrency ?? 6);

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
          outboundRateLimited: [],
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
            // フェードイン等の途中フレームを撮らないよう安定化させてから撮影
            await stabilizePage(page, config);
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

          const uniqueLinks = [...new Set(links)];

          // 同一ドメインのリンクは BFS キューへ追加（除外パターン適用）
          for (const link of uniqueLinks) {
            if (isExcluded(link, config.excludePatterns)) continue;
            if (config.stayOnDomain && isSameDomain(link, config.baseUrl) && !visited.has(link)) {
              const normalized = link.split("#")[0].split("?")[0];
              if (!visited.has(normalized) && !queue.includes(normalized)) {
                queue.push(normalized);
              }
            }
          }

          // リンク切れチェック対象を絞り込む:
          //  - 除外パターン該当は対象外
          //  - javascript:/mailto: 等の擬似リンク・不正ホストは対象外
          //  - checkExternalLinks:false なら外部ドメインは確認しない（内部のみ）
          const linksToCheck = uniqueLinks.filter((link) => {
            if (isExcluded(link, config.excludePatterns)) return false;
            if (!isCheckableHttpLink(link)) return false;
            if (!checkExternalLinks && !isSameDomain(link, config.baseUrl)) return false;
            return true;
          });

          // タイムアウト付きで並列に確認する。逐次（for await）だと1ページ内の
          // リンク待ち時間が「合計」になり、応答しない外部リンクが数本あるだけで
          // ページ処理が分単位で固まる。並列化で「最遅1本」に抑える。
          await Promise.all(
            linksToCheck.map(async (link) => {
              // キャッシュには Promise を入れる（同一 URL の同時確認を1回に集約）。
              // 実際の fetch は linkLimit を通すことで全ページ通算の同時数を頭打ち。
              let statusPromise = linkStatusCache.get(link);
              if (statusPromise === undefined) {
                statusPromise = linkLimit(() =>
                  checkLinkStatus(page, link, linkCheckTimeout)
                );
                linkStatusCache.set(link, statusPromise);
              }
              const status = await statusPromise;
              // null（Node側エラー）はリンク切れに誤計上しないようスキップ
              if (status === null) return;
              // 429 はレート制限。リトライしても 429 なら死亡扱いせず「要確認」へ。
              if (status === 429) {
                result.outboundRateLimited.push({ link, status });
                rateLimited.push({ url: link, status, foundOn: url });
              } else if (status === 0 || status >= 400) {
                result.outboundBroken.push({ link, status });
                brokenLinks.push({ url: link, status, foundOn: url });
              }
            })
          );

          processed++;
          const statusIcon = result.status < 400 ? "✅" : "❌";
          console.log(`${statusIcon} [${processed}] ${url} (${result.status})`);
        } catch (err) {
          result.error = err.message;
          result.status = 0;
          console.log(`💥 [${processed}] エラー: ${url} - ${err.message}`);
          // 起点 URL がネットワーク到達不可なら、以降も全滅が確定。冒頭で警告。
          if (url === config.baseUrl && isNetworkUnreachable(err.message)) {
            console.error(
              `\n⚠️  起点 URL に到達できません（ネットワーク到達不可）: ${config.baseUrl}`
            );
            console.error(
              "   baseUrl の綴り・スキーム（http/https）・対象サーバーの稼働を確認してください。"
            );
            console.error(
              "   Basic 認証付きステージングなら config.basicAuth の設定も確認してください。\n"
            );
          }
        } finally {
          await page.close().catch(() => {});
        }

        results.push(result);
      })
    );

      // バッチ完了ごとに逐次保存（途中クラッシュでも部分結果を残す）
      writeResults(results, brokenLinks, rateLimited);
    }
  } finally {
    await browser.close().catch(() => {});
    // 正常終了でもクラッシュ時でも、最終結果を確実に書き出す
    writeResults(results, brokenLinks, rateLimited);
  }

  // サマリー表示
  const errors = results.filter((r) => r.status === 0 || r.status >= 400);
  const unreachable = results.filter((r) => isNetworkUnreachable(r.error));
  console.log(`\n📊 クロール完了 [${phase}]`);
  console.log(`   総ページ数    : ${results.length}`);
  console.log(`   エラーページ  : ${errors.length}`);
  if (unreachable.length > 0) {
    console.log(`     うち到達不可: ${unreachable.length}（ネットワーク/DNS）`);
  }
  console.log(`   リンク切れ    : ${brokenLinks.length}`);
  if (rateLimited.length > 0) {
    console.log(`   レート制限(429): ${rateLimited.length}（要確認・死亡扱いせず）`);
  }
  console.log(`   結果保存先    : ${dataFile}\n`);
}

crawl().catch((err) => {
  console.error("致命的エラー:", err);
  process.exit(1);
});
