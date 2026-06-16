/**
 * target.js の対象解決・マージロジックのテスト。
 * 純粋関数 resolveTargetConfig を直接呼ぶので config.js は不要。
 *   node --test
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import path from "path";

import { resolveTargetConfig } from "../src/target.js";

const baseConfig = {
  concurrency: 2,
  timeout: 30000,
  diffThreshold: 0.01,
  viewport: { width: 1280, height: 900 },
  excludePatterns: [/\.pdf$/i],
  stayOnDomain: true,
  userAgent: "test-bot",
  reportDir: "./reports",
  targets: [
    { name: "alpha", baseUrl: "https://alpha.example.com" },
    { name: "beta", baseUrl: "https://beta.example.com", concurrency: 1 },
  ],
};

test("名前指定で該当する対象を選ぶ", () => {
  const r = resolveTargetConfig(baseConfig, "beta");
  assert.equal(r.name, "beta");
  assert.equal(r.baseUrl, "https://beta.example.com");
});

test("共通設定をマージし、対象側の上書きが優先される", () => {
  const r = resolveTargetConfig(baseConfig, "beta");
  assert.equal(r.timeout, 30000); // 共通から
  assert.equal(r.concurrency, 1); // beta が上書き
  assert.equal(r.userAgent, "test-bot");
});

test("reportDir は reports/<name> に解決される", () => {
  const r = resolveTargetConfig(baseConfig, "alpha");
  assert.equal(r.reportDir, path.join("./reports", "alpha"));
});

test("basicAuth はデフォルト null", () => {
  const r = resolveTargetConfig(baseConfig, "alpha");
  assert.equal(r.basicAuth, null);
});

test("対象が1つだけなら名前省略可", () => {
  const single = { ...baseConfig, targets: [baseConfig.targets[0]] };
  const r = resolveTargetConfig(single);
  assert.equal(r.name, "alpha");
});

test("対象が複数で名前未指定なら throw", () => {
  assert.throws(() => resolveTargetConfig(baseConfig), /対象名を指定/);
});

test("存在しない対象名は利用可能一覧つきで throw", () => {
  assert.throws(() => resolveTargetConfig(baseConfig, "zzz"), /利用可能: alpha, beta/);
});

test("targets が空なら throw", () => {
  assert.throws(() => resolveTargetConfig({ targets: [] }), /targets が定義/);
});

test("baseUrl 欠落なら throw", () => {
  const bad = { targets: [{ name: "nourl" }] };
  assert.throws(() => resolveTargetConfig(bad, "nourl"), /baseUrl が設定/);
});
