/**
 * util.js のユニットテスト（Node 標準テストランナー）。
 *   node --test
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  urlToFilename,
  isNetworkUnreachable,
  isSameDomain,
  isExcluded,
  isCheckableHttpLink,
  isUniformBlackBand,
  escapeHtml,
  toPercent,
  detectMissingScreenshot,
  classifyVisualChange,
} from "../src/util.js";

test("urlToFilename: スキームを落とし安全な文字に変換し、末尾にハッシュを付ける", () => {
  const name = urlToFilename("https://example.com/foo/bar?x=1#sec");
  // 可読部は小文字化、末尾は 8 桁の16進ハッシュ
  assert.match(name, /^example_com_foo_bar_x_1_sec_[0-9a-f]{8}$/);
});

test("urlToFilename: 連続する _ は1つにまとめ、ハイフンは保持する", () => {
  assert.match(urlToFilename("http://a.com//b__c"), /^a_com_b_c_[0-9a-f]{8}$/);
  assert.match(urlToFilename("http://a.com/b-c"), /^a_com_b-c_[0-9a-f]{8}$/);
});

test("urlToFilename: 同一URLは常に同じ名前（before/after が一致する）", () => {
  const u = "https://example.com/page";
  assert.equal(urlToFilename(u), urlToFilename(u));
});

test("urlToFilename: 大小違いの別URLは別ファイルになる（衝突しない）", () => {
  // 大文字小文字を区別しないFSでも上書きされないこと
  assert.notEqual(urlToFilename("http://a.com/Foo"), urlToFilename("http://a.com/foo"));
  // サニタイズ後に同名化しがちなケースも、ハッシュで分離される
  assert.notEqual(urlToFilename("http://a.com/a?b"), urlToFilename("http://a.com/a/b"));
});

test("urlToFilename: 長いURLでも上限内に収める", () => {
  const long = "https://example.com/" + "a".repeat(500);
  // 可読部150 + "_" + ハッシュ8 = 最大159
  assert.ok(urlToFilename(long).length <= 159);
  assert.match(urlToFilename(long), /_[0-9a-f]{8}$/);
});

test("isNetworkUnreachable: DNS/接続系エラーを検出する", () => {
  for (const msg of [
    "page.goto: net::ERR_NAME_NOT_RESOLVED at https://x/",
    "connect ECONNREFUSED 127.0.0.1:80",
    "getaddrinfo ENOTFOUND example.invalid",
    "net::ERR_CONNECTION_REFUSED",
  ]) {
    assert.equal(isNetworkUnreachable(msg), true, msg);
  }
});

test("isNetworkUnreachable: 通常のページエラーは到達不可ではない", () => {
  assert.equal(isNetworkUnreachable("Timeout 30000ms exceeded"), false);
  assert.equal(isNetworkUnreachable("net::ERR_ABORTED"), false);
});

test("isNetworkUnreachable: null/undefined を安全に扱う", () => {
  assert.equal(isNetworkUnreachable(null), false);
  assert.equal(isNetworkUnreachable(undefined), false);
});

test("isSameDomain: 同一ホストのみ true", () => {
  const base = "https://example.com";
  assert.equal(isSameDomain("https://example.com/a", base), true);
  assert.equal(isSameDomain("http://example.com/a", base), true); // スキーム違いは同一ホスト
  assert.equal(isSameDomain("https://sub.example.com/a", base), false);
  assert.equal(isSameDomain("https://other.com", base), false);
});

test("isSameDomain: パース不能な URL は false", () => {
  assert.equal(isSameDomain("not a url", "https://example.com"), false);
});

test("isExcluded: いずれかの正規表現に一致したら true", () => {
  const patterns = [/\.pdf$/i, /\/wp-admin\//];
  assert.equal(isExcluded("https://x/doc.PDF", patterns), true);
  assert.equal(isExcluded("https://x/wp-admin/edit", patterns), true);
  assert.equal(isExcluded("https://x/page", patterns), false);
});

test("isExcluded: パターン未指定なら常に false", () => {
  assert.equal(isExcluded("https://x/page", undefined), false);
  assert.equal(isExcluded("https://x/page", []), false);
});

test("isCheckableHttpLink: http(s) の正常な URL のみ true", () => {
  assert.equal(isCheckableHttpLink("https://example.com/a"), true);
  assert.equal(isCheckableHttpLink("http://example.com"), true);
});

test("isCheckableHttpLink: 擬似リンク・非http スキームは false", () => {
  assert.equal(isCheckableHttpLink("javascript:void(0)"), false);
  assert.equal(isCheckableHttpLink("javascript:void(0);"), false);
  assert.equal(isCheckableHttpLink("mailto:a@example.com"), false);
  assert.equal(isCheckableHttpLink("tel:0312345678"), false);
  assert.equal(isCheckableHttpLink("#section"), false);
  assert.equal(isCheckableHttpLink("data:text/plain,hi"), false);
});

test("isCheckableHttpLink: 不正ホスト・パース不能は false", () => {
  assert.equal(isCheckableHttpLink("http://-/"), false);
  assert.equal(isCheckableHttpLink("not a url"), false);
  assert.equal(isCheckableHttpLink(""), false);
});

// RGBA バッファを作るヘルパー: width×height を fill 色で塗り、
// rows[y] に色指定があればその行を上書きする。色は [r,g,b]。
function makeRGBA(width, height, fill, rows = {}) {
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    const c = rows[y] ?? fill;
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      data[i] = c[0];
      data[i + 1] = c[1];
      data[i + 2] = c[2];
      data[i + 3] = 255;
    }
  }
  return data;
}

test("isUniformBlackBand: 全幅・純黒の帯を検出する", () => {
  const w = 10, h = 6;
  // y=4,5 を黒帯、それ以外は白
  const data = makeRGBA(w, h, [255, 255, 255], { 4: [0, 0, 0], 5: [0, 0, 0] });
  assert.equal(isUniformBlackBand(data, w, 4, 6), true);
});

test("isUniformBlackBand: 白い領域は黒帯ではない", () => {
  const w = 10, h = 6;
  const data = makeRGBA(w, h, [255, 255, 255]);
  assert.equal(isUniformBlackBand(data, w, 4, 6), false);
});

test("isUniformBlackBand: 実コンテンツ（非黒）が混じる帯は検出しない", () => {
  const w = 10, h = 6;
  // y=4 は黒だが y=5 は灰色（実コンテンツ相当）→ 純黒帯ではない
  const data = makeRGBA(w, h, [255, 255, 255], { 4: [0, 0, 0], 5: [120, 120, 120] });
  assert.equal(isUniformBlackBand(data, w, 4, 6), false);
});

test("isUniformBlackBand: ごく僅かなノイズは許容する（blackRatio 既定 0.999 未満で false）", () => {
  const w = 100, h = 2;
  const data = makeRGBA(w, h, [0, 0, 0]); // 200px 全黒
  data[0] = 255; // 1px だけ白に（黒率 199/200 = 0.995 < 0.999）
  assert.equal(isUniformBlackBand(data, w, 0, 2), false);
  // 閾値を緩めれば許容される
  assert.equal(isUniformBlackBand(data, w, 0, 2, { blackRatio: 0.99 }), true);
});

test("isUniformBlackBand: 空の範囲・不正な幅は false", () => {
  const data = makeRGBA(4, 4, [0, 0, 0]);
  assert.equal(isUniformBlackBand(data, 4, 2, 2), false); // yStart==yEnd
  assert.equal(isUniformBlackBand(data, 0, 0, 4), false); // width 0
});

test("escapeHtml: HTML 特殊文字をエスケープする", () => {
  assert.equal(
    escapeHtml(`<a href="x">A&B</a>`),
    "&lt;a href=&quot;x&quot;&gt;A&amp;B&lt;/a&gt;"
  );
});

test("toPercent: 比率を2桁パーセントにする", () => {
  assert.equal(toPercent(0), "0.00%");
  assert.equal(toPercent(0.1234), "12.34%");
  assert.equal(toPercent(1), "100.00%");
});

test("detectMissingScreenshot: after のスクショ欠落を検出する", () => {
  const before = { screenshot: "a.png" };
  const after = { screenshot: null, error: "スクショ失敗: disk full" };
  const r = detectMissingScreenshot(before, after);
  assert.equal(r.captureFailed, true);
  assert.match(r.captureNote, /after のスクショ無し/);
  assert.match(r.captureNote, /disk full/);
});

test("detectMissingScreenshot: 両方欠落も検出する", () => {
  const r = detectMissingScreenshot({ screenshot: null }, { screenshot: null });
  assert.equal(r.captureFailed, true);
  assert.match(r.captureNote, /before \/ after のスクショ無し/);
});

test("detectMissingScreenshot: 両方そろっていれば null", () => {
  assert.equal(
    detectMissingScreenshot({ screenshot: "a.png" }, { screenshot: "a.png" }),
    null
  );
});

test("detectMissingScreenshot: new/removed（片側のみ存在）は対象外で null", () => {
  assert.equal(detectMissingScreenshot(null, { screenshot: "a.png" }), null);
  assert.equal(detectMissingScreenshot({ screenshot: "a.png" }, null), null);
});

test("classifyVisualChange: 差分0pxは none", () => {
  assert.equal(classifyVisualChange({ numDiff: 0, diffRatio: 0 }, 0.01), "none");
});

test("classifyVisualChange: 1pxでも違えば最低 minor（取りこぼさない）", () => {
  // 8px=ほぼ0%でも閾値未満なら minor として一覧に出す
  assert.equal(classifyVisualChange({ numDiff: 8, diffRatio: 3.7e-6 }, 0.01), "minor");
  assert.equal(classifyVisualChange({ numDiff: 1, diffRatio: 1e-7 }, 0.01), "minor");
});

test("classifyVisualChange: 閾値超なら significant（強調対象）", () => {
  assert.equal(classifyVisualChange({ numDiff: 50000, diffRatio: 0.05 }, 0.01), "significant");
});

test("classifyVisualChange: 閾値ちょうどは significant ではない（超過のみ）", () => {
  assert.equal(classifyVisualChange({ numDiff: 100, diffRatio: 0.01 }, 0.01), "minor");
});

test("classifyVisualChange: 引数欠落時は既定値で none", () => {
  assert.equal(classifyVisualChange(), "none");
});
