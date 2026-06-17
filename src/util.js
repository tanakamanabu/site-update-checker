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
