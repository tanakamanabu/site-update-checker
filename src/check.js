/**
 * check.js
 * after クロール → diff レポート生成 を対象名を引き継いで連続実行する。
 *
 * 使い方:
 *   node src/check.js [対象名]
 *   （npm 経由: npm run check -- <対象名>）
 */

import { spawnSync } from "child_process";

const targetArgs = process.argv.slice(2); // 対象名（あれば）
const opts = { stdio: "inherit" };

const after = spawnSync("node", ["src/crawl.js", "after", ...targetArgs], opts);
if (after.status !== 0) process.exit(after.status ?? 1);

const diff = spawnSync("node", ["src/diff.js", ...targetArgs], opts);
process.exit(diff.status ?? 1);
