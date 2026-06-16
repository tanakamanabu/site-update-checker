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
  escapeHtml,
  toPercent,
  detectMissingScreenshot,
} from "../src/util.js";

test("urlToFilename: スキームを落とし安全な文字に変換する", () => {
  assert.equal(
    urlToFilename("https://example.com/foo/bar?x=1#sec"),
    "example_com_foo_bar_x_1_sec"
  );
});

test("urlToFilename: 連続する _ は1つにまとめ、ハイフンは保持する", () => {
  assert.equal(urlToFilename("http://a.com//b__c"), "a_com_b_c");
  assert.equal(urlToFilename("http://a.com/b-c"), "a_com_b-c");
});

test("urlToFilename: 200文字に切り詰める", () => {
  const long = "https://example.com/" + "a".repeat(500);
  assert.equal(urlToFilename(long).length, 200);
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
