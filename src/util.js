/**
 * util.js
 * crawl.js / diff.js から共有する副作用のない純粋関数群。
 * ここに置くものは I/O・process.exit・グローバル設定参照を持たないこと
 * （だからこそユニットテストできる）。
 */

import crypto from "node:crypto";

// URL を安全かつ衝突しないファイル名に変換する。
// 可読部だけだと、(1) サニタイズ後に別 URL が同名化する、(2) 大文字小文字を
// 区別しないファイルシステム（Windows / macOS 既定）で `/Foo` と `/foo` が
// 衝突する、という取りこぼしが起きる（別ページのスクショに上書きされる）。
// そこで可読部は小文字化して安定させ、元 URL 全体の短いハッシュを必ず付与して
// 一意性を担保する。同一 URL なら常に同じ名前になるので before/after も一致する。
export function urlToFilename(url) {
  const s = String(url);
  const hash = crypto.createHash("sha1").update(s).digest("hex").slice(0, 8);
  const base = s
    .replace(/^https?:\/\//, "")
    .replace(/[^a-zA-Z0-9_\-]/g, "_")
    .replace(/_+/g, "_")
    .toLowerCase()
    .slice(0, 150)
    .replace(/^_+|_+$/g, "");
  return base ? `${base}_${hash}` : hash;
}

// DNS 解決失敗・接続拒否などの「ネットワーク到達不可」エラーか判定する。
// これらは個別ページの問題ではなく、URL ミスや対象サーバー停止が原因で、
// 全ページ失敗が確定する。個別ページエラーと区別して早めに気づくために使う。
export function isNetworkUnreachable(message) {
  return /ERR_NAME_NOT_RESOLVED|ERR_CONNECTION_REFUSED|ERR_INTERNET_DISCONNECTED|ERR_ADDRESS_UNREACHABLE|ERR_CONNECTION_TIMED_OUT|ENOTFOUND|ECONNREFUSED|EAI_AGAIN/i.test(
    message ?? ""
  );
}

// url が baseUrl と同一ホストか判定する。パース不能なら false。
export function isSameDomain(url, baseUrl) {
  try {
    const base = new URL(baseUrl);
    const target = new URL(url);
    return target.hostname === base.hostname;
  } catch {
    return false;
  }
}

// url が除外パターン（正規表現の配列）のいずれかに一致するか判定する。
export function isExcluded(url, patterns) {
  return (patterns ?? []).some((p) => p.test(url));
}

// fetch でステータス確認する価値のある http(s) リンクか判定する。
// javascript:/mailto:/tel:/#... などの擬似リンクや、http://-/ のような
// 不正ホストは確認しても必ず失敗（status 0）になるだけで、無駄に時間を食う
// うえにリンク切れの誤検出も生む。確認対象から外すために使う。
export function isCheckableHttpLink(url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return false;
  // ホスト名が空、または "-" のみ等の明らかに不正なものを弾く
  if (!u.hostname || u.hostname === "-") return false;
  return true;
}

// fullPage スクショで時々出る「末尾の純黒帯」アーティファクト検出の中核。
// data(RGBA 配列) の y=[yStart, yEnd) × 全幅が、ほぼ純黒で一様な帯かを判定する。
// Chromium は「測定した scrollHeight」と「実際に paint した高さ」が食い違うと
// 末尾の未描画分を純黒で埋めることがある。高い方の画像の余剰高さ領域がこれに
// 該当し、かつ低い方は単なる余白なら、実コンテンツの変化ではなく描画
// アーティファクトとみなして「要確認」から外すために使う。
export function isUniformBlackBand(
  data,
  width,
  yStart,
  yEnd,
  { maxLuma = 8, blackRatio = 0.999 } = {}
) {
  if (width <= 0 || yEnd <= yStart) return false;
  let total = 0;
  let black = 0;
  for (let y = yStart; y < yEnd; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const luma = Math.max(data[i], data[i + 1], data[i + 2]);
      total++;
      if (luma <= maxLuma) black++;
    }
  }
  return total > 0 && black / total >= blackRatio;
}

// HTML 出力用にエスケープする。
export function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// 比率（0〜1）をパーセント表記の文字列にする。
export function toPercent(ratio) {
  return (ratio * 100).toFixed(2) + "%";
}

// スクショ比較結果を「変化なし / 軽微な変化 / 有意な変化」に分類する。
// 本番チェックの自動化ではヒットミスを避けたいので、1px でも違えば
// "minor" 以上（＝一覧に出す）とし、取りこぼしを構造的に無くす。
// diffThreshold 以上なら "significant"（＝レポートで強調表示する）。
// diffThreshold は「出す/出さない」ではなく「強調する/しない」の閾値。
export function classifyVisualChange({ numDiff = 0, diffRatio = 0 } = {}, diffThreshold = 0) {
  if (numDiff <= 0) return "none";
  return diffRatio > diffThreshold ? "significant" : "minor";
}

// 両フェーズにページが存在するのに screenshot が欠落しているケースを検出する。
// new/removed ページ（片方にしか存在しない）は対象外で null を返す。
// 欠落があれば { captureFailed: true, captureNote } を返す。
// これを見逃すと「壊れてスクショが撮れなくなったページ」が差分0で素通りする。
export function detectMissingScreenshot(beforePage, afterPage) {
  if (!beforePage || !afterPage) return null; // new/removed は別分類

  const missing = [];
  if (!beforePage.screenshot) missing.push("before");
  if (!afterPage.screenshot) missing.push("after");
  if (missing.length === 0) return null;

  const errNote = afterPage.error || beforePage.error;
  return {
    captureFailed: true,
    captureNote:
      `${missing.join(" / ")} のスクショ無し` + (errNote ? `（${errNote}）` : ""),
  };
}
